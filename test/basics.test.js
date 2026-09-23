'use strict';
// The tool opens working, every layout mode renders, and export produces a real file.
const { open, ok } = require('./lib');

module.exports = async function run() {
  const { browser, page, errors } = await open();
  let pass = true;
  try {
    const first = await page.evaluate(() => ({
      items: S.items.length, placed: S.pano ? S.pano.placed.size : 0,
      out: document.getElementById('outInfo').textContent,
    }));
    pass = ok('opens on a stitched sample', first.items === 3 && first.placed === 3, first.out) && pass;

    for (const mode of ['row', 'col', 'grid', 'free']) {
      const r = await page.evaluate(async m => {
        S.mode = m; modeUI();
        const res = await renderLayout(1, false);
        return { w: res.canvas.width, h: res.canvas.height };
      }, mode);
      pass = ok(`${mode} layout renders`, r.w > 100 && r.h > 100, `${r.w}x${r.h}`) && pass;
    }

    const exp = await page.evaluate(async () => {
      S.mode = 'pano'; modeUI();
      const res = await renderPano(0.5, false);
      const blob = await new Promise(z => res.canvas.toBlob(z, 'image/jpeg', 0.9));
      return { bytes: blob ? blob.size : 0, w: res.canvas.width };
    });
    pass = ok('exports an encoded image', exp.bytes > 20000, `${(exp.bytes / 1024).toFixed(0)} KB`) && pass;

    // the app must reach the network for exactly one thing: the OpenCV build
    const hosts = await page.evaluate(() =>
      performance.getEntriesByType('resource').map(r => new URL(r.name).host).filter(h => h));
    const unexpected = [...new Set(hosts)].filter(h => h !== 'cdn.jsdelivr.net');
    pass = ok('no unexpected network traffic', unexpected.length === 0, unexpected.join(', ')) && pass;
    pass = ok('no page errors', errors.length === 0, errors[0] || '') && pass;
  } finally { await browser.close(); }
  return pass;
};
