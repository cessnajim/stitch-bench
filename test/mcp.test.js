'use strict';
// Exercises the MCP server the way a client does: over stdio, through the SDK, on real files.
// Fixtures are generated from the page's own sample scene so the suite needs no bundled photos.
const fs = require('fs'), path = require('path');
const { open, ok } = require('./lib');

const FIX = path.resolve(__dirname, 'fixtures');

async function makeFixtures() {
  if (fs.existsSync(path.join(FIX, 'frame-left.jpg'))) return;
  fs.mkdirSync(FIX, { recursive: true });
  const { browser, page } = await open();
  try {
    const files = await page.evaluate(async () => {
      const out = [];
      for (const it of S.items) {
        const c = mkCanvas(it.w, it.h);
        c.getContext('2d').drawImage(await getFull(it), 0, 0);
        out.push({ name: it.name, data: c.toDataURL('image/jpeg', 0.92).split(',')[1] });
      }
      return out;
    });
    // Deliberately not named "sample-*": the page reserves that prefix for its own example set,
    // and naming fixtures that way once deadlocked the driver's wait-for-load.
    for (const f of files) {
      fs.writeFileSync(path.join(FIX, f.name.replace(/^sample-/, 'frame-')), Buffer.from(f.data, 'base64'));
    }
  } finally { await browser.close(); }
}

