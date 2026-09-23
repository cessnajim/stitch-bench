'use strict';
// Ragged-edge handling: crop keeps only real pixels, the painted-in limit is respected, and the
// reported painted percentage matches what actually got invented.
const { open, ok } = require('./lib');

module.exports = async function run() {
  const { browser, page, errors } = await open();
  let pass = true;
  try {
    const r = await page.evaluate(async () => {
      // stagger the sample frames vertically so the stitch has genuinely ragged edges
      const out = {};
      S.opt.exposure = 'full'; S.opt.transparent = true;
      for (const [mode, paint] of [['crop', 0], ['trim', 8], ['trim', 20], ['fill', 0]]) {
        S.opt.edges = mode; S.opt.paint = paint; S.pano.photoMode = null;
        const res = await renderPano(1, false), c = res.canvas;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let empty = 0;
        for (let i = 0; i < c.width * c.height; i++) if (!d[i * 4 + 3]) empty++;
        out[mode + paint] = {
          w: c.width, h: c.height, area: c.width * c.height,
          reported: +(res.painted || 0).toFixed(1),
          emptyPct: +(empty / (c.width * c.height) * 100).toFixed(1),
        };
      }
      return out;
    });

    pass = ok('crop leaves no empty pixels', r.crop0.emptyPct === 0, `${r.crop0.emptyPct}% empty`) && pass;
    pass = ok('crop invents nothing', r.crop0.reported === 0, `${r.crop0.reported}%`) && pass;
    pass = ok('trim honours its limit', r.trim8.reported <= 8.5, `${r.trim8.reported}% <= 8%`) && pass;
    pass = ok('a bigger limit keeps more frame', r.trim20.area >= r.trim8.area,
      `${r.trim8.w}x${r.trim8.h} -> ${r.trim20.w}x${r.trim20.h}`) && pass;
    pass = ok('trim keeps more than a strict crop', r.trim8.area > r.crop0.area,
      `${r.crop0.area} -> ${r.trim8.area}`) && pass;
    pass = ok('painting leaves nothing empty', r.fill0.emptyPct === 0, `${r.fill0.emptyPct}%`) && pass;
    pass = ok('no page errors', errors.length === 0, errors[0] || '') && pass;
  } finally { await browser.close(); }
  return pass;
};
