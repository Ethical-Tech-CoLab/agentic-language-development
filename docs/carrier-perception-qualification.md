# Carrier Perception Qualification

This qualification covers a deliberately narrow part of the E13 analysis path. It
tests deterministic carrier-specific distances and held-out nearest-prototype
scoring for bitmap, canvas, and tone marks on synthetic fixtures. The protocol and
generated receipt bind the implementation to exact source hashes and to a clean,
detached v0.1.71 validation.

The bitmap distance is normalized cell Hamming distance. Canvas marks are rasterized
on the registered 16-by-16 grid and compared over a fixed plus-or-minus-one-cell
translation window. Tone marks use a normalized sequence edit cost with graded pitch
and duration substitutions. The evaluation uses deterministic distance, family, and
identifier ordering and reports exact structural novelty separately from distance.

The first canvas positive control failed under raw raster Hamming: a translated
within-family stroke was ranked farther away than a crossing-family stroke. That
failure is retained in the receipt. The fixed translation window corrected this
specific diagnostic defect without redefining a transformed mark as an exact copy.

All three synthetic carriers recover two intended families with two novel queries
each. Six negative controls reject cross-carrier comparison, malformed carrier data,
ambiguous identifiers, and uncovered query labels. These are deterministic software
controls, so their perfect accuracy is not an empirical learner result.

The qualification does not show that either learner acquired this metric, inferred
a transformation rule, generalized on production-held-out forms, communicated more
successfully, or avoided forbidden metadata, timing, envelope, container, dimension,
sample-rate, or compression paths. B09 and E13 therefore remain open.
