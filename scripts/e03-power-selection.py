#!/usr/bin/env python3
"""Python/scipy port of the retired e03-power-selection R script.

Separately implemented, bounded power calculation for the E03 full numeric
qualification rule. Consumes one outcome-blind pilot dispersion value; it does
not read experiment outcomes or evaluate a scientific hypothesis.

CLI contract (mirrors the retired R script exactly):
    e03-power-selection.py <output.tsv> <largest-latent-sd> <primary-seeds>

Output: TSV file with a header line plus exactly one data row; columns:
    largest_latent_pilot_sd, primary_seeds, repetitions, simulation_seed,
    numeric_successes, numeric_power, numeric_lower95, numeric_upper95,
    invalid_as_failure_count, invalid_as_failure_successes,
    invalid_as_failure_power, invalid_as_failure_lower95,
    invalid_as_failure_upper95

Dependencies: numpy, scipy only. No repository imports.

RNG NOTE: the R script uses R's Mersenne-Twister stream via set.seed(); this
port uses numpy's default_rng (PCG64) seeded with the same simulation_seed
(20260913 + n). Monte-Carlo estimates are therefore seed-sensitive: point and
interval estimates will differ from R's in the last digits but estimate the
same quantities. Only the seed/count columns reproduce exactly.
"""

import math
import sys

import numpy as np
from scipy import stats

TABLE_SDS = (0.05, 0.10, 0.15, 0.20)
TABLE_SEEDS = (25, 75, 155, 300)

REPETITIONS = 30000
BASE_SEED = 20260913
EPISODES_PER_SLOT = 200

TOST_LOWER = 0.20
TOST_UPPER = 0.30
CONTROL_MEAN = 0.25
ORACLE_MEAN = 0.98
ORACLE_SD = 0.01
ORACLE_ADEQUACY_NULL = 0.90
SEPARATION_NULL = 0.60
ALPHA = 0.05
N_CONTROLS = 5


def fail(message):
    """Mirror R stop(): message on stderr, nonzero exit."""
    print(f"{message}", file=sys.stderr)
    raise SystemExit(1)


def select_seeds(latent_sd):
    """First frozen-table row whose SD cap covers latent_sd, else None."""
    for cap, seeds in zip(TABLE_SDS, TABLE_SEEDS):
        if latent_sd <= cap:
            return seeds
    return None


def beta_shapes(mean, sd):
    """Beta (a, b) with the given mean/sd via method-of-moments precision."""
    precision = mean * (1.0 - mean) / sd**2 - 1.0
    if precision <= 0:
        fail("latent SD is infeasible for beta distribution")
    return mean * precision, (1.0 - mean) * precision


def draw_rates(rng, mean, sd, repetitions, n):
    """Simulate per-seed success rates: (repetitions, n) array in [0, 1].

    Beta-binomial hierarchy: latent ~ Beta(a, b) per (repetition, seed),
    then Binomial(200, latent) / 200. With sd == 0 the latent layer is
    skipped (pure binomial), exactly like the R script.
    """
    if sd == 0:
        draws = rng.binomial(EPISODES_PER_SLOT, mean,
                             size=(repetitions, n))
        return draws / EPISODES_PER_SLOT
    a, b = beta_shapes(mean, sd)
    latent = rng.beta(a, b, size=(repetitions, n))
    draws = rng.binomial(EPISODES_PER_SLOT, latent)
    return draws / EPISODES_PER_SLOT


def row_sd(x, n):
    """Sample SD of each row (n - 1 denominator), mirroring the R formula."""
    means = x.mean(axis=1)
    var = (np.square(x).sum(axis=1) - n * means**2) / (n - 1)
    return np.sqrt(np.maximum(0.0, var))


def one_sided_p(x, null, alternative, n):
    """One-sided one-sample t-test p-value per row."""
    with np.errstate(divide="ignore", invalid="ignore"):
        statistic = (x.mean(axis=1) - null) / (row_sd(x, n) / math.sqrt(n))
    if alternative == "greater":
        return stats.t.sf(statistic, n - 1)
    return stats.t.cdf(statistic, n - 1)


def tost_p(x, n):
    """Two one-sided tests p-value per row against the [0.20, 0.30] bounds."""
    return np.maximum(one_sided_p(x, TOST_LOWER, "greater", n),
                      one_sided_p(x, TOST_UPPER, "less", n))


def all_holm_rejected(p_matrix, alpha=ALPHA):
    """True per row iff Holm-Bonferroni rejects every hypothesis in the row."""
    ordered = np.sort(p_matrix, axis=1)
    m = ordered.shape[1]
    thresholds = alpha / np.arange(m, 0, -1)
    return bool_row_all(ordered <= thresholds)


