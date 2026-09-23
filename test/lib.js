'use strict';
// Shared harness: drives the real page in headless Chrome and reads measurements back out of it.
const p = require('puppeteer-core');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 'file://' + path.resolve(__dirname, '..', 'stitch-bench.html');

async function open({ timeout = 120000 } = {}) {
  const browser = await p.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 1800000,
    args: ['--js-flags=--max-old-space-size=8192', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(PAGE);
  // the page loads its sample set and stitches it, which also proves OpenCV came up
  await page.waitForFunction(() => document.getElementById('outInfo').textContent, { timeout });
  return { browser, page, errors };
}

// Load real files through the file input and wait for alignment to settle.
async function addFiles(page, files, { timeout = 1800000 } = {}) {
  const input = await page.$('#file');
  await input.uploadFile(...files);
  await page.waitForFunction(n => S.items.length === n && S.items.every(i => !i.name.startsWith('sample-')),
    { timeout, polling: 1000 }, files.length);
  await page.waitForFunction(() => !S.panoBusy && (S.pano || S.panoErr), { timeout, polling: 1000 });
  return page.evaluate(() => ({
    items: S.items.length,
    placed: S.pano ? S.pano.placed.size : 0,
    error: S.panoErr || null,
    links: S.pano ? S.pano.links.length : 0,
  }));
}

const ok = (name, pass, detail) => {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return pass;
};

module.exports = { open, addFiles, ok, PAGE };
