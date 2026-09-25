# The exposure gauge is one row, and the level is chosen separately

[ADR-0001](0001-log-gains-not-gain-and-offset.md) settles that exposure is solved as log gains and
notes that the one remaining degree of freedom — the same constant added to every log gain — is
pinned by a prior. It is one degree of freedom, so it takes one row to pin. The implementation used
N, one per frame, each pulling that frame's log gain toward zero. The surplus N-1 rows are not gauge
fixing: they are a prior asserting that every frame was exposed alike, and they pull the frames
toward each other.

On a set that was exposed alike, the bias is invisible. On a wide auto-exposure sweep it is not. A
seventeen-frame sweep from open water into dark trees, shot in aperture priority with auto ISO,
spans 3.35 stops between its ends — ISO 100 at 1/640 to ISO 320 at 1/200. The clamps at 0.45 and 2.2
spanned only 2.29 stops, and the frames at the ends of the sweep sat on them: the per-frame changes
it reported, −78.5% on two frames and +27.4% on three, work back to gains of 0.450 and 2.15 if the
rescale below was at its limits too. That condition is inferred, not read: it is the one that makes
the reported figures come out exactly, and repeated identical values across different frames are
what a clamp leaves behind. The same failure is measured cleanly on a synthetic three-stop
ramp, where the worst recovered gain was 27.2% away from the ratio the frame was damaged by. The
half-stop case already in the synthetic suite could not see any of this, because 1.35 and 0.72 sit
inside the rails with room to spare.

That ramp also comes back about 27% darker than the scene it was cut from, and it did so with the
gauge fixed as well as without — −26.5% against −26.8%, measured before the level step below existed. The rescale re-anchors the set to its own brightness, and a ramp damaged by
darkening alone is darker than the original, so this drift is the rescale doing its job rather than
a symptom of the bias.

The gauge is now a single sum-to-zero row, with a faint per-frame ridge beneath it that exists only
to keep the system solvable when the overlap graph is disconnected and no chain of pairs relates one
group of frames to another. The rails moved to 0.125 and 8, far enough out to hold a six-stop set
without touching it, which leaves them what they were meant to be: a guard against a solve that has
run away, not a statement about what cameras do.

Sum-to-zero fixes the gauge but not the level. It puts the log gains either side of zero, so their
geometric mean is one — and light averages arithmetically, so a frame lifted 2.8x brings in far more
of it than one held back to 0.35 takes out. Without anything further, the real sweep's sky measure
rose from 172 to 235. The level is therefore chosen after the solve, as the single factor that
leaves the set's linear mean, read the way the blend will read it, where it was. It is common to
every frame, which is exactly the freedom the pair rows never constrained, so nothing about how the
frames agree moves with it. It is set before the rescale and shading stages run, and they move the
result afterwards; end to end, on the real sweep, the panorama's overall mean went from 131.2 to
124.4.

Matching the encoded mean instead of the linear one was tried and not kept. The argument for it is
sound as far as it goes — encoding is concave, so closing the spread between frames raises the
average of the encoded pixels even when the light is unchanged. Measured the same way as above, that
version ended with the panorama's overall mean at 102.2, down 22%, against 124.4 for the linear
version. Why is not established. It was not a matter of this stage's level running high: the level
it chose was 0.83, below one. The rescale sat on its lower clamp in both runs, and beyond that the
difference between them has not been traced. Nor was the encoded version scored against synthetic
ground truth, which ADR-0003 requires of anything adopted; it was rejected on overall brightness on
one real set, and that is the extent of the evidence.

## Consequences

The exposure solve now tracks a spread instead of merely surviving one, and `test/synthetic.test.js`
scores it by comparing recovered gains against the ratios the frames were damaged by, normalised to
their geometric mean so the level is not part of the comparison. A reconstruction score cannot do
this job alone: it carries the level too, and the level is chosen on separate grounds.

Two stages below this one still renormalise, each with its own clamps — the affine that puts the
mean and spread back, and the shading fit. On the real sweep the affine's spread term sits at its
floor of 0.94, with or without the encoded variant. That is a finding, not an explanation of
anything above. Whatever replaces these stages should own the level outright rather than adding a
fourth correction on top.

Matching a wide sweep moves brightness between the parts of the scene the camera metered
differently, and nothing about that is forced by bit depth: on the real sweep nothing clips before
or after. What happens is redistribution. With the overall mean held to within 5%, the top 30% of
the panorama went from 154.5 to 191.0 and the bottom 40% from 122.9 to 85.0 — the camera had held
the sky down and lifted the trees, and matching the frames undoes both. A different level would
hold the sky where it was, by darkening the foreground further; which region to hold is a choice
about the picture, not a limit of the format.

`test/real.test.js` checks brightness on flat sky alone, and on this sweep it fails before and after
the change (172.4 to 221.2 before, 207.6 after, against a 15% allowance). Given the redistribution
above, a sky-only check is measuring where the level was put as much as whether brightness was
kept. Whether it should look at the whole frame for wide sweeps is an open question; its threshold
has not been moved.