def bool_row_all(mask):
    return mask.all(axis=1)


def wilson(successes, total):
    """Wilson 95% score interval for a binomial proportion."""
    z = stats.norm.ppf(0.975)
    p = successes / total
    denominator = 1.0 + z**2 / total
    center = (p + z**2 / (2.0 * total)) / denominator
    half = z / denominator * math.sqrt(p * (1.0 - p) / total +
                                       z**2 / (4.0 * total**2))
    return float(max(0.0, center - half)), float(min(1.0, center + half))


def evaluate_rule(controls, oracle, n):
    """Full numeric qualification rule; returns per-repetition pass flags."""
    control_p = np.column_stack([tost_p(control, n) for control in controls])
    controls_pass = all_holm_rejected(control_p)
    oracle_pass = one_sided_p(oracle, ORACLE_ADEQUACY_NULL, "greater", n) < ALPHA
    separation_p = np.column_stack(
        [one_sided_p(oracle - control, SEPARATION_NULL, "greater", n)
         for control in controls])
    separation_pass = all_holm_rejected(separation_p)
    return controls_pass & oracle_pass & separation_pass


def simulate(latent_sd, n, repetitions=REPETITIONS):
    """Run the Monte-Carlo power simulation; returns the result-row dict."""
    simulation_seed = BASE_SEED + n
    rng = np.random.default_rng(simulation_seed)

    controls = [draw_rates(rng, CONTROL_MEAN, latent_sd, repetitions, n)
                for _ in range(N_CONTROLS)]
    oracle = draw_rates(rng, ORACLE_MEAN, ORACLE_SD, repetitions, n)

    numeric_pass = evaluate_rule(controls, oracle, n)
    numeric_successes = int(numeric_pass.sum())
    numeric_interval = wilson(numeric_successes, repetitions)

    invalid_count = math.ceil(0.05 * n)
    for control in controls:
        control[:, :invalid_count] = 0.0
    oracle[:, :invalid_count] = 0.0
    worst_pass = evaluate_rule(controls, oracle, n)
    worst_successes = int(worst_pass.sum())
    worst_interval = wilson(worst_successes, repetitions)

    return {
        "largest_latent_pilot_sd": latent_sd,
        "primary_seeds": n,
        "repetitions": repetitions,
        "simulation_seed": simulation_seed,
        "numeric_successes": numeric_successes,
        "numeric_power": numeric_successes / repetitions,
        "numeric_lower95": numeric_interval[0],
        "numeric_upper95": numeric_interval[1],
        "invalid_as_failure_count": invalid_count,
        "invalid_as_failure_successes": worst_successes,
        "invalid_as_failure_power": worst_successes / repetitions,
        "invalid_as_failure_lower95": worst_interval[0],
        "invalid_as_failure_upper95": worst_interval[1],
    }


COLUMNS = (
    "largest_latent_pilot_sd",
    "primary_seeds",
    "repetitions",
    "simulation_seed",
    "numeric_successes",
    "numeric_power",
    "numeric_lower95",
    "numeric_upper95",
    "invalid_as_failure_count",
    "invalid_as_failure_successes",
    "invalid_as_failure_power",
    "invalid_as_failure_lower95",
    "invalid_as_failure_upper95",
)


def format_value(value):
    if isinstance(value, (float, np.floating)):
        return repr(float(value))
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    return str(value)


def main(argv):
    prog = "e03-power-selection.py"
    if len(argv) != 4:
        fail(f"usage: {prog} <output.tsv> <largest-latent-sd> <primary-seeds>")
    output, sd_arg, n_arg = argv[1], argv[2], argv[3]

    try:
        latent_sd = float(sd_arg)
    except ValueError:
        latent_sd = float("nan")
    try:
        n_float = float(n_arg)
        n = int(n_float) if n_float.is_integer() else None
    except ValueError:
        n = None

    selected = (select_seeds(latent_sd)
                if math.isfinite(latent_sd) else None)
    if (not math.isfinite(latent_sd) or latent_sd < 0 or latent_sd > 0.20
            or selected is None or n != selected):
        fail("pilot dispersion and primary seed count do not match "
             "the frozen E03 table")

    result = simulate(latent_sd, n)
    with open(output, "w", encoding="utf-8") as handle:
        handle.write("\t".join(COLUMNS) + "\n")
        handle.write("\t".join(format_value(result[col]) for col in COLUMNS)
                     + "\n")


if __name__ == "__main__":
    main(sys.argv)
