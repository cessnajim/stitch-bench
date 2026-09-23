// Drives stitch-bench.html in headless Chrome and hands back results.
//
// The stitching itself lives in the page, not here: one implementation, exercised the same way
// whether a person opens the file or an agent calls a tool. This module owns the browser
// lifecycle, moves files in and pixels out, and translates page state into plain data.
import { launch } from 'puppeteer-core';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGE = resolve(HERE, '..', 'stitch-bench.html');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!hit) {
    throw new Error(
      'No Chrome or Chromium found. Install Google Chrome, or set CHROME_PATH to the browser ' +
      'binary — for example CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".'
    );
  }
  return hit;
}

const IDLE_MS = 5 * 60 * 1000;
let browser = null, page = null, idleTimer = null, busy = Promise.resolve();

async function open(onProgress) {
  if (page && !page.isClosed()) return page;
  onProgress?.(null, 'Starting the browser and loading the alignment engine…');
  browser = await launch({
    executablePath: findChrome(),
    headless: 'new',
    protocolTimeout: 30 * 60 * 1000,
    args: ['--js-flags=--max-old-space-size=8192', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  page.on('pageerror', e => console.error('[page]', e.message));
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('file://' + PAGE);
  // The page stitches its own sample on load, which also proves the alignment engine came up.
  await page.waitForFunction(() => document.getElementById('outInfo').textContent, { timeout: 180000 });
  return page;
}

export async function shutdown() {
  clearTimeout(idleTimer);
  if (browser) { const b = browser; browser = null; page = null; await b.close().catch(() => {}); }
}
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(), IDLE_MS);
}

// One page, so calls are serialised rather than interleaved.
function queue(fn) {
  const run = busy.then(fn, fn);
  busy = run.then(() => {}, () => {});
  return run;
}

function checkImages(images) {
  const missing = images.filter(p => !existsSync(p));
  if (missing.length) throw new Error(`These files do not exist: ${missing.join(', ')}`);
  // Chrome's file input accepts a directory without complaint and yields nothing, so the page would
  // sit at zero items until the ten-minute load timeout expired. Catch it here, where the message
  // can say what actually went wrong.
  const dirs = images.filter(p => statSync(p).isDirectory());
  if (dirs.length) {
    throw new Error(
      `These are directories, not image files: ${dirs.join(', ')}. The MCP tools expand a directory ` +
      `before reaching this point, so a directory here means one was passed straight to the stitcher.`
    );
  }
  return images.map(p => resolve(p));
}

async function loadImages(pg, images) {
  const input = await pg.$('#file');
  await input.uploadFile(...images);
  // The list is emptied before uploading, so a count is enough. Matching on file names would
  // deadlock on anything named like the built-in sample.
  await pg.waitForFunction(n => S.items.length === n, { timeout: 600000, polling: 500 }, images.length);
}

async function applyOptions(pg, opts) {
  await pg.evaluate(o => { Object.assign(S.opt, o); if (S.pano) S.pano.photoMode = null; }, opts);
}

async function alignAndReport(pg, onProgress) {
  await pg.evaluate(() => { S.mode = 'pano'; modeUI(); invalidatePano(); schedule(0); });
  // Poll rather than wait outright: aligning a large set takes minutes, and a caller left with no
  // word for that long will give up on the request.
  const started = Date.now();
  for (;;) {
    const state = await pg.evaluate(() => ({
      done: !S.panoBusy && !!(S.pano || S.panoErr),
      status: document.getElementById('status').textContent || '',
      bar: document.getElementById('prog').firstElementChild.style.width || '',
    }));
    if (state.done) break;
    if (Date.now() - started > 1800000) throw new Error('Alignment did not finish within 30 minutes.');
    onProgress?.(parseFloat(state.bar) || null, state.status || 'Aligning…');
    await new Promise(r => setTimeout(r, 1500));
  }
  return pg.evaluate(() => {
    if (S.panoErr) return { error: S.panoErr };
    const P = S.pano, names = new Map(S.items.map(i => [i.id, i.name]));
    const b = P.bbox;
    return {
      frames_total: S.items.length,
      frames_placed: P.placed.size,
      frames_unplaced: P.unplaced,
      anchor: names.get(P.refId) || null,
      links: P.links.map(l => ({ a: l.a, b: l.b, matches: l.matches, agreeing: l.inliers })),
      full_extent: { width: Math.round(b.x1 - b.x0), height: Math.round(b.y1 - b.y0) },
    };
  });
}

// Renders in the page, then streams the encoded bytes out in chunks — a data URL for a 150 MP
// export would be hundreds of megabytes of string otherwise.
async function renderToFile(pg, { panorama, scale, format, quality, output }) {
  const meta = await pg.evaluate(async (panorama, scale, format, quality) => {
    const res = panorama ? await renderPano(scale, false, () => {}) : await renderLayout(scale, false);
    let canvas = res.canvas;
    if (format === 'image/jpeg' && S.opt.transparent) {
      const flat = mkCanvas(canvas.width, canvas.height), fx = flat.getContext('2d');
      fx.fillStyle = '#ffffff'; fx.fillRect(0, 0, flat.width, flat.height);
      fx.drawImage(canvas, 0, 0); canvas = flat;
    }
    const blob = await new Promise(r => canvas.toBlob(r, format, quality));
    if (!blob) return { error: 'The browser could not encode an image that large. Try a smaller scale.' };
    window.__out = new Uint8Array(await blob.arrayBuffer());
    return {
      bytes: window.__out.length,
      width: canvas.width, height: canvas.height,
      painted_percent: +(res.painted || 0).toFixed(1),
      note: res.cropNote || null,
    };
  }, panorama, scale, format, quality);
  if (meta.error) throw new Error(meta.error);

  const CHUNK = 4 << 20, parts = [];
  for (let off = 0; off < meta.bytes; off += CHUNK) {
    const b64 = await pg.evaluate((off, len) => {
      let s = '';
      const view = window.__out.subarray(off, off + len);
      for (let i = 0; i < view.length; i += 8192) s += String.fromCharCode(...view.subarray(i, i + 8192));
      return btoa(s);
    }, off, CHUNK);
    parts.push(Buffer.from(b64, 'base64'));
  }
  await pg.evaluate(() => { delete window.__out; });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, Buffer.concat(parts));
  return meta;
}

