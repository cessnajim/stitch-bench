'use strict';
const suites = [
  ['basics', require('./basics.test.js')],
  ['synthetic exposure + vignette', require('./synthetic.test.js')],
  ['ragged edges', require('./edges.test.js')],
  ['real images', require('./real.test.js')],
  ['mcp server', require('./mcp.test.js')],
];
(async () => {
  let allPass = true;
  for (const [name, run] of suites) {
    console.log('\n' + name);
    const t = Date.now();
    try { allPass = await run() && allPass; }
    catch (e) { console.log('  ERROR ', e.message); allPass = false; }
    console.log(`  (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  }
  console.log('\n' + (allPass ? 'all suites passed' : 'FAILURES — see above'));
  process.exit(allPass ? 0 : 1);
})();
