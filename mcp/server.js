#!/usr/bin/env node
// Stitch Bench as MCP tools: align and stitch overlapping photos, or lay images out, entirely on
// this machine. Files are read from and written to paths the caller names; nothing is uploaded.
// The one network call is the OpenCV build the page loads for feature matching.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { promises as fsp } from 'node:fs';
import { stitchPanorama, stitchLayout, inspectAlignment, shutdown } from './stitcher.js';
import { expandSources, timedEntries, groupBursts, describeBurst } from './sources.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const imagesField = z.array(z.string().min(1))
  .min(1)
  .describe('Paths to the source images, in any order, or to directories holding them. A directory expands to the images inside it, skipping anything this server wrote earlier. JPEG, PNG, WebP or camera RAW (NEF, CR2, ARW, DNG…), which is read through the preview the camera embedded in the file.');
const recursiveField = z.boolean().default(false)
  .describe('When a directory is named, also look in the directories inside it.');
const gapField = z.number().min(0.5).max(3600).default(10)
  .describe('Seconds between consecutive shots that still count as one sweep. A longer gap starts a new burst.');
const minFramesField = z.number().int().min(2).max(500).default(3)
  .describe('Fewest frames a run must have before it counts as a panorama rather than loose shots.');
const formatField = z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg')
  .describe('Encoding for the written file. PNG is lossless and much larger.');
const qualityField = z.number().min(0.5).max(1).default(0.92)
  .describe('Encoder quality for JPEG and WebP. Ignored for PNG.');
const scaleField = z.number().min(0.05).max(1).default(1)
  .describe('Fraction of full resolution to write. 1 renders from the full-size originals.');
const previewField = z.boolean().default(true)
  .describe('Also return a small JPEG of the result, so the caller can see what was produced.');

function defaultOutput(images, format, suffix) {
  const first = resolve(images[0]);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
  return join(dirname(first), `${suffix}-${stamp}.${EXT[format]}`);
}

// What the caller named, turned into the sets of frames to stitch. Naming files means "stitch
// these"; naming a directory means "work out what is in here", which is the case that needs
// grouping, because a folder of a day's shooting holds several sweeps and some loose shots.
async function resolveSets(args) {
  const { files, sawDirectory } = await expandSources(args.images, { recursive: args.recursive });
  if (!files.length) {
    throw new Error('No images found. A directory expands to the picture files inside it; pass recursive: true to look in subdirectories as well.');
  }
  const group = !args.group || args.group === 'auto' ? (sawDirectory ? 'bursts' : 'single') : args.group;
  if (group === 'single') {
    if (files.length < 2) throw new Error(`Stitching needs at least two overlapping images; found ${files.length}.`);
    return { sets: [{ files, run: null, index: 1 }], grouped: false, ungrouped: [], timeSource: null };
  }
  const { bursts, ungrouped, timeSource } = groupBursts(await timedEntries(files), {
    gapSeconds: args.gap_seconds, minFrames: args.min_frames,
  });
  if (!bursts.length) {
    throw new Error(
      `Found ${files.length} image${files.length === 1 ? '' : 's'}, but no run of ${args.min_frames} or more shot within ` +
      `${args.gap_seconds}s of each other. Widen gap_seconds, lower min_frames, or pass the frames as an explicit list.`
    );
  }
  return {
    sets: bursts.map((run, i) => ({ files: run.map(e => e.path), run, index: i + 1 })),
    grouped: true, ungrouped: ungrouped.map(e => e.path), timeSource,
  };
}

// Give each burst its own folder, holding copies of the frames that went into it beside the
// panorama they produced. A folder you can hand to someone else, rather than a result whose inputs
// are thirty files somewhere in a directory of four hundred.
async function collectInto(dir, files, mode) {
  await fsp.mkdir(dir, { recursive: true });
  const out = [], used = new Set();
  for (const src of files) {
    let name = basename(src);
    if (used.has(name)) {                       // two folders can hold the same file name
      const ext = extname(name), stem = ext ? name.slice(0, -ext.length) : name;
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);
    const dst = join(dir, name);
    if (resolve(src) === dst) { out.push(dst); continue; }
    if (mode === 'hardlink') {
      // Cheap for a set of 24MP RAWs, but impossible across filesystems: fall back to a real copy.
      try { await fsp.link(src, dst); out.push(dst); continue; } catch { /* fall through */ }
    }
    await fsp.copyFile(src, dst);
    out.push(dst);
  }
  return out;
}

