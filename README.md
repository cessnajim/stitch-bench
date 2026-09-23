# Stitch Bench

A single-file image stitcher that runs in the browser. Open `stitch-bench.html` — no build, no
install, no server. Images never leave the machine.

It does five things:

- **Panorama** — finds matching detail between overlapping frames and aligns them automatically.
  Order doesn't matter; it matches every pair, not just neighbours, so multi-row sets and
  out-of-order frames work.
- **Row / Column / Grid** — deterministic layouts with gaps, size matching and alignment.
- **Freeform** — drag frames into place by hand, with arrow-key nudging and a see-through overlay.
- **Exposure correction** — the part that took the most work. See below.
- **Edge handling** — crop to real pixels, or paint the ragged edges in, with an explicit limit on
  how much of the frame may be invented.

Exports PNG / JPEG / WebP at up to 180 MP. RAW files (NEF, CR2, ARW, DNG, RAF…) load via the
camera-rendered JPEG preview embedded in the file, since browsers can't demosaic raw sensor data.

## Exposure correction

Blending alone cannot fix frames shot at different exposures — it spreads the difference across the
overlap, which reads as a bright or dark band. Lens vignetting makes it worse: every frame is dark
at its edges, and the edges are where frames meet, so you get a dip at every seam. Three stages, all
computed on a small copy of the panorama:

1. **Brightness and colour match.** Every overlap is measured at once and solved jointly for a gain
   and offset per frame, per channel. Solved together, the correction spreads across the set instead
   of piling onto the last frame.
2. **Lens falloff.** One falloff curve for the set plus a per-frame exposure term, solved in log
   space. This is the stage local blending can't replace: it links a frame's dark edge to its own
   bright centre, which is the only place that information exists.
3. **Gradient smoothing.** A heavily blurred correction field pulls each frame toward its
   neighbours, absorbing drifting auto-exposure, moving cloud, uneven scanner lighting.

The pair constraints in stage 1 only pin frames *relative* to each other, so the solution has a
global degree of freedom and can drift (in practice, darker). After stages 1–2 the set's overall
mean and spread are restored to where they started, so only the *differences* between frames are
corrected. `test/synthetic.test.js` guards this; it is the bug real photos caught and synthetic
tests missed.

Measured against ground truth (one known scene, cut into overlapping frames, damaged, stitched,
compared back):

| Damage | Error before | After |
| --- | --- | --- |
| Exposure differences | 9.0 rms / 23 worst | 1.8 rms / 6.4 worst |
| Exposure + vignetting | 18.0 rms / 70 worst | 4.1 rms / 34 worst |

On a real 26-frame handheld sweep whose auto-exposure wandered 1/640 s → 1/200 s, brightness wander
across 2.5M flat-sky pixels dropped from 21.7 to 12.7 levels, while the sky's genuine left-to-right
gradient was left intact.

## Painted-in edges

A hand-held sweep leaves ragged edges. **Ragged edges** offers: crop to real pixels only; *trim,
then paint in the rest* (finds the largest rectangle whose invented share stays under a limit you
set); paint everything; or leave the edges empty for another editor. Gaps are filled by
interpolating the surrounding real pixels and relaxing that toward a smooth surface that meets the
real pixels at the boundary. Structure sitting at the edge of coverage — a lamp post, a cable, a
treetop — is rejected as a fill seed, or it streaks across everything invented.

Flat sky and water come out convincing. Foliage comes out soft. The panel always states what
percentage of the frame is invented rather than quietly making pixels up.

## Tests

```
cd test && npm install && npm test
```

Puppeteer drives the real page in headless Chrome and measures the output. `synthetic.test.js`
needs no external images: it builds a scene, cuts overlapping frames, applies known exposure and
vignette damage, and compares the stitch against the original. Point `STITCH_TEST_DIR` at a folder
of overlapping photos to run the real-image checks as well.

## tools/

Optional helpers for pulling source frames out of a self-hosted [Immich](https://immich.app) DAM
through its MCP gateway, and pushing results back. Configure with `DAM_MCP_URL` and, for a private
CA, `DAM_CA_PEM`. Unrelated to the stitcher itself — it only ever reads files from disk.
