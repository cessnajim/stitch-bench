# The shading fit must earn its place

A shading fit that latches onto scene structure leaves a panorama worse than no correction at all,
so the fit is not trusted on the strength of its own residual. Half the overlap samples train it and
the other half judge it against a plain per-frame-exposure model: real shading generalises to the
half it never saw, and a coincidence of the scene does not. Two further gates sit on top. A fit
implying a corner falloff stronger than any real lens produces is refused as implausible, and the
correction is applied only when at least two of the three channels prefer it, because a lens does
not shade one channel only.

## Consequences

The stage can decline, and reports which of the three things happened rather than staying silent.

Loosening any one of the three gates will mark more panoramas as corrected and some of them will be
worse, which the synthetic tests will not necessarily catch: synthetic damage is real shading by
construction, so it always generalises to the held-out half. The gates exist for real photographs,
and only real photographs can show them failing.