module.exports = async function run() {
  let pass = true;
  await makeFixtures();
  const images = ['frame-left.jpg', 'frame-middle.jpg', 'frame-right.jpg'].map(f => path.join(FIX, f));

  let Client, StdioClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
  } catch {
    console.log('  SKIP  MCP server (run: cd mcp && npm install)');
    return true;
  }

  const client = new Client({ name: 'stitch-bench-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '..', 'mcp', 'server.js')],
    stderr: 'ignore',
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    pass = ok('exposes its tools', names.join(',') === 'find_bursts,inspect_alignment,stitch_layout,stitch_panorama', names.join(', ')) && pass;
    pass = ok('every tool is described', tools.every(t => (t.description || '').length > 80 && t.inputSchema), '') && pass;

    // Long-running by nature: ask for progress and allow for it, as a real client should.
    const seen = [];
    const opts = { timeout: 600000, onprogress: p => seen.push(p) };
    const look = await client.callTool({ name: 'inspect_alignment', arguments: { images } }, undefined, opts);
    const report = look.structuredContent || {};
    pass = ok('inspect_alignment finds the overlaps', report.frames_placed === 3, `${report.frames_placed}/3 placed, ${(report.links || []).length} links`) && pass;
    pass = ok('inspect_alignment writes nothing', fs.readdirSync(FIX).filter(f => f.startsWith('panorama-')).length === 0, '') && pass;

    const out = path.join(FIX, 'out', 'pano.jpg');
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    const res = await client.callTool({ name: 'stitch_panorama', arguments: { images, output: out, preview: true } }, undefined, opts);
    const top = res.structuredContent || {};
    const r = (top.panoramas || [])[0] || {};
    pass = ok('stitch_panorama writes the file', fs.existsSync(out) && fs.statSync(out).size > 10000,
      fs.existsSync(out) ? `${(fs.statSync(out).size / 1024).toFixed(0)} KB` : 'missing') && pass;
    // An explicit list of files is one panorama, and is not collected into a folder: naming the
    // files is the caller saying they have already done the grouping.
    pass = ok('an explicit list stays one ungrouped panorama',
      top.count === 1 && top.grouped_by_burst === false && r.directory === null,
      `count ${top.count}, grouped ${top.grouped_by_burst}`) && pass;
    pass = ok('reports what it produced', r.width > 2000 && r.frames_placed === 3 && r.megapixels > 1,
      `${r.width}x${r.height}, ${r.megapixels} MP, ${r.frames_placed}/3 frames`) && pass;
    pass = ok('reports the exposure work', !!r.exposure && Array.isArray(r.exposure.per_frame_change_percent),
      r.exposure ? `${r.exposure.per_frame_change_percent.length} frames adjusted, shading: ${r.exposure.shading}` : 'none') && pass;
    pass = ok('returns a preview image', (res.content || []).some(c => c.type === 'image'), '') && pass;

    // A folder, as a camera leaves it: no explicit list, no output path, capture times a few
    // seconds apart. This is the path an agent takes when it is simply pointed at a directory.
    const burstDir = path.join(FIX, 'burst-src');
    fs.rmSync(burstDir, { recursive: true, force: true });
    fs.mkdirSync(burstDir, { recursive: true });
    images.forEach((src, i) => {
      const dst = path.join(burstDir, path.basename(src));
      fs.copyFileSync(src, dst);
      const when = new Date(Date.parse('2026-04-11T09:00:00') + i * 4000);
      fs.utimesSync(dst, when, when);
    });

    const found = await client.callTool({ name: 'find_bursts', arguments: { images: [burstDir] } }, undefined, opts);
    const fb = found.structuredContent || {};
    pass = ok('find_bursts groups a folder into one sweep',
      (fb.bursts || []).length === 1 && fb.bursts[0].frames === 3,
      `${(fb.bursts || []).length} burst(s), ${fb.files_found} files, times from ${fb.time_source}`) && pass;
    pass = ok('find_bursts writes nothing and opens no browser',
      fs.readdirSync(burstDir).length === 3, `${fs.readdirSync(burstDir).length} files left`) && pass;

    const grouped = await client.callTool({ name: 'stitch_panorama', arguments: { images: [burstDir], scale: 0.5 } }, undefined, opts);
    const g = grouped.structuredContent || {};
    const cell = path.join(burstDir, 'burst-01');
    pass = ok('a directory stitches each burst it finds',
      g.count === 1 && g.grouped_by_burst === true, `count ${g.count}, grouped ${g.grouped_by_burst}`) && pass;
    pass = ok('the burst gets its own folder with the panorama in it',
      fs.existsSync(path.join(cell, 'panorama.jpg')), fs.existsSync(cell) ? fs.readdirSync(cell).join(',') : 'no folder') && pass;
    pass = ok('the frames that made it are copied in beside it',
      images.every(f => fs.existsSync(path.join(cell, path.basename(f)))), '') && pass;
    pass = ok('the originals are left where they were',
      images.every(f => fs.existsSync(path.join(burstDir, path.basename(f)))), '') && pass;
    pass = ok('and the folder is reported back',
      (g.panoramas || [])[0]?.directory === cell, (g.panoramas || [])[0]?.directory || 'none') && pass;

    // Running it twice must not fold the first panorama into the second.
    const again = await client.callTool({ name: 'find_bursts', arguments: { images: [burstDir], recursive: true } }, undefined, opts);
    pass = ok('a second pass ignores what the first one wrote',
      (again.structuredContent || {}).files_found === 3, `${(again.structuredContent || {}).files_found} files found`) && pass;

    const sheet = path.join(FIX, 'out', 'sheet.jpg');
    const lay = await client.callTool({ name: 'stitch_layout', arguments: { images, mode: 'grid', columns: 2, gap: 12, output: sheet } }, undefined, opts);
    pass = ok('stitch_layout writes a grid', fs.existsSync(sheet) && (lay.structuredContent || {}).images === 3,
      `${(lay.structuredContent || {}).width}x${(lay.structuredContent || {}).height}`) && pass;

    pass = ok('reports progress while working', seen.length > 0, `${seen.length} updates`) && pass;

    // A file the browser cannot decode must be named and stepped over. Before this was handled,
    // every such file was simply never accounted for and the driver waited out its ten-minute
    // timeout, so the guard here is as much about finishing promptly as about the message.
    const undecodable = path.join(FIX, 'not-really.jpg');
    fs.writeFileSync(undecodable, Buffer.from('this is text, not a JPEG', 'latin1'));
    const started = Date.now();
    const mixedIn = await client.callTool(
      { name: 'inspect_alignment', arguments: { images: [undecodable, ...images] } }, undefined, opts);
    const mi = mixedIn.structuredContent || {};
    const took = (Date.now() - started) / 1000;
    pass = ok('an undecodable file does not stall the load', took < 120, `${took.toFixed(1)}s`) && pass;
    pass = ok('the readable frames are still aligned', mi.frames_placed === 3,
      `${mi.frames_placed}/3 placed`) && pass;
    pass = ok('and the one that failed is named, with a reason and the path it came from',
      (mi.unreadable || []).length === 1 && mi.unreadable[0].name === 'not-really.jpg'
        && !!mi.unreadable[0].reason && mi.unreadable[0].path === undecodable,
      JSON.stringify(mi.unreadable)) && pass;
    fs.rmSync(undecodable, { force: true });

    // An output path is easy for a caller to get wrong, and a wrong one points at a photograph.
    const precious = path.join(FIX, 'out', 'already-here.jpg');
    fs.mkdirSync(path.dirname(precious), { recursive: true });
    fs.writeFileSync(precious, 'not a panorama');
    const refused = await client.callTool(
      { name: 'stitch_panorama', arguments: { images, output: precious } }, undefined, opts);
    pass = ok('an existing file this tool did not write is not overwritten',
      refused.isError === true && fs.readFileSync(precious, 'latin1') === 'not a panorama',
      (refused.content || []).map(c => c.text || '').join(' ').slice(0, 70)) && pass;
    // The case a prefix check waved through: a photograph whose name happens to start the way
    // this tool's output does.
    const lookalike = path.join(FIX, 'out', 'panorama-of-the-bay.jpg');
    fs.writeFileSync(lookalike, 'a photograph');
    const spared = await client.callTool(
      { name: 'stitch_panorama', arguments: { images, output: lookalike } }, undefined, opts);
    pass = ok('a photograph named like our output is not overwritten either',
      spared.isError === true && fs.readFileSync(lookalike, 'latin1') === 'a photograph', '') && pass;
    const forced = await client.callTool(
      { name: 'stitch_panorama', arguments: { images, output: precious, overwrite: true, scale: 0.4 } }, undefined, opts);
    pass = ok('and is replaced when the caller says so',
      !forced.isError && fs.statSync(precious).size > 10000,
      `${(fs.statSync(precious).size / 1024).toFixed(0)} KB`) && pass;
    // Re-running a folder replaces the panorama it wrote last time, without being asked twice.
    const rerun = await client.callTool(
      { name: 'stitch_panorama', arguments: { images: [burstDir], scale: 0.4 } }, undefined, opts);
    pass = ok('but our own result is replaced on a re-run without asking',
      !rerun.isError, (rerun.content || []).map(c => c.text || '').join(' ').slice(0, 70)) && pass;
    const bad = await client.callTool({ name: 'stitch_panorama', arguments: { images: [path.join(FIX, 'nope-a.jpg'), path.join(FIX, 'nope-b.jpg')] } }, undefined, opts);
    const msg = (bad.content || []).map(c => c.text || '').join(' ');
    // A folder shot RAW+JPEG with one file that will not open. The RAW is set aside and said so;
    // the bad file is stepped over and named; and the collected folder holds only what went in.
    const messy = path.join(FIX, 'burst-messy');
    fs.rmSync(messy, { recursive: true, force: true });
    fs.mkdirSync(messy, { recursive: true });
    const touch = (f, i) => { const t = new Date(Date.parse('2026-04-11T11:00:00') + i * 3000); fs.utimesSync(f, t, t); };
    images.forEach((src, i) => { const d = path.join(messy, path.basename(src)); fs.copyFileSync(src, d); touch(d, i); });
    const rawTwin = path.join(messy, path.basename(images[0]).replace(/\.jpg$/i, '.NEF'));
    fs.copyFileSync(images[0], rawTwin); touch(rawTwin, 0);
    const broken = path.join(messy, 'broken.jpg');
    fs.writeFileSync(broken, 'not a picture'); touch(broken, 1);
    const tidy = await client.callTool({ name: 'stitch_panorama', arguments: { images: [messy], scale: 0.4 } }, undefined, opts);
    const tm = tidy.structuredContent || {}, tp = (tm.panoramas || [])[0] || {};
    pass = ok('stitch_panorama says which RAW it set aside',
      (tm.raw_paired_with_jpeg || []).length === 1 && tm.raw_paired_with_jpeg[0] === rawTwin,
      JSON.stringify(tm.raw_paired_with_jpeg)) && pass;
    pass = ok('and names the file it could not read',
      (tp.unreadable || []).length === 1 && tp.unreadable[0].path === broken, JSON.stringify(tp.unreadable)) && pass;
    const inFolder = fs.existsSync(path.join(messy, 'burst-01')) ? fs.readdirSync(path.join(messy, 'burst-01')) : [];
    pass = ok('the collected folder holds only the frames that went in',
      !inFolder.includes('broken.jpg') && images.every(f => inFolder.includes(path.basename(f)))
        && (tp.source_files || []).length === images.length,
      inFolder.join(',')) && pass;
    fs.rmSync(messy, { recursive: true, force: true });

    pass = ok('missing files fail with a useful message', bad.isError === true && /do not exist/.test(msg), msg.slice(0, 60)) && pass;
  } finally {
    await client.close().catch(() => {});
  }
  return pass;
};