// Long jobs must keep talking: a client that hears nothing assumes the request died. When the
// caller supplies a progress token, forward what the page is doing.
const progressFor = (extra) => {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return undefined;
  let last = 0;
  return (percent, message) => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: percent ?? 0, total: 100, message },
    }).catch(() => {});
  };
};

const reply = ({ result, preview, previews }) => {
  const content = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
  const shots = previews || (preview ? [preview] : []);
  // One preview per panorama, but a folder of twenty bursts should not return twenty images.
  for (const data of shots.slice(0, 6)) content.push({ type: 'image', data, mimeType: 'image/jpeg' });
  return { content, structuredContent: result };
};
const fail = err => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const panoramaResult = z.object({
  output_path: z.string(),
  directory: z.string().nullable(),
  width: z.number(), height: z.number(), megapixels: z.number(),
  bytes: z.number(), painted_percent: z.number(), seconds: z.number(),
  frames_total: z.number(), frames_placed: z.number(), frames_unplaced: z.array(z.string()),
  anchor: z.string().nullable(),
  links: z.array(z.object({ a: z.string(), b: z.string(), matches: z.number(), agreeing: z.number() })),
  full_extent: z.object({ width: z.number(), height: z.number() }),
  exposure: z.any().nullable(),
  burst: z.any().nullable(),
  source_files: z.array(z.string()),
});

const server = new McpServer({ name: 'stitch-bench-mcp-server', version: '1.1.0' });

