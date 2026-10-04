#!/usr/bin/env python3
"""Python/scipy port of the retired validate-leakage-design R script (D06 operating characteristics).

Independent, outcome-blind operating-characteristic calculations for the
causal-ledger / leakage design protocol. Pure NumPy/SciPy + stdlib so the
receipt shares no implementation code with the TypeScript leakage evaluators.

CLI contract (mirrors the retired R script):
    python validate-leakage-design.py [output_path]
    - output_path defaults to "reports/research/leakage-design-validation.tsv"
      resolved against the current working directory.
    - The output is a tab-separated file with header
      "experiment\\tcase\\tmetric\\tvalue\\tn\\tassumption" and 6 data rows,
      one "\\n" per line, no quoting, trailing newline after the last row.

Value formatting replicates R write.table/as.character numeric coercion
("%.15g", 15 significant digits). The R script's options(digits = 16) has no
effect on write.table output (see the port report).

Deterministic: no RNG is used anywhere; outputs depend only on the
numpy/scipy implementations of the normal/t quantiles, binomial pmf, and
noncentral-t CDF.
"""

import sys

import numpy as np
from scipy import stats

CONFIDENCE = 0.90

N = 200
BASELINE = 0.25
MAXIMUM_ADVANTAGE = 0.10
POSITIVE_MINIMUM_ADVANTAGE = 0.20

AFFECT_N = 75
AFFECT_SD = 0.04
AFFECT_BOUND = 0.02
ALPHA = 0.05

HEADER = "experiment\tcase\tmetric\tvalue\tn\tassumption"


def wilson_bounds(successes, n, confidence=CONFIDENCE):
    """Wilson score interval as (lower, upper), clamped to [0, 1]."""
    z = stats.norm.ppf(1 - (1 - confidence) / 2)
    observed = successes / n
    denominator = 1 + z**2 / n
    center = (observed + z**2 / (2 * n)) / denominator
    half = z / denominator * np.sqrt(observed * (1 - observed) / n + z**2 / (4 * n**2))
    return (max(0.0, center - half), min(1.0, center + half))


def binomial_probability(n, p, predicate):
    """Sum of Binomial(n, p) pmf over counts satisfying predicate (ascending)."""
    counts = np.arange(n + 1)
    pmf = stats.binom.pmf(counts, n, p)
    passing = pmf[predicate(counts)]
    return float(sum(passing))


def negative_clearance(counts):
    return np.array(
        [wilson_bounds(int(x), N)[1] <= BASELINE + MAXIMUM_ADVANTAGE for x in counts]
    )


def positive_detection(counts):
    return np.array(
        [
            wilson_bounds(int(x), N)[0] - BASELINE >= POSITIVE_MINIMUM_ADVANTAGE
            for x in counts
        ]
    )


CRITICAL = stats.t.ppf(ALPHA, AFFECT_N - 1)


def clearance_power(true_mean):
    ncp = (true_mean - AFFECT_BOUND) * np.sqrt(AFFECT_N) / AFFECT_SD
    return float(stats.nct.cdf(CRITICAL, AFFECT_N - 1, ncp))


def build_rows():
    e02 = [
        (
            "E02",
            "chance-clearance",
            "probability-clear-bound",
            binomial_probability(N, 0.25, negative_clearance),
            N,
            "true accuracy 0.25",
        ),
        (
            "E02",
            "margin-boundary-type-i",
            "probability-clear-bound",
            binomial_probability(N, 0.35, negative_clearance),
            N,
            "true accuracy 0.35",
        ),
        (
            "E02",
            "positive-control-detection",
            "probability-detect",
            binomial_probability(N, 1.0, positive_detection),
            N,
            "deterministic injected target-label feature; true accuracy 1",
        ),
    ]
    e20 = [
        (
            "E20",
            "zero-excess-clearance",
            "probability-clear-bound",
            clearance_power(0.0),
            AFFECT_N,
            "normal seed excess CMI; mean 0 bits; SD 0.04 bits",
        ),
        (
            "E20",
            "margin-boundary-type-i",
            "probability-clear-bound",
            clearance_power(AFFECT_BOUND),
            AFFECT_N,
            "normal seed excess CMI; mean 0.02 bits; SD 0.04 bits",
        ),
        (
            "E20",
            "positive-control-detection",
            "probability-not-clear",
            1 - clearance_power(0.04),
            AFFECT_N,
            "normal seed excess CMI; mean 0.04 bits; SD 0.04 bits",
        ),
    ]
    return e02 + e20


def format_value(value):
    """R as.character/%.15g numeric formatting used by write.table."""
    return format(float(value), ".15g")


def main(argv):
    output = argv[1] if len(argv) >= 2 else "reports/research/leakage-design-validation.tsv"
    lines = [HEADER]
    for experiment, case, metric, value, n, assumption in build_rows():
        lines.append(
            f"{experiment}\t{case}\t{metric}\t{format_value(value)}\t{n:d}\t{assumption}"
        )
    with open(output, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
