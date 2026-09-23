'use strict';
// Optional: point STITCH_TEST_DIR at a folder of overlapping photos. Measures how evenly the sky
// reads across the stitch — featureless sky is where exposure mismatch shows first.
const fs = require('fs'), path = require('path');
const { open, addFiles, ok } = require('./lib');

module.exports = async function run() {
  const dir = process.env.STITCH_TEST_DIR;
  if (!dir || !fs.existsSync(dir)) {
    console.log('  SKIP  real-image checks (set STITCH_TEST_DIR to a folder of overlapping photos)');
    return true;
  }
  const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp|nef|cr2|arw|dng)$/i.test(f))
    .map(f => path.join(dir, f)).sort();
  if (files.length < 3) { console.log('  SKIP  real-image checks (need 3+ images)'); return true; }

  const { browser, page, errors } = await open();
  let pass = true;
  try {
    const info = await addFiles(page, files);
    pass = ok(`aligns ${files.length} real frames`, info.placed >= files.length - 1,
      `${info.placed}/${info.items} placed, ${info.links} links`) && pass;
    if (!info.placed) return pass;

    const m = await page.evaluate(async () => {
      const bb = S.pano.bbox;
      const k = Math.min(1, Math.sqrt(30e6 / ((bb.x1 - bb.x0) * (bb.y1 - bb.y0))));
      const out = {};
      // one flat-sky mask from the uncorrected render, so both modes are judged on the same pixels
      S.opt.exposure = 'off'; S.opt.edges = 'crop'; S.pano.photoMode = null;
      const base = await renderPano(k, false), bc = base.canvas, BW = bc.width;
      const top = Math.round(bc.height * 0.3);
      const bd = bc.getContext('2d').getImageData(0, 0, BW, top).data;
      const lum = new Float32Array(BW * top);
      for (let i = 0; i < BW * top; i++) lum[i] = bd[i * 4 + 3] ? (bd[i * 4] + bd[i * 4 + 1] + bd[i * 4 + 2]) / 3 : -1;
      const mask = new Uint8Array(BW * top);
      let skyPixels = 0;
      for (let y = 6; y < top - 6; y++) for (let x = 6; x < BW - 6; x++) {
        let mn = 999, mx = -999, good = true;
        for (let dy = -5; dy <= 5 && good; dy += 5) for (let dx = -5; dx <= 5; dx += 5) {
          const v = lum[(y + dy) * BW + x + dx];
          if (v < 0) { good = false; break; }
          mn = Math.min(mn, v); mx = Math.max(mx, v);
        }
        if (good && mx - mn < 2.5 && lum[y * BW + x] > 90) { mask[y * BW + x] = 1; skyPixels++; }
      }
      out.skyPixels = skyPixels;
      for (const mode of ['off', 'full']) {
        S.opt.exposure = mode; S.pano.photoMode = null;
        const res = await renderPano(k, false), c = res.canvas;
        const band = c.getContext('2d').getImageData(0, 0, c.width, top).data, prof = [];
        for (let x = 0; x < c.width; x++) {
          const v = [];
          for (let y = 0; y < top; y++) {
            if (!mask[y * BW + x]) continue;
            const i = (y * c.width + x) * 4; v.push((band[i] + band[i + 1] + band[i + 2]) / 3);
          }
          if (v.length >= 40) { v.sort((a, b) => a - b); prof.push(v[v.length >> 1]); }
        }
        let ripple = 0;
        for (let i = 200; i < prof.length; i++) ripple = Math.max(ripple, Math.abs(prof[i] - prof[i - 200]));
        out[mode] = { ripple: +ripple.toFixed(1), mean: +(prof.reduce((s, v) => s + v, 0) / prof.length).toFixed(1) };
      }
      return out;
    });

    if (m.skyPixels < 50000) {
      console.log(`  SKIP  sky measurements (only ${m.skyPixels} flat pixels found)`);
    } else {
      // Reported, not asserted. Wander is an absolute measure, so anything that darkens the whole
      // panorama improves it for free — it flattered a genuinely broken build during development
      // until the numbers were checked against the pixels. Brightness preservation below is the
      // check with teeth; treat wander as a number to look at, alongside the image itself.
      console.log(`  INFO  sky wander ${m.off.ripple} -> ${m.full.ripple} levels ` +
        `(${(m.off.ripple / m.off.mean * 100).toFixed(1)}% -> ${(m.full.ripple / m.full.mean * 100).toFixed(1)}% of mean), ` +
        `${(m.skyPixels / 1e6).toFixed(1)}M flat sky pixels`);
      pass = ok('overall brightness preserved', Math.abs(m.full.mean - m.off.mean) / m.off.mean < 0.15,
        `mean ${m.off.mean} -> ${m.full.mean}`) && pass;
    }
    pass = ok('no page errors', errors.length === 0, errors[0] || '') && pass;
  } finally { await browser.close(); }
  return pass;
};