async function previewImage(pg, panorama) {
  return pg.evaluate(async (panorama) => {
    const src = panorama ? S.view?.canvas : null;
    const res = src ? { canvas: src } : (panorama ? await renderPano(0.2, false, () => {}) : await renderLayout(0.2, false));
    const c = res.canvas, k = Math.min(1, Math.sqrt(1.2e6 / (c.width * c.height)));
    const t = mkCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.75).split(',')[1];
  }, panorama);
}

const photometry = pg => pg.evaluate(() => {
  const ph = S.pano?.photo;
  if (!ph || S.opt.exposure === 'off') return null;
  return {
    per_frame_change_percent: ph.summary.map(x => ({ name: x.name, percent: +x.pct.toFixed(1) })),
    shading: ph.shadeVerdict || 'not assessed',
    corner_falloff_percent: +(ph.falloff || 0).toFixed(1),
  };
});

export function stitchPanorama(args) {
  return queue(async () => {
    const t0 = Date.now();
    const images = checkImages(args.images);
    const pg = await open(args.onProgress);
    try {
      await pg.evaluate(() => { clearItems(); S.sample = false; itemsChanged(); });
      await loadImages(pg, images);
      await applyOptions(pg, {
        exposure: args.exposure, edges: args.edges, paint: args.paint_limit,
        model: args.motion, blend: args.seams, features: args.detail,
        transparent: args.edges === 'keep', bg: '#ffffff',
      });
      const report = await alignAndReport(pg, args.onProgress);
      if (report.error) throw new Error(report.error);
      if (report.frames_placed < 2) {
        throw new Error('None of the images share enough detail to align. Neighbouring shots need ' +
          'roughly 20–50% overlap, or try motion: "translation" for scans and screenshots.');
      }
      args.onProgress?.(null, 'Rendering and encoding…');
      const meta = await renderToFile(pg, {
        panorama: true, scale: args.scale, format: args.format, quality: args.quality, output: args.output,
      });
      const result = {
        output_path: args.output,
        width: meta.width, height: meta.height,
        megapixels: +(meta.width * meta.height / 1e6).toFixed(1),
        bytes: meta.bytes,
        painted_percent: meta.painted_percent,
        exposure: await photometry(pg),
        seconds: +((Date.now() - t0) / 1000).toFixed(1),
        ...report,
      };
      const preview = args.preview ? await previewImage(pg, true) : null;
      return { result, preview };
    } finally { touchIdle(); }
  });
}

export function inspectAlignment(args) {
  return queue(async () => {
    const images = checkImages(args.images);
    const pg = await open(args.onProgress);
    try {
      await pg.evaluate(() => { clearItems(); S.sample = false; itemsChanged(); });
      await loadImages(pg, images);
      await applyOptions(pg, { model: args.motion, features: args.detail, exposure: 'off' });
      const report = await alignAndReport(pg, args.onProgress);
      if (report.error) throw new Error(report.error);
      return { result: report };
    } finally { touchIdle(); }
  });
}

export function stitchLayout(args) {
  return queue(async () => {
    const t0 = Date.now();
    const images = checkImages(args.images);
    const pg = await open(args.onProgress);
    try {
      await pg.evaluate(() => { clearItems(); S.sample = false; itemsChanged(); });
      await loadImages(pg, images);
      await pg.evaluate((mode, o) => {
        S.mode = mode; modeUI(); Object.assign(S.opt, o);
      }, args.mode === 'column' ? 'col' : args.mode, {
        gap: args.gap, cols: args.columns, cellFit: args.cell_fit,
        match: args.match, align: args.align,
        bg: args.background, transparent: !!args.transparent,
      });
      args.onProgress?.(null, 'Rendering and encoding…');
      const meta = await renderToFile(pg, {
        panorama: false, scale: args.scale, format: args.format, quality: args.quality, output: args.output,
      });
      const result = {
        output_path: args.output, width: meta.width, height: meta.height,
        megapixels: +(meta.width * meta.height / 1e6).toFixed(1),
        bytes: meta.bytes, images: images.length,
        seconds: +((Date.now() - t0) / 1000).toFixed(1),
      };
      const preview = args.preview ? await previewImage(pg, false) : null;
      return { result, preview };
    } finally { touchIdle(); }
  });
}
