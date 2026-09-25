# Stitch Bench

The stitcher is `stitch-bench.html`: one file, no build step. `test/` and `mcp/` both drive that page
in headless Chrome rather than importing from it, so there is one implementation and no second copy
to drift. Anything the tests or the server need must be reachable from the page, not from an internal
function, and a capability added for the MCP server alone still belongs there. The page's seam is its
interface. See [ADR-0004](docs/adr/0004-one-implementation-driven-through-the-page.md).

Input resolution is the exception: the page cannot read a directory at all, so expanding folders,
reading capture times and grouping frames into bursts live in `mcp/sources.js`.

## Before changing the photometric path

Read [`docs/adr/`](docs/adr). The exposure and shading stages carry constraints that look like
arbitrary choices and are not. Exposure is solved as log gains because matching `gain × mean + offset`
is degenerate and collapses every gain to its clamp. Its gauge is one sum-to-zero row, not a prior
per frame: the extra rows are not gauge fixing but a claim that every frame was exposed alike, and
they bias a wide sweep inward until its ends sit on the clamps. The level is set separately,
afterwards ([ADR-0005](docs/adr/0005-one-gauge-row-and-a-level.md)). The shading basis penalises its
asymmetric terms because frames shot in one row constrain nothing vertically, and fitted freely the
vertical term came back with the wrong sign. The shading fit passes three gates before it is trusted, and loosening any
of them is invisible to the synthetic tests, because synthetic damage is real shading by construction.

**Measure against synthetic ground truth.** `test/synthetic.test.js` builds a scene, damages it in
linear light, stitches, and compares back, so there is a known-good original to score against. Real
photographs have no such original, and no number derived from the output alone can stand in for one:
absolute measures of evenness flatter anything that reduces contrast, including a broken solve with
every gain pinned at its clamp. That mistake has been made here once and withdrawn.
[ADR-0003](docs/adr/0003-evenness-is-information-not-a-gate.md) has the full account.

## Naming

[`CONTEXT.md`](CONTEXT.md) is the glossary: frame, overlap, burst, log gain, shading field, drift,
coverage, invented share, and the words this project deliberately avoids. Read it before naming
anything new, and settle a term into it as soon as it is settled rather than batching them up. It
stays a glossary; implementation detail belongs in the code or an ADR.

## Let a stage report what it declined to do

The shading stage says whether it removed shading, found none, or found a fit and refused it. The
edge panel states what share of the frame is invented rather than quietly presenting painted pixels
as photography. `find_bursts` reports whether the times it grouped on came from Exif or from file
dates, because grouping on file dates is a guess. Give anything new that can decline or approximate
the same treatment: a caller cannot act on silence.

## Tests

`cd test && npm install && npm test`, which needs a Chrome or Chromium on the machine (`CHROME_PATH`
if it is somewhere unusual). The `sources` suite runs in under a second with no browser and covers
directory expansion, capture times and burst grouping: work against that loop when changing which
frames get stitched, and against `synthetic` when changing what happens to their pixels. Point
`STITCH_TEST_DIR` at a folder of overlapping photos to add the real-image checks, skipped without it.
