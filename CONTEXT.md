# Stitch Bench

The vocabulary of stitching overlapping photographs into one image: how frames are matched and
placed, how their brightness is reconciled, and what happens at the edges where coverage runs out.

## Frames and placement

**Frame**:
One source image in the set. A frame keeps its own coordinate system after placement, which is what
the photometric stages need.
_Avoid_: image, photo, tile, layer

**Overlap**:
The region where two frames cover the same part of the scene. Every photometric measurement is made
here, because it is the only place one scene point is observed twice.
_Avoid_: intersection, shared area

**Link**:
A confirmed pairwise correspondence between two frames, carrying how many features matched and how
many survived the geometric fit. Frames connect into a set through links, not through shooting
order.
_Avoid_: edge, connection, neighbour, pair

**Anchor frame**:
The one frame left where it is, against which every other frame's placement is solved.
_Avoid_: reference frame, base, first frame

**Coverage**:
Which output pixels have real photographed data behind them. What falls outside it is the edge
handling's problem.
_Avoid_: mask, extent, footprint

**Frame-local position**:
Where a pixel sits inside its own frame, normalised with the origin at the frame centre. The shading
field is a function of this, which is what makes shading separable from the scene.
_Avoid_: uv, texture coordinates, pixel position

## Sets and folders

**Burst**:
A run of frames shot close enough together in time to be one sweep of the camera. The unit a
directory is split into: one burst makes one panorama.
_Avoid_: group, batch, run, series, sequence

**Loose shots**:
Frames that fall outside every burst, because too few were taken close enough together. Reported so
they are visibly skipped rather than silently swept into a neighbouring panorama.
_Avoid_: orphans, leftovers, singles, ungrouped (used as a field name, not as the term)

**Capture time**:
When the shutter fired, read from the frame itself. The only thing that separates one burst from the
next, and the reason a set with no such time recorded is grouped on a guess.
_Avoid_: timestamp, date taken, EXIF time

**Collected folder**:
The folder a burst is gathered into: copies of the frames that went into it, beside the panorama
they produced. What makes a result portable, rather than a file whose inputs are thirty of the four
hundred images in the directory above it.
_Avoid_: output folder, bundle, working directory

## Photometry

**Linear light**:
Light as it reached the sensor, proportional to photon count, before any gamma encoding. Every
photometric operation happens here.
_Avoid_: raw, unencoded, decoded values

**Log gain**:
A per-frame, per-channel exposure correction, carried as its logarithm. Exposure is a multiply on
linear light, so the correction is a gain, and only differences between frames are observable.
_Avoid_: exposure offset, brightness adjustment, level, gain and offset

**Shading field**:
One description, shared by the whole set, of how brightness varies across the frame: lens falloff, a
graduated filter, light dropping off to one side. Shared because it is a property of the optics, not
of any one frame.
_Avoid_: vignette, vignetting (too narrow, the field covers more than the lens), per-frame correction

**Radial term**:
The part of the shading field that falls off symmetrically from the frame centre, which is what a
lens actually does. The **asymmetric terms** are the rest, describing departures from it, and they
are held near zero unless the overlaps genuinely demand otherwise.
_Avoid_: vignette term, first coefficient

**Anchor region**:
The frame centres, sampled before correction and again after, so the set's overall brightness can be
put back where it started. Centres rather than whole frames, because the centre is the part the lens
did not darken.
_Avoid_: reference pixels, baseline, control region

**Drift**:
The one degree of freedom the overlaps cannot see: scaling every frame's gain together satisfies
every pair constraint equally well. Left alone, the solve takes it, usually darker.
_Avoid_: washout, global bias, collapse

**Verdict**:
What the shading stage concluded and reported — that shading was found and removed, that none was
found, or that a fit was found and refused. A stage that declines to act says so rather than staying
silent.
_Avoid_: status, result, flag

**Wander**:
How far the brightness of a nominally uniform region, typically sky, travels across the finished
panorama. A number to look at beside the image, never a number to pass or fail against; see
[ADR-0003](docs/adr/0003-evenness-is-information-not-a-gate.md).
_Avoid_: ripple, banding, unevenness

## Edges

**Ragged edges**:
The uneven border a hand-held sweep leaves behind, where the union of the placed frames is not a
rectangle.
_Avoid_: borders, empty space, alpha

**Painted in**:
Pixels produced by interpolating the surrounding real pixels rather than photographed. The honest
word: the panel reports what share of the frame is painted in, and never quietly presents it as
photography.
_Avoid_: inpainted, generated, reconstructed, filled

**Invented share**:
The percentage of the delivered frame that is painted in. The user sets a ceiling and the crop is
chosen to respect it.
_Avoid_: fill ratio, coverage gap, padding

**Seed**:
A real pixel the paint-in grows from. Structure sitting at the edge of coverage — a lamp post, a
cable, a treetop — is refused as a seed, or it streaks across everything invented.
_Avoid_: source pixel, sample

## Relationships

- A **Burst** holds many **Frames**, ordered by **Capture time**, and produces one panorama.
- **Frames** in no **Burst** are **Loose shots**.
- A **Burst** and its panorama are gathered into one **Collected folder**.
- A **Frame** connects to other **Frames** through **Links**; exactly one is the **Anchor frame**.
- Two linked **Frames** share an **Overlap**, and every photometric measurement is made there.
- Each **Frame** carries one **Log gain** per channel; the **Shading field** is shared by all of them.
- A pixel's correction from the **Shading field** depends on its **Frame-local position**.
- **Coverage** is where the real pixels are; what falls outside it is **Painted in** or cropped away.

## Flagged ambiguities

- "vignette" was used both for the lens's own falloff and for the whole across-frame brightness
  variation. Resolved: the thing being fitted is the **Shading field**, and the lens's contribution
  is its **Radial term**.
- "wander" and "ripple" both named the sky-evenness number, the first in prose and the second in the
  test output. Resolved: the term is **Wander**; the code identifier has not been renamed to match.
- "fill" named both the act of inventing pixels and one of the three ragged-edge settings. Resolved:
  the act is **Painting in**, and "fill" is reserved for the setting that paints the whole frame.
- "group" and "burst" both named a run of frames from one sweep, and "group" also named the act of
  splitting a directory into them. Resolved: the noun is a **Burst**; grouping is what produces them.
- "anchor" named both the frame others are placed against and the pixels used to pin brightness.
  Resolved: **Anchor frame** for placement, **Anchor region** for brightness, and neither is
  shortened to "anchor" on its own.
