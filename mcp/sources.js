// Turning what a caller names into sets of frames to stitch.
//
// An agent pointed at a folder has a different problem from one handed a list: it does not know
// which files are photographs, and it does not know which of them belong to the same sweep. Both
// questions are answered here, on this side of the browser, because the page cannot read a
// directory at all. The stitching itself still happens in exactly one place (see
// docs/adr/0004-one-implementation-driven-through-the-page.md); this is input resolution, not
// stitching.
import { promises as fsp } from 'node:fs';
import { resolve, join, extname, basename, dirname } from 'node:path';

// Read through the preview the camera embedded in them rather than demosaiced, which is why these
// count as openable at all.
const RAW_EXT = new Set(['.nef', '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw', '.pef']);

// What might be a picture. Deciding it actually is one belongs to the browser, which will refuse
// some of these — TIFF and HEIC most often — and say so per file; this list only decides what is
// worth handing over. One set built from the other, so the two cannot drift apart.
const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif',
  ...RAW_EXT,
]);

// Files and folders this server wrote earlier. Stitching a folder twice should not fold the first
// panorama back into the second, and a recursive scan should not descend into collected bursts.
const OUR_OUTPUT = /^(panorama|row|column|grid)([-.]|$)/i;
const OUR_DIR = /^burst-\d+$/i;

// Asked by the write guard, and deliberately narrower than OUR_OUTPUT. Replacing one of our own
// results is the point of re-running, but a prefix is not provenance: a library of panoramas is
// full of photographs called panorama-something, and those are what the guard exists to protect.
// So only the names this tool actually writes qualify — a timestamped default (thirteen digits
// from before the stamp ran to whole seconds, fourteen since), or a panorama inside a burst folder.
const OUR_STAMPED = /^(panorama|row|column|grid)-\d{13,14}\.(jpg|png|webp)$/;
const OUR_COLLECTED = /^panorama\.(jpg|png|webp)$/;
export const isOurOutput = path =>
  OUR_STAMPED.test(basename(path)) || (OUR_COLLECTED.test(basename(path)) && OUR_DIR.test(basename(dirname(path))));

const readAt = async (fh, off, len) => {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, off);
  return b.subarray(0, bytesRead);
};

function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  if (n[0] < 1970 || n[0] > 2200) return null;
  const d = new Date(n[0], n[1] - 1, n[2], n[3], n[4], n[5]);
  return isNaN(d) ? null : d;
}

// Walk a TIFF header for DateTimeOriginal, falling back to DateTime. Two hops: IFD0, then the Exif
// IFD it points at. Positional reads rather than slurping the file, because a NEF is 40 MB and the
// twenty bytes we want are near the front.
async function tiffDateTime(fh, base) {
  const hdr = await readAt(fh, base, 8);
  if (hdr.length < 8) return null;
  const le = hdr[0] === 0x49;
  const u16 = (b, o) => (o + 2 <= b.length ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : 0);
  const u32 = (b, o) => (o + 4 <= b.length ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0);

  let ifd = u32(hdr, 4), best = null;
  for (let hop = 0; hop < 2 && ifd > 0 && ifd < 0x7fffffff; hop++) {
    const count = u16(await readAt(fh, base + ifd, 2), 0);
    if (!count || count > 512) break;
    const entries = await readAt(fh, base + ifd + 2, count * 12);
    let exifPtr = 0;
    for (let i = 0; i + 12 <= entries.length; i += 12) {
      const tag = u16(entries, i), type = u16(entries, i + 2), n = u32(entries, i + 4);
      if (tag === 0x8769) exifPtr = u32(entries, i + 8);           // Exif IFD pointer
      if ((tag === 0x9003 || tag === 0x0132) && type === 2 && n >= 19) {
        const s = (await readAt(fh, base + u32(entries, i + 8), 19)).toString('latin1');
        const d = parseExifDate(s);
        // DateTimeOriginal is when the shutter fired; DateTime is when the file was last written.
        if (d && (tag === 0x9003 || !best)) best = d;
        if (d && tag === 0x9003) return d;
      }
    }
    ifd = exifPtr;
  }
  return best;
}

async function exifDateTime(fh) {
  const head = await readAt(fh, 0, 4);
  if (head.length < 4) return null;
  if (head[0] === 0xff && head[1] === 0xd8) {                       // JPEG: find the APP1 Exif segment
    const scan = await readAt(fh, 0, 131072);
    let p = 2;
    while (p + 4 <= scan.length && scan[p] === 0xff) {
      const marker = scan[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;                // image data starts; no Exif
      const len = scan.readUInt16BE(p + 2);
      if (len < 2) break;
      if (marker === 0xe1 && scan.subarray(p + 4, p + 10).toString('latin1') === 'Exif\0\0') {
        return tiffDateTime(fh, p + 10);
      }
      p += 2 + len;
    }
    return null;
  }
  const tiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a)
    || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a);
  return tiff ? tiffDateTime(fh, 0) : null;                         // most RAW files are TIFF
}

