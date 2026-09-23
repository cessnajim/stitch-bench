#!/usr/bin/env node
// Stitch Bench as MCP tools: align and stitch overlapping photos, or lay images out, entirely on
// this machine. Files are read from and written to paths the caller names; nothing is uploaded.
// The one network call is the OpenCV build the page loads for feature matching.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { stitchPanorama, stitchLayout, inspectAlignment, shutdown } from './stitcher.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const imagesField = z.array(z.string().min(1))
  .min(2)
  .describe('Paths to the source images, in any order. JPEG, PNG, WebP or camera RAW (NEF, CR2, ARW, DNG…), which is read through the preview the camera embedded in the file.');
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

const reply = ({ result, preview }) => {
  const content = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
  if (preview) content.push({ type: 'image', data: preview, mimeType: 'image/jpeg' });
  return { content, structuredContent: result };
};
const fail = err => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const server = new McpServer({ name: 'stitch-bench-mcp-server', version: '1.0.0' });

server.registerTool('stitch_panorama', {
  title: 'Stitch a panorama',
  description:
    'Align overlapping photos into a single image and write it to disk. Finds the overlaps itself, ' +
    'so the order of the images does not matter and multiple rows are fine; neighbouring shots need ' +
    'roughly 20–50% overlap. Matches exposure between frames, removes uneven lens shading when the ' +
    'overlaps support it, and can paint in the ragged edges a hand-held sweep leaves behind. Returns ' +
    'the output path with what was placed, what was corrected and how much of the frame was invented.',
  inputSchema: {
    images: imagesField,
    output: z.string().optional()
      .describe('Where to write the result. Defaults to a timestamped file beside the first image.'),
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
    output_path: z.string(), width: z.number(), height: z.number(), megapixels: z.number(),
    bytes: z.number(), painted_percent: z.number(), seconds: z.number(),
    frames_total: z.number(), frames_placed: z.number(), frames_unplaced: z.array(z.string()),
    anchor: z.string().nullable(),
    links: z.array(z.object({ a: z.string(), b: z.string(), matches: z.number(), agreeing: z.number() })),
    full_extent: z.object({ width: z.number(), height: z.number() }),
    exposure: z.any().nullable(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (args, extra) => {
  try {
    const output = resolve(args.output || defaultOutput(args.images, args.format, 'panorama'));
    return reply(await stitchPanorama({ ...args, output, onProgress: progressFor(extra) }));
  } catch (e) { return fail(e); }
});

server.registerTool('inspect_alignment', {
  title: 'Check whether images will stitch',
  description:
    'Dry run: work out which images overlap and how strongly, without rendering anything. Use before ' +
    'committing to a full-resolution stitch, or to find the odd frame out in a large set. Reports the ' +
    'linked pairs with match counts, any frames that could not be placed, and the size the panorama ' +
    'would be.',
  inputSchema: {
    images: imagesField,
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
  try { return reply(await inspectAlignment({ ...args, onProgress: progressFor(extra) })); }
  catch (e) { return fail(e); }
});

server.registerTool('stitch_layout', {
  title: 'Lay images out in a row, column or grid',
  description:
    'Place images side by side, stacked, or in a grid and write one image. No alignment is attempted — ' +
    'positions come from the order given, which makes this the right tool for contact sheets, ' +
    'before-and-after pairs, and assembling tiles that already meet exactly.',
  inputSchema: {
    images: z.array(z.string().min(1)).min(1).describe('Paths to the images, in the order they should appear.'),
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
    const output = resolve(args.output || defaultOutput(args.images, args.format, args.mode));
    return reply(await stitchLayout({ ...args, output, onProgress: progressFor(extra) }));
  } catch (e) { return fail(e); }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await shutdown(); process.exit(0); });

await server.connect(new StdioServerTransport());
