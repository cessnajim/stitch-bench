'use strict';
// Ground truth: build a scene, cut overlapping frames from it, damage them in known ways, stitch,
// and compare the result against the scene it came from. No external images needed.
const { open, ok } = require('./lib');

module.exports = async function run() {
  const { browser, page, errors } = await open();
  let pass = true;
  try {
    const r = await page.evaluate(async () => {
      const W = 2400, H = 700, src = mkCanvas(W, H), g = src.getContext('2d'), rnd = rng(11);
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#4a76ad'); sky.addColorStop(1, '#e8c49b');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `hsl(${rnd() * 360},${30 + rnd() * 50}%,${25 + rnd() * 55}%)`;
        g.fillRect(rnd() * W, rnd() * H, 6 + rnd() * 40, 6 + rnd() * 40);
      }
      const exposure = (x, n, w, h) => {
        const f = [0, 0.12, -0.08][n]; if (!f) return;
        x.fillStyle = f > 0 ? `rgba(255,255,255,${f})` : `rgba(0,0,0,${-f})`;
        x.fillRect(0, 0, w, h);
      };
      const vignette = (x, n, w, h) => {
        exposure(x, n, w, h);
        x.globalCompositeOperation = 'multiply';
        const rg = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
        rg.addColorStop(0, '#fff'); rg.addColorStop(0.6, '#dadada'); rg.addColorStop(1, '#858585');
        x.fillStyle = rg; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'source-over';
      };
      const run = async damage => {
        const items = [];
        for (const [n, x0] of [[0, 0], [1, 700], [2, 1400]]) {
          const c = mkCanvas(1000, 700), x = c.getContext('2d');
          x.drawImage(src, x0, 0, 1000, 700, 0, 0, 1000, 700);
          damage(x, n, 1000, 700);
          const blob = await new Promise(z => c.toBlob(z, 'image/png'));
          items.push(makeItem('f' + n + '.png', await createImageBitmap(c), blob));
        }
        S.items = items; S.opt.model = 'translation'; invalidatePano(); await alignPano();
        const out = { placed: S.pano ? S.pano.placed.size : 0 };
        for (const mode of ['off', 'full']) {
          S.opt.exposure = mode; S.opt.edges = 'keep'; S.opt.transparent = true; S.pano.photoMode = null;
          const res = await renderPano(1, false), rc = res.canvas;
          const w = Math.min(rc.width, 2400), h = Math.min(rc.height, 700);
          const A = rc.getContext('2d').getImageData(0, 0, w, h).data;
          const B = g.getImageData(0, 0, w, h).data;
          // global brightness must be preserved: only differences between frames get corrected
          let sa = 0, sb = 0, n = 0;
          for (let i = 0; i < w * h; i += 7) {
            const j = i * 4; if (!A[j + 3]) continue;
            sa += A[j] + A[j + 1] + A[j + 2]; sb += B[j] + B[j + 1] + B[j + 2]; n++;
          }
          const drift = (sa / n) / (sb / n) - 1;
          // low-frequency error: 16x16 block means, after removing one global gain
          const gain = sb / sa, bs = 16, bw = Math.floor(w / bs), bh = Math.floor(h / bs), err = [];
          for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
            let da = 0, db = 0, c = 0;
            for (let y = 0; y < bs; y += 2) for (let x = 0; x < bs; x += 2) {
              const j = ((by * bs + y) * w + bx * bs + x) * 4; if (!A[j + 3]) continue;
              da += (A[j] + A[j + 1] + A[j + 2]) / 3; db += (B[j] + B[j + 1] + B[j + 2]) / 3; c++;
            }
            if (c > 20) err.push(da / c * gain - db / c);
          }
          const mean = err.reduce((s, v) => s + v, 0) / err.length;
          const dev = err.map(v => v - mean);
          out[mode] = {
            rms: +Math.sqrt(dev.reduce((s, v) => s + v * v, 0) / dev.length).toFixed(2),
            worst: +Math.max(...dev.map(Math.abs)).toFixed(1),
            drift: +(drift * 100).toFixed(1),
          };
        }
        return out;
      };
      return { exposureOnly: await run(exposure), exposurePlusVignette: await run(vignette) };
    });

    const e = r.exposureOnly, v = r.exposurePlusVignette;
    pass = ok('all frames placed', e.placed === 3 && v.placed === 3, `${e.placed}/3, ${v.placed}/3`) && pass;
    pass = ok('exposure differences corrected', e.full.rms < 3.5,
      `rms ${e.off.rms} -> ${e.full.rms}`) && pass;
    pass = ok('exposure + vignetting corrected', v.full.rms < 7,
      `rms ${v.off.rms} -> ${v.full.rms}`) && pass;
    pass = ok('correction beats doing nothing', e.full.rms < e.off.rms && v.full.rms < v.off.rms * 0.6,
      `${e.off.rms}->${e.full.rms}, ${v.off.rms}->${v.full.rms}`) && pass;
    // Regression guard: the solver's global degree of freedom once dragged the whole set ~45% dark.
    // Exposure-only input must come back at the original brightness. With vignetting a few percent
    // is expected and intended: brightness is anchored to the frame centres, so whatever falloff
    // the centres themselves carry is preserved rather than guessed away.
    pass = ok('no global brightness drift', Math.abs(e.full.drift) < 4,
      `exposure-only ${e.full.drift}%`) && pass;
    pass = ok('vignette case stays near the centre exposure', Math.abs(v.full.drift) < 9,
      `${v.full.drift}% (centre falloff preserved by design)`) && pass;
    pass = ok('no page errors', errors.length === 0, errors[0] || '') && pass;
  } finally { await browser.close(); }
  return pass;
};