server.registerTool('stitch_panorama', {
  title: 'Stitch a panorama',
  description:
    'Align overlapping photos into a single image and write it to disk. Finds the overlaps itself, ' +
    'so the order of the images does not matter and multiple rows are fine; neighbouring shots need ' +
    'roughly 20–50% overlap. Matches exposure between frames, removes uneven lens shading when the ' +
    'overlaps support it, and can paint in the ragged edges a hand-held sweep leaves behind. Point it ' +
    'at a directory and it splits the pictures into bursts by capture time and stitches each one, ' +
    'collecting every burst into its own folder beside its panorama. Returns one entry per panorama ' +
    'with what was placed, what was corrected and how much of the frame was invented.',
  inputSchema: {
    images: imagesField,
    recursive: recursiveField,
    group: z.enum(['auto', 'bursts', 'single']).default('auto')
      .describe('"auto" groups into bursts when a directory was named and treats an explicit list of files as one panorama; "bursts" always groups by capture time; "single" always stitches everything as one.'),
    gap_seconds: gapField,
    min_frames: minFramesField,
    collect: z.enum(['auto', 'copy', 'hardlink', 'none']).default('auto')
      .describe('Put each burst in its own folder with copies of its frames beside the panorama. "auto" does this when grouping into bursts and not otherwise; "hardlink" links instead of copying, which is free but only works on one filesystem.'),
    output_dir: z.string().optional()
      .describe('Parent folder for the collected burst folders. Defaults to the folder the frames came from.'),
    output: z.string().optional()
      .describe('Where to write the result, for a single panorama that is not being collected into a folder. Defaults to a timestamped file beside the first image.'),
    motion: z.enum(['perspective', 'similarity', 'translation']).default('perspective')
      .describe('How the camera moved: "perspective" for hand-held photos, "similarity" for flatbed or drone, "translation" for scans, screenshots and map tiles.'),
    exposure: z.enum(['full', 'gain', 'off']).default('full')
      .describe('"full" matches brightness, removes lens shading and smooths gradients; "gain" matches brightness only; "off" leaves pixel values untouched, which is what you want for measurement work.'),
    edges: z.enum(['trim', 'crop', 'fill', 'keep']).default('trim')
      .describe('Ragged edges: "trim" keeps the largest rectangle within the painted-in limit, "crop" keeps only photographed pixels, "fill" keeps everything and paints the gaps, "keep" leaves them transparent.'),
    paint_limit: z.number().min(0).max(30).default(8)
      .describe('With edges "trim", the largest share of the frame (percent) allowed to be painted in rather than photographed.'),
    seams: z.enum(['feather', 'hard']).default('feather')
      .describe('Blend overlaps smoothly, or butt them with hard edges.'),
    detail: z.union([z.literal(1200), z.literal(2500), z.literal(5000)]).default(2500)
      .describe('How many feature points to look for per image. More is slower and finds harder matches.'),
    format: formatField, quality: qualityField, scale: scaleField, preview: previewField,
  },
  outputSchema: {
    count: z.number(),
    grouped_by_burst: z.boolean(),
    time_source: z.string().nullable(),
    ungrouped_files: z.array(z.string()),
    panoramas: z.array(panoramaResult),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args, extra) => {
  try {
    const onProgress = progressFor(extra);
    const { sets, grouped, ungrouped, timeSource } = await resolveSets(args);
    const collect = args.collect === 'auto' ? (grouped ? 'copy' : 'none') : args.collect;
    if (sets.length > 1 && args.output) {
      throw new Error(`This is ${sets.length} bursts, so "output" cannot name one file. Leave it out, or set output_dir to the folder to write them under.`);
    }
    const panoramas = [], previews = [];
    for (const set of sets) {
      const base = resolve(args.output_dir || dirname(set.files[0]));
      let directory = null, sources = set.files, output;
      if (collect === 'none') {
        output = resolve(args.output || defaultOutput(set.files, args.format, 'panorama'));
      } else {
        directory = join(base, `burst-${String(set.index).padStart(2, '0')}`);
        sources = await collectInto(directory, set.files, collect);
        output = join(directory, `panorama.${EXT[args.format]}`);
      }
      if (sets.length > 1) onProgress?.(null, `Burst ${set.index} of ${sets.length}: ${set.files.length} frames…`);
      const { result, preview } = await stitchPanorama({ ...args, images: sources, output, onProgress });
      panoramas.push({
        ...result, directory, source_files: sources,
        burst: set.run ? describeBurst(set.run, set.index) : null,
      });
      if (preview) previews.push(preview);
    }
    return reply({
      result: {
        count: panoramas.length, grouped_by_burst: grouped,
        time_source: timeSource, ungrouped_files: ungrouped, panoramas,
      },
      previews,
    });
  } catch (e) { return fail(e); }
});

server.registerTool('find_bursts', {
  title: 'Find the panorama-shaped bursts in a folder',
  description:
    'Group pictures into the sweeps they were shot as, reading capture time from each file and ' +
    'splitting wherever the camera paused. Writes nothing and opens no browser, so it is the cheap ' +
    'first call when pointed at a folder: it shows which frames belong together, and how many ' +
    'panoramas a full stitch would produce, before committing minutes of work to it.',
  inputSchema: {
    images: imagesField,
    recursive: recursiveField,
    gap_seconds: gapField,
    min_frames: minFramesField,
  },
  outputSchema: {
    files_found: z.number(),
    time_source: z.string()
      .describe('"exif" when every file carried a shutter time, "mtime" when none did and the file dates were used instead, "mixed" for some of each.'),
    bursts: z.array(z.object({
      index: z.number(), frames: z.number(), span_seconds: z.number(),
      starts_at: z.string(), time_source: z.string(), files: z.array(z.string()),
    })),
    ungrouped: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args) => {
  try {
    const { files } = await expandSources(args.images, { recursive: args.recursive });
    if (!files.length) throw new Error('No images found. Pass recursive: true to look in subdirectories as well.');
    const { bursts, ungrouped, timeSource } = groupBursts(await timedEntries(files), {
      gapSeconds: args.gap_seconds, minFrames: args.min_frames,
    });
    return reply({
      result: {
        files_found: files.length,
        time_source: timeSource,
        bursts: bursts.map((run, i) => describeBurst(run, i + 1)),
        ungrouped: ungrouped.map(e => e.path),
      },
    });
  } catch (e) { return fail(e); }
});

server.registerTool('inspect_alignment', {
  title: 'Check whether images will stitch',
  description:
    'Dry run: work out which images overlap and how strongly, without rendering anything. Use before ' +
    'committing to a full-resolution stitch, or to find the odd frame out in a large set. Reports the ' +
    'linked pairs with match counts, any frames that could not be placed, and the size the panorama ' +
    'would be. Treats everything given as one panorama, so for a folder holding several sweeps, call ' +
    'find_bursts first and inspect one burst at a time.',
  inputSchema: {
    images: imagesField,
    recursive: recursiveField,
    motion: z.enum(['perspective', 'similarity', 'translation']).default('perspective')
      .describe('How the camera moved between shots.'),
    detail: z.union([z.literal(1200), z.literal(2500), z.literal(5000)]).default(2500)
      .describe('How many feature points to look for per image.'),
  },
  outputSchema: {
    frames_total: z.number(), frames_placed: z.number(), frames_unplaced: z.array(z.string()),
    anchor: z.string().nullable(),
    links: z.array(z.object({ a: z.string(), b: z.string(), matches: z.number(), agreeing: z.number() })),
    full_extent: z.object({ width: z.number(), height: z.number() }),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args, extra) => {
  try {
    const { files } = await expandSources(args.images, { recursive: args.recursive });
    if (files.length < 2) throw new Error(`Checking an alignment needs at least two images; found ${files.length}.`);
    return reply(await inspectAlignment({ ...args, images: files, onProgress: progressFor(extra) }));
  } catch (e) { return fail(e); }
});

server.registerTool('stitch_layout', {
  title: 'Lay images out in a row, column or grid',
  description:
    'Place images side by side, stacked, or in a grid and write one image. No alignment is attempted — ' +
    'positions come from the order given, which makes this the right tool for contact sheets, ' +
    'before-and-after pairs, and assembling tiles that already meet exactly. A directory expands to ' +
    'the images inside it, in name order.',
  inputSchema: {
    images: imagesField,
    recursive: recursiveField,
    mode: z.enum(['row', 'column', 'grid']).default('row').describe('Left to right, top to bottom, or a grid filled left to right then down.'),
    output: z.string().optional().describe('Where to write the result. Defaults to a timestamped file beside the first image.'),
    columns: z.number().int().min(1).max(50).default(3).describe('Grid mode only: how many columns.'),
    cell_fit: z.enum(['none', 'contain', 'cover']).default('none').describe('Grid mode only: leave images at their own size, scale them to fit the cell, or fill it and crop.'),
    match: z.enum(['min', 'max', 'none']).default('min').describe('Row and column modes: scale everything to the smallest, to the largest, or leave sizes alone.'),
    align: z.enum(['start', 'center', 'end']).default('center').describe('With match "none", how to align images across the row or column.'),
    gap: z.number().int().min(0).max(200).default(0).describe('Pixels of space between images.'),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff').describe('Background colour behind gaps, as #rrggbb.'),
    transparent: z.boolean().default(false).describe('Leave the background transparent instead. PNG or WebP only.'),
    format: formatField, quality: qualityField, scale: scaleField, preview: previewField,
  },
  outputSchema: {
    output_path: z.string(), width: z.number(), height: z.number(), megapixels: z.number(),
    bytes: z.number(), images: z.number(), seconds: z.number(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args, extra) => {
  try {
    const { files } = await expandSources(args.images, { recursive: args.recursive });
    if (!files.length) throw new Error('No images found.');
    const output = resolve(args.output || defaultOutput(files, args.format, args.mode));
    return reply(await stitchLayout({ ...args, images: files, output, onProgress: progressFor(extra) }));
  } catch (e) { return fail(e); }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await shutdown(); process.exit(0); });

await server.connect(new StdioServerTransport());
