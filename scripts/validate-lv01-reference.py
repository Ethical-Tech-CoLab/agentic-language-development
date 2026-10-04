#!/usr/bin/env python3
"""Independent numpy/scipy numerical reference for the frozen LV01 power rules.

Port of the retired validate-lv01-reference R script to Python/scipy.
Pure numpy/scipy: no repository imports, so it stays an independent check.

CLI/IO contract (mirrors the R script):
  argv: exactly one argument, <upper-sd>, a positive finite float.
  stdout: 43 lines; first "factor,<%.17g>", then one "n,component,critical,power"
    line per (n, component) pair, n in (75, 100, 125, 150, 200, 300).
  stderr/exit: usage/validation failures print a message to stderr and exit 1
    (R stop() semantics).
"""

import math
import sys

from scipy import stats

COMPONENTS = (
    ("incremental", 0.04, 0.02),
    ("fidelity", -0.01, -0.02),
    ("disabled", 0.10, 0.05),
    ("constant", 0.10, 0.05),
    ("random", 0.10, 0.05),
    ("shuffled", 0.10, 0.05),
    ("intervention", 0.10, 0.05),
)
NS = (75, 100, 125, 150, 200, 300)


def main(argv: list) -> int:
    if len(argv) != 2:
        print("usage: validate-lv01-reference.py <upper-sd>", file=sys.stderr)
        return 1
    try:
        sd = float(argv[1])
    except ValueError:
        sd = float("nan")
    if not math.isfinite(sd) or sd <= 0:
        print("upper-sd must be positive and finite", file=sys.stderr)
        return 1

    # R: sqrt(19 / qchisq(.05 / 7, 19)) -- lower-tail chi-square quantile.
    factor = math.sqrt(19.0 / stats.chi2.ppf(0.05 / 7.0, 19))
    sys.stdout.write("factor,%.17g\n" % factor)
    for n in NS:
        # R: qt(1 - .05 / 4, n - 1)
        critical = stats.t.ppf(1.0 - 0.05 / 4.0, n - 1)
        sqrt_n = math.sqrt(n)
        for comp_id, alternative, boundary in COMPONENTS:
            delta = (alternative - boundary) / sd
            # R: pt(critical, n - 1, ncp = sqrt(n) * delta, lower.tail = FALSE)
            power = stats.nct.sf(critical, n - 1, sqrt_n * delta)
            sys.stdout.write("%d,%s,%.17g,%.17g\n" % (n, comp_id, critical, power))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
