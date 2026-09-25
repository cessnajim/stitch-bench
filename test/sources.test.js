'use strict';
// Directory expansion, capture times and burst grouping. No browser: this is the tight loop for
// the part that decides *which* frames get stitched, and it should stay fast enough to run on
// every edit.
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const { ok } = require('./lib');

const SRC = pathToFileURL(path.resolve(__dirname, '..', 'mcp', 'sources.js')).href;

// A real JPEG with an Exif APP1 segment spliced in after the SOI marker, so the parser is exercised
// on the two-hop path a camera actually writes: IFD0 points at the Exif IFD, which holds
// DateTimeOriginal.
function withExif(jpeg, when) {
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(0x2a, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                                     // IFD0: one entry
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12);    // ExifIFDPointer, type LONG
  tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);                                    // no IFD1
  tiff.writeUInt16LE(1, 26);                                    // Exif IFD: one entry
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30);    // DateTimeOriginal, type ASCII
  tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  tiff.write(when + '\0', 44, 'latin1');

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)]);
}

const stamp = (d, mins, secs) =>
  `2026:04:11 ${String(9 + Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

module.exports = async function run() {
  let pass = true;
  const { expandSources, captureTime, timedEntries, groupBursts, describeBurst, isOurOutput } = await import(SRC);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-sources-'));
  const seed = path.resolve(__dirname, 'fixtures', 'frame-left.jpg');
  const jpeg = fs.existsSync(seed) ? fs.readFileSync(seed) : Buffer.from('ffd8ffd9', 'hex');

  try {
    // A folder as a camera leaves it, plus the debris a second run would otherwise pick up.
    fs.writeFileSync(path.join(root, 'a.jpg'), withExif(jpeg, stamp(0, 0, 0)));
    fs.writeFileSync(path.join(root, 'b.jpg'), withExif(jpeg, stamp(0, 0, 4)));
    fs.writeFileSync(path.join(root, 'c.jpg'), withExif(jpeg, stamp(0, 0, 9)));
    fs.writeFileSync(path.join(root, 'd.jpg'), withExif(jpeg, stamp(0, 8, 0)));   // 8 min later
    fs.writeFileSync(path.join(root, 'e.jpg'), withExif(jpeg, stamp(0, 8, 3)));
    fs.writeFileSync(path.join(root, 'f.jpg'), withExif(jpeg, stamp(0, 8, 7)));
    fs.writeFileSync(path.join(root, 'lonely.jpg'), withExif(jpeg, stamp(0, 30, 0)));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not a picture');
    fs.writeFileSync(path.join(root, '.hidden.jpg'), jpeg);
    fs.writeFileSync(path.join(root, 'panorama-20260411-09.jpg'), jpeg);
    fs.writeFileSync(path.join(root, 'panorama.jpg'), jpeg);
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'deep.jpg'), withExif(jpeg, stamp(0, 0, 2)));
    fs.mkdirSync(path.join(root, 'burst-01'));
    fs.writeFileSync(path.join(root, 'burst-01', 'a.jpg'), jpeg);

    const flat = await expandSources([root]);
    const names = flat.files.map(f => path.basename(f)).sort();
    pass = ok('a directory expands to its images',
      names.join(',') === 'a.jpg,b.jpg,c.jpg,d.jpg,e.jpg,f.jpg,lonely.jpg', names.join(',')) && pass;
    pass = ok('skips non-images, hidden files and its own output',
      !names.some(n => /txt|hidden|panorama/.test(n)), '') && pass;
    pass = ok('reports that a directory was named', flat.sawDirectory === true, '') && pass;

    const deep = await expandSources([root], { recursive: true });
    const deepNames = deep.files.map(f => path.basename(f));
    pass = ok('recursive reaches subdirectories', deepNames.includes('deep.jpg'), `${deepNames.length} files`) && pass;
    pass = ok('recursive skips folders it collected earlier',
      !deep.files.some(f => f.includes(`${path.sep}burst-01${path.sep}`)), '') && pass;

    const mixed = await expandSources([path.join(root, 'a.jpg'), path.join(root, 'b.jpg')]);
    pass = ok('an explicit list is left alone',
      mixed.files.length === 2 && mixed.sawDirectory === false, '') && pass;

    let msg = '';
    try { await expandSources([path.join(root, 'nope.jpg')]); }
    catch (e) { msg = e.message; }
    pass = ok('a missing path still fails with a useful message', /do not exist/.test(msg), msg.slice(0, 50)) && pass;

    const t = await captureTime(path.join(root, 'a.jpg'));
    pass = ok('reads the shutter time out of Exif',
      t.source === 'exif' && t.at.getFullYear() === 2026 && t.at.getMonth() === 3 && t.at.getDate() === 11,
      `${t.source} ${t.at.toISOString()}`) && pass;

    const plain = path.join(root, 'no-exif.png');
    fs.writeFileSync(plain, Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.utimesSync(plain, new Date('2026-04-11T10:00:00'), new Date('2026-04-11T10:00:00'));
    const fallback = await captureTime(plain);
    pass = ok('falls back to the file date, and says so', fallback.source === 'mtime', fallback.source) && pass;

    const groups = groupBursts(await timedEntries(flat.files), { gapSeconds: 10, minFrames: 3 });
    pass = ok('splits the folder into its sweeps', groups.bursts.length === 2,
      groups.bursts.map(b => b.length).join(' + ') || 'none') && pass;
    pass = ok('a lone shot is reported, not stitched',
      groups.ungrouped.length === 1 && path.basename(groups.ungrouped[0].path) === 'lonely.jpg',
      groups.ungrouped.map(e => path.basename(e.path)).join(',')) && pass;
    pass = ok('frames come back in capture order',
      groups.bursts[0].map(e => path.basename(e.path)).join(',') === 'a.jpg,b.jpg,c.jpg',
      groups.bursts[0].map(e => path.basename(e.path)).join(',')) && pass;
    pass = ok('says where the times came from', groups.timeSource === 'exif', groups.timeSource) && pass;

    const wide = groupBursts(await timedEntries(flat.files), { gapSeconds: 3600, minFrames: 3 });
    pass = ok('a wider gap merges the sweeps', wide.bursts.length === 1 && wide.bursts[0].length === 7,
      `${wide.bursts.length} burst of ${wide.bursts[0].length}`) && pass;

    // RAW+JPEG: one press of the shutter, two files. Counting both doubles the burst and makes the
    // stitcher align a frame against its own copy.
    const pair = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-pair-'));
    for (const n of ['DSC_1.', 'DSC_2.', 'DSC_3.']) {
      fs.writeFileSync(path.join(pair, n + 'JPG'), jpeg);
      fs.writeFileSync(path.join(pair, n + 'NEF'), jpeg);
    }
    fs.writeFileSync(path.join(pair, 'DSC_4.NEF'), jpeg);          // RAW with no JPEG beside it
    const paired = await expandSources([pair]);
    pass = ok('a RAW beside its own JPEG is set aside',
      paired.files.length === 4 && paired.pairedRaw.length === 3,
      `${paired.files.length} kept, ${paired.pairedRaw.length} paired off`) && pass;
    pass = ok('the JPEG is the one kept',
      paired.files.filter(f => f.endsWith('.JPG')).length === 3,
      paired.files.map(f => path.basename(f)).join(',')) && pass;
    pass = ok('a RAW shot on its own is still stitched',
      paired.files.some(f => f.endsWith('DSC_4.NEF')), '') && pass;
    // Naming files is the caller saying which frames they want.
    const named = await expandSources([path.join(pair, 'DSC_1.JPG'), path.join(pair, 'DSC_1.NEF')]);
    pass = ok('an explicitly named pair is left alone',
      named.files.length === 2 && named.pairedRaw.length === 0,
      `${named.files.length} kept`) && pass;
    fs.rmSync(pair, { recursive: true, force: true });

    // Only a sibling every browser opens may displace the RAW. Preferring an iPhone's HEIC over its
    // DNG, or an exported TIFF over its NEF, trades a frame that works for one that will not.
    const undecodable = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-heic-'));
    for (const [a, b] of [['IMG_1.HEIC', 'IMG_1.DNG'], ['DSC_9.tif', 'DSC_9.NEF']]) {
      fs.writeFileSync(path.join(undecodable, a), jpeg);
      fs.writeFileSync(path.join(undecodable, b), jpeg);
    }
    const kept = await expandSources([undecodable]);
    pass = ok('a RAW is kept when its sibling is a HEIC or a TIFF',
      kept.pairedRaw.length === 0 && kept.files.some(f => f.endsWith('IMG_1.DNG')) && kept.files.some(f => f.endsWith('DSC_9.NEF')),
      kept.files.map(f => path.basename(f)).join(',')) && pass;
    fs.rmSync(undecodable, { recursive: true, force: true });

    // The write guard exempts only what this tool writes. A prefix is not provenance: a library of
    // panoramas is full of photographs called panorama-something.
    const exempt = ['/p/panorama-20260923225512.jpg', '/p/grid-2026092322551.png', '/p/burst-03/panorama.webp'];
    const guarded = ['/p/panorama-of-grand-canyon.jpg', '/p/row-boats.jpg', '/p/Panorama.JPG', '/p/panorama.jpg', '/p/grid.png'];
    pass = ok('only files this tool writes are exempt from the write guard',
      exempt.every(isOurOutput) && !guarded.some(isOurOutput),
      [...exempt, ...guarded].filter((p, i) => isOurOutput(p) !== (i < exempt.length)).join(', ') || 'all as expected') && pass;

    // Saying "mtime" for a burst that mostly carried real shutter times overstates the guess.
    const halfGuessed = describeBurst([
      { path: 'a.jpg', at: new Date('2026-04-11T09:00:00'), source: 'exif' },
      { path: 'b.jpg', at: new Date('2026-04-11T09:00:04'), source: 'exif' },
      { path: 'c.jpg', at: new Date('2026-04-11T09:00:08'), source: 'mtime' },
    ], 1);
    pass = ok('a burst of mixed times says so', halfGuessed.time_source === 'mixed',
      halfGuessed.time_source) && pass;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return pass;
};
