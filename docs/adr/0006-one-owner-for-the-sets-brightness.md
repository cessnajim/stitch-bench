# One owner for the set's brightness

How bright the set comes out overall is the drift: the one degree of freedom the overlaps cannot
see. Three separate things were deciding it. A factor inside the exposure stage held the blended
whole-frame mean, added in ADR-0005 under a name this project's glossary already told it to avoid.
The shading fit's per-frame term could carry a shift common to every frame. And an affine rescale
put back both the mean and the spread of the anchor region, clamped to 0.94–1.06 on spread and ±0.08
on an additive offset. Each read the others' output and corrected it again. On a real three-stop
sweep the rescale sat at its spread clamp of 0.94, cutting contrast that nothing had asked it to
cut.

The set's brightness now has one owner, the anchor gain: a single gain shared by every frame,
chosen so the anchor region's mean linear brightness comes out where it went in. It is
multiplicative only. There is no spread term, because a stage that settles the drift has no business
changing contrast. There is no offset, because an additive term does not commute with gains and
cannot be undone by any exposure. The rescale is gone. The exposure stage now pins its gauge and
nothing more.

The anchor gain is re-asserted after each stage that can move the set — once after exposure, once
after shading — rather than run once at the end. Both fits set aside near-black and near-white
pixels by absolute value, so they should see the set where it is going to finish. Applying one rule
twice is still one owner. The two applications multiply into the single figure reported as
`anchor_gain_stops`.

The anchor region is the frame centres, not the whole frame. That was already the design the
rescale argued for, and the ADR-0005 factor quietly departed from it by holding the whole frame.
Centres are the part the lens did not darken, so taking out falloff gives light back to the corners
rather than pulling the middle down to meet them.

## Evidence

Scored against synthetic ground truth, as ADR-0003 requires. The reconstruction figures are block
errors after dividing out one global gain. They measure what the old rescale added and no single
gain can undo: a change of spread, and an offset.

| synthetic case                    | before | after |
|-----------------------------------|--------|-------|
| half-stop exposure, rms           | 1.89   | 0.42  |
| exposure + vignetting, rms        | 9.07   | 7.65  |
| three-stop sweep, rms             | 4.68   | 0.90  |
| worst recovered gain, both ramps  | 0.0%   | 0.0%  |
| drift, exposure only              | 0.8%   | 1.4%  |
| drift, vignette case              | −2.7%  | −1.5% |

On the real seventeen-frame sweep (0–255, whole panorama rendered at quarter scale, cropped to
photographed pixels):

| measure               | uncorrected | before     | after      |
|-----------------------|-------------|------------|------------|
| whole-frame mean      | 131.2       | 124.4      | 120.7      |
| whole-frame spread    | 46.5        | 66.1       | 72.1       |
| top 30% mean          | 154.5       | 191.0      | 192.8      |
| bottom 40% mean       | 122.9       | 85.0       | 78.2       |
| shared gain           | —           | −0.57 stop | −0.58 stop |
| clipped pixels        | 0.01%       | 0%         | 0%         |

The shared gain barely moved. What changed is the 6% the rescale had been taking out of the spread,
which shows up as more contrast and a whole-frame mean 3 levels lower. A real set cannot say which
of the two is right. Synthetic ground truth can, and it prefers this one in every case above except
exposure-only drift, which moved from 0.8% to 1.4% against an allowance of 4%. `real.test.js`'s
sky-only brightness check goes from 172.4 to 210.7, against 207.6 before. It fails either way, for
the reason ADR-0005 gives: matching a wide sweep moves brightness from foreground to sky.

## Consequences

Nothing else in the photometric path may move the set's brightness. A new stage that needs it
elsewhere should say why here first.

Two things were left alone deliberately. The shading fit still pins its per-frame term with a prior
per frame, the same over-constraint ADR-0005 removed from exposure. Changing it changes the
comparison that gates the shading fit, and ADR-0002 says only real photographs show a gate failing.
Its common shift is absorbed by the anchor gain now, but the inward bias on its per-frame residuals
is not. The low-frequency correction field is additive and local. It pulls each frame toward the
blend, so it should redistribute brightness rather than move the whole set, but that has not been
measured.

The output field `level_stops` is now `anchor_gain_stops`.