// When the shutter time is missing, modification time is the only other ordering signal. Say which
// one was used: copied files often share an mtime to the second, and grouping on that is a guess.
export async function captureTime(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const exif = await exifDateTime(fh);
    if (exif) return { at: exif, source: 'exif' };
    const st = await fh.stat();
    return { at: st.mtime, source: 'mtime' };
  } catch {
    return { at: new Date(0), source: 'unknown' };
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function walk(dir, recursive, out, seen) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) { if (recursive && !OUR_DIR.test(e.name)) await walk(abs, recursive, out, seen); continue; }
    if (!IMAGE_EXT.has(extname(e.name).toLowerCase())) continue;
    if (OUR_OUTPUT.test(e.name)) continue;
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
}

// A camera set to RAW+JPEG writes two files for one press of the shutter. They are one frame, and
// taking both means aligning a frame against its own copy: twice the work, a burst that counts
// double, and every overlap in the pair measured twice over, which doubles its weight in the
// exposure solve. The JPEG is the one to keep — a RAW reaches the page through the preview the
// camera embedded in it, which is the smaller and more heavily compressed of the two renderings
// the camera made from that exposure.
//
// Only a sibling every browser opens gets to displace the RAW. An iPhone writes HEIC beside its
// DNG and an editor may export TIFF beside a NEF; neither usually decodes, and preferring them
// would trade a frame that works, through its preview, for one that is certain to come back
// unreadable.
//
// Only files found by expanding a directory are considered. Naming files is the caller saying
// which frames they want, and that is not this server's to second-guess.
const DISPLACES_RAW = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function pairRawWithJpeg(files, fromDir) {
  const stem = f => f.slice(0, f.length - extname(f).length);   // full path, so this is per-folder
  const opens = new Set();
  for (const f of files) if (DISPLACES_RAW.has(extname(f).toLowerCase())) opens.add(stem(f));
  const paired = [];
  const kept = files.filter(f => {
    if (!fromDir.has(f) || !RAW_EXT.has(extname(f).toLowerCase())) return true;
    if (!opens.has(stem(f))) return true;
    paired.push(f);
    return false;
  });
  return { kept, paired };
}

// Files stay as they are; directories expand to the images inside them. Reports whether any
// directory was named, because that is what decides whether grouping is wanted.
export async function expandSources(paths, { recursive = false } = {}) {
  const files = [], missing = [], seen = new Set(), fromDir = new Set();
  let sawDirectory = false;
  for (const p of paths) {
    const abs = resolve(p);
    let st;
    try { st = await fsp.stat(abs); } catch { missing.push(p); continue; }
    if (st.isDirectory()) {
      sawDirectory = true;
      const before = files.length;
      await walk(abs, recursive, files, seen);
      for (let i = before; i < files.length; i++) fromDir.add(files[i]);   // order is preserved
    } else if (!seen.has(abs)) { seen.add(abs); files.push(abs); }
  }
  if (missing.length) throw new Error(`These files do not exist: ${missing.join(', ')}`);
  const { kept, paired } = pairRawWithJpeg(files, fromDir);
  return { files: kept, sawDirectory, pairedRaw: paired };
}

export async function timedEntries(files) {
  return Promise.all(files.map(async path => ({ path, ...(await captureTime(path)) })));
}

// A burst is a run of frames shot close enough together to be one sweep. The convention matches
// tools/find_bursts.py, which does the same job against the DAM: a gap longer than `gapSeconds`
// starts a new burst, and a run shorter than `minFrames` is not a panorama.
export function groupBursts(entries, { gapSeconds = 10, minFrames = 3 } = {}) {
  const sorted = [...entries].sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  const runs = [];
  for (const e of sorted) {
    const cur = runs[runs.length - 1];
    if (cur && (e.at - cur[cur.length - 1].at) / 1000 <= gapSeconds) cur.push(e);
    else runs.push([e]);
  }
  return {
    bursts: runs.filter(r => r.length >= minFrames),
    ungrouped: runs.filter(r => r.length < minFrames).flat(),
    // Grouping is only as good as the timestamps behind it.
    timeSource: sorted.every(e => e.source === 'exif') ? 'exif'
      : sorted.some(e => e.source === 'exif') ? 'mixed' : 'mtime',
  };
}

export const describeBurst = (run, index) => ({
  index,
  frames: run.length,
  span_seconds: Math.round((run[run.length - 1].at - run[0].at) / 100) / 10,
  starts_at: run[0].at.toISOString(),
  // Same three answers groupBursts gives. Collapsing "mixed" into "mtime" would say a burst was
  // grouped entirely on file dates when most of it carried a real shutter time, and the point of
  // reporting this at all is that grouping on file dates is a guess.
  time_source: run.every(e => e.source === 'exif') ? 'exif'
    : run.some(e => e.source === 'exif') ? 'mixed' : 'mtime',
  files: run.map(e => e.path),
});

export const burstLabel = run => basename(run[0].path);
