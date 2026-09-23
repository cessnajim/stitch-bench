# Evenness is information, not a gate

An earlier build claimed a 41% reduction in sky wander on a real 26-frame set. The number was
measured in absolute levels, which means anything reducing contrast scores well: a build that merely
darkened the whole panorama looked good, and a genuinely broken solve with every gain pinned at its
clamp scored best of all. Absolute measures of evenness flatter exactly the failures this pipeline
is most prone to, so no such measure gates anything.

## Consequences

`test/real.test.js` still prints the wander number, beside the image, as something to look at. What
it asserts instead is that overall brightness is preserved, which is the check with teeth.

Ground truth lives in `test/synthetic.test.js`, where a known-good original exists to compare
against. A set of real photographs has no such original, and no number derived from the output alone
can stand in for one. A proposed improvement to the photometric stages is measured against synthetic
ground truth or it is not measured.
