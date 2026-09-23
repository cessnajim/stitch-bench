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
    pass = ok('exposes its tools', names.join(',') === 'inspect_alignment,stitch_layout,stitch_panorama', names.join(', ')) && pass;
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
    const r = res.structuredContent || {};
    pass = ok('stitch_panorama writes the file', fs.existsSync(out) && fs.statSync(out).size > 10000,
      fs.existsSync(out) ? `${(fs.statSync(out).size / 1024).toFixed(0)} KB` : 'missing') && pass;
    pass = ok('reports what it produced', r.width > 2000 && r.frames_placed === 3 && r.megapixels > 1,
      `${r.width}x${r.height}, ${r.megapixels} MP, ${r.frames_placed}/3 frames`) && pass;
    pass = ok('reports the exposure work', !!r.exposure && Array.isArray(r.exposure.per_frame_change_percent),
      r.exposure ? `${r.exposure.per_frame_change_percent.length} frames adjusted, shading: ${r.exposure.shading}` : 'none') && pass;
    pass = ok('returns a preview image', (res.content || []).some(c => c.type === 'image'), '') && pass;

    const sheet = path.join(FIX, 'out', 'sheet.jpg');
    const lay = await client.callTool({ name: 'stitch_layout', arguments: { images, mode: 'grid', columns: 2, gap: 12, output: sheet } }, undefined, opts);
    pass = ok('stitch_layout writes a grid', fs.existsSync(sheet) && (lay.structuredContent || {}).images === 3,
      `${(lay.structuredContent || {}).width}x${(lay.structuredContent || {}).height}`) && pass;

    pass = ok('reports progress while working', seen.length > 0, `${seen.length} updates`) && pass;
    const bad = await client.callTool({ name: 'stitch_panorama', arguments: { images: [path.join(FIX, 'nope-a.jpg'), path.join(FIX, 'nope-b.jpg')] } }, undefined, opts);
    const msg = (bad.content || []).map(c => c.text || '').join(' ');
    pass = ok('missing files fail with a useful message', bad.isError === true && /do not exist/.test(msg), msg.slice(0, 60)) && pass;
  } finally {
    await client.close().catch(() => {});
  }
  return pass;
};
