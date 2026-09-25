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
overlap, which reads as a bright or dark band. Uneven shading makes it worse: every frame is darker
at its edges, and the edges are where frames meet, so you get a dip at every seam.

Everything photometric happens in **linear light**. Exposure is a multiply on the light reaching the
sensor, not on the gamma-encoded numbers a JPEG stores; gains fitted on encoded values can line the
mid-tones up and still leave the sky stepped.

1. **Exposure match.** Every overlap is measured at once and solved jointly for one gain per frame
   per channel, as log gains. The multiplicative form matters: an equation matching `gain × mean +
   offset` between frames is satisfied just as well by shrinking every gain toward zero, and with
   enough overlapping pairs outvoting the priors, that is exactly what a solver does — every frame
   pinned at the minimum gain and the panorama washed out. In log space only differences between
   frames appear, and the one remaining degree of freedom — the same constant on every gain — is
   pinned by a single sum-to-zero row. One row, because it is one degree of freedom: a prior per
   frame also pins it, but the surplus rows quietly assert that the frames were all exposed alike,
   and an auto-exposure sweep across three stops gets dragged inward until its ends sit on their
   clamps. Where the set as a whole then sits is chosen separately, afterwards, as the single
   factor that leaves its mean brightness where it was.
2. **Shading.** One field shared by the set — same lens, same filter — plus a per-frame exposure
   term. Its basis is ordered radial-first, and the asymmetric terms are heavily penalised, because
   frames shot in a single row only overlap side by side: the same scene point appears at different
   x in two frames but at the *same* y, so nothing in the data constrains vertical behaviour. Fitted
   freely, the vertical term came back with the wrong sign and inverted the correction. The fit is
   also validated before it is trusted — half the overlap samples train it, the other half judge it
   against a plain per-frame-exposure model — and rejected if it implies an implausibly strong
   falloff.
3. **Gradient smoothing.** A heavily blurred correction field pulls each frame toward its
   neighbours, absorbing drifting auto-exposure, moving cloud, uneven scanner lighting.

Measured against ground truth (`test/synthetic.test.js` builds a scene, cuts overlapping frames,
damages them *in linear light* as a camera and lens would, stitches, and compares back):

| Damage in the frames | Error before | After |
| --- | --- | --- |
| Exposure differences (±½ stop) | 15.8 rms | **1.2 rms** |
| Exposure + 45% corner falloff | 18.1 rms | **8.7 rms** |

The second case is heavier than most real lenses, and the correction recovers about half of it: what
it can fit is limited to what the overlaps actually observe.

### A note on measuring this

An earlier version of this README claimed a 41% reduction in sky wander on a real 26-frame set. That
number was wrong and is withdrawn. Wander was measured in absolute levels, so a build that darkened
the whole panorama scored well for the wrong reason — and a genuinely broken solve, with every gain
pinned at its clamp, scored best of all. Absolute measures of evenness flatter anything that reduces
contrast. `test/real.test.js` still prints the number, but as information beside the image, not as a
gate; what it asserts instead is that overall brightness is preserved.

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

## MCP server

`mcp/` exposes the stitcher as tools an agent can call, so a pile of frames can be checked, stitched
and written without anyone opening a browser. It drives the same page in headless Chrome — one
implementation, not a second one that drifts.

```bash
cd mcp && npm install          # needs Node 18+ and a Chrome or Chromium on the machine
```

Opening this repo as a project picks the server up from the checked-in `.mcp.json`. To register it
globally instead, point a client at it by absolute path:

```json
{
  "mcpServers": {
    "stitch-bench": {
      "command": "node",
      "args": ["/absolute/path/to/stitch-bench/mcp/server.js"]
    }
  }
}
```

Set `CHROME_PATH` if the browser is somewhere unusual; macOS Chrome, Chromium and Brave are found
automatically.

| Tool | What it does |
| --- | --- |
| `stitch_panorama` | Aligns overlapping photos, corrects exposure, writes the image, reports what was placed, corrected and painted in |
| `find_bursts` | Groups a folder of pictures into the sweeps they were shot as, by capture time. Writes nothing, opens no browser |
| `inspect_alignment` | Dry run — which frames link to which, with match counts, and the size the result would be. Writes nothing |
| `stitch_layout` | Row, column or grid layout for contact sheets, comparisons and tiles |

### Pointing it at a folder

Every tool takes directories as well as files. Naming files means *stitch these*; naming a directory
means *work out what is in here*, which is the harder question, because a folder of a day's shooting
holds several sweeps and a scattering of loose shots.

A directory is split into **bursts** by capture time — `DateTimeOriginal` from each file's Exif,
falling back to the file's own date when a camera wrote none — and each burst is stitched on its
own. The convention matches `tools/find_bursts.py`: a gap longer than `gap_seconds` (10 by default)
starts a new burst, and a run shorter than `min_frames` (3) is reported as loose shots rather than
stitched. `find_bursts` shows the grouping without rendering anything, which is the cheap first call
when you do not know what a folder holds.

Each burst is then collected into its own folder beside the frames it came from:

```
~/Pictures/hike/
├── DSC_0101.NEF … DSC_0148.NEF     ← originals, untouched
├── burst-01/
│   ├── DSC_0101.NEF … DSC_0112.NEF ← copies of the twelve frames that made this one
│   └── panorama.jpg
└── burst-02/
    ├── DSC_0119.NEF … DSC_0131.NEF
    └── panorama.jpg
```

The originals stay where they are. `collect: "hardlink"` links instead of copying, which is free for
a set of RAWs but only works within one filesystem, and `collect: "none"` writes just the panorama.
Re-running skips both the folders and the panoramas of the previous run, so a second pass over the
same directory does not fold its own output back in.

Grouping only happens when a directory was named. An explicit list of files is one panorama, as
before: you have already done the grouping. `group: "bursts"` or `group: "single"` overrides either
way.

Each returns structured output plus a small preview image, and reports progress while it works —
a full-resolution stitch of two dozen 24MP frames takes minutes, and a silent tool call that long
looks like a hung one. Paths in, paths out: the server reads only the files it is given and writes
only where it is told.

## tools/

Optional helpers for pulling source frames out of a self-hosted [Immich](https://immich.app) DAM
through its MCP gateway, and pushing results back. Configure with `DAM_MCP_URL` and, for a private
CA, `DAM_CA_PEM`. Unrelated to the stitcher itself — it only ever reads files from disk.

## CONTEXT.md and ADRs

[`CONTEXT.md`](CONTEXT.md) is the glossary: what a frame, an overlap, a log gain, a shading field and
an invented share are, and which words this project deliberately does not use. [`docs/adr/`](docs/adr)
records the decisions behind the photometric pipeline that are surprising without the reasoning —
why exposure is solved as log gains, why the shading fit has to earn its place, why no measure of
evenness is allowed to gate anything, and why there is only one implementation.

## License

MIT — see [LICENSE](LICENSE).
