# Per-frame exposure is solved as log gains

Exposure is a multiply on the light reaching the sensor, so the correction is a gain, and the solve
is written in log space where only differences between frames appear. The obvious alternative,
matching `gain × mean + offset` between frames, is degenerate: shrinking every gain toward zero
satisfies it just as well, and with enough overlapping pairs outvoting the priors that is the
solution a solver takes, pinning every frame at its clamp and washing the panorama out. In log space
the one remaining degree of freedom is a single constant shift, which a prior pins cleanly.

## Consequences

There is no per-frame offset term anywhere in the photometric path, and adding one reintroduces the
degeneracy. A frame needing a lift in the shadows but not the highlights cannot be expressed: that
is a tone curve, and this stage does not fit one.
