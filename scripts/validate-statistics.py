#!/usr/bin/env python3
"""Independent numerical and operating-characteristic validation (numpy/scipy port).

Pure-Python port of the retired validate-statistics R script using only numpy/scipy (plus the
standard library), so its distribution functions, random generators, and interval
implementations are independent of the TypeScript analysis package. It produces
design evidence, never study data.

CLI contract (mirrors the retired R script):
    python validate-statistics.py [outputPath]
    - outputPath defaults to "reports/research/statistical-validation.tsv"
    - writes a TSV with header: category case metric value mc_n lower95 upper95
      (tab-separated, NA rendered as "", parent directories created as needed)
    - prints "Wrote <path> (<n> validation rows) ..." to stdout

RNG note: R uses set.seed(20260911) with Mersenne-Twister; this port uses
numpy.random.default_rng(20260911) (PCG64). All Monte Carlo rows are therefore
seed/stream-sensitive and will differ numerically from the R receipt while
estimating the same quantities. Reference (analytic) rows should agree with R
to ~1e-12 except the beta-binomial optimizer fit (~1e-3, different optimizer).
"""

import os
import sys

import numpy as np
from scipy import optimize, special, stats

SEED = 20260911
rng = np.random.default_rng(SEED)

Z95 = stats.norm.ppf(0.975)

rows = []


def add_row(category, case, metric, value, mc_n=None, lower95=None, upper95=None):
    rows.append((category, case, metric, float(value), mc_n, lower95, upper95))


def mc_interval(successes, n, confidence=0.95):
    """Wilson score interval for a binomial proportion (== R mc_interval)."""
    z = stats.norm.ppf(1 - (1 - confidence) / 2)
    p = successes / n
    denominator = 1 + z**2 / n
    center = (p + z**2 / (2 * n)) / denominator
    half = z / denominator * np.sqrt(p * (1 - p) / n + z**2 / (4 * n**2))
    lo, hi = max(0.0, center - half), min(1.0, center + half)
    # The true Wilson endpoint equals the observed 0/1 exactly when successes
    # are 0/n; without this, 1-ulp sqrt noise can put value outside [lo, hi]
    # (R's max/min only clamp outward noise). Same math, exact endpoints.
    if successes == 0:
        lo = 0.0
    if successes == n:
        hi = 1.0
    return (lo, hi)


def add_mc(category, case, metric, successes, n):
    lo, hi = mc_interval(successes, n)
    add_row(category, case, metric, successes / n, int(n), float(lo), float(hi))


def quantile_type7(x, probs):
    """R quantile(x, probs, type=7): h=(n-1)p+1 linear interpolation."""
    xs = np.sort(np.asarray(x, dtype=float))
    n = xs.size
    parr = np.atleast_1d(np.asarray(probs, dtype=float))
    out = np.empty(parr.shape)
    for k, p in enumerate(parr):
        if p <= 0:
            out[k] = xs[0]
        elif p >= 1:
            out[k] = xs[-1]
        else:
            h = (n - 1) * p + 1  # 1-indexed
            j = int(np.floor(h))
            g = h - j
            out[k] = (1 - g) * xs[j - 1] + g * xs[j]
    return out[0] if np.ndim(probs) == 0 else out


def holm_adjust(p):
    """R p.adjust(p, method='holm') for a 1-D array."""
    p = np.asarray(p, dtype=float)
    n = p.size
    order = np.argsort(p, kind="mergesort")
    ranked = p[order] * np.arange(n, 0, -1)
    adjusted_sorted = np.minimum(1.0, np.maximum.accumulate(ranked))
    out = np.empty(n)
    out[order] = adjusted_sorted
    return out


def all_holm_rejected(p_matrix, alpha=0.05):
    """Row-wise all(p.adjust Holm <= alpha); == R all_holm_rejected."""
    s = np.sort(np.asarray(p_matrix, dtype=float), axis=1)
    m = s.shape[1]
    adjusted_max = np.maximum.accumulate(s * np.arange(m, 0, -1), axis=1).max(axis=1)
    return adjusted_max <= alpha  # pmin(1, .) cannot change an alpha<1 verdict


def row_sd(x):
    """Sample SD per row (n-1 denominator, == R row_sd)."""
    return np.std(np.asarray(x, dtype=float), axis=1, ddof=1)


def one_sided_p(x, null, alternative):
    """Row-wise one-sample t p-value (== R one_sided_p)."""
    x = np.asarray(x, dtype=float)
    n = x.shape[1]
    means = x.mean(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        statistic = (means - null) / (row_sd(x) / np.sqrt(n))
    if alternative == "greater":
        return stats.t.sf(statistic, n - 1)
    return stats.t.cdf(statistic, n - 1)


def tost_p(x, lower, upper):
    return np.maximum(one_sided_p(x, lower, "greater"), one_sided_p(x, upper, "less"))


def beta_shapes(mean, latent_sd):
    precision = mean * (1 - mean) / latent_sd**2 - 1
    if precision <= 0:
        raise ValueError("latent SD is infeasible for beta distribution")
    return (mean * precision, (1 - mean) * precision)


def draw_rates(repetitions, seeds, mean, latent_sd, episodes):
    """Beta-binomial seed rates, == R draw_rates (RNG streams differ)."""
    a, b = beta_shapes(mean, latent_sd)
    latent = rng.beta(a, b, size=(repetitions, seeds))
    return rng.binomial(episodes, latent) / episodes


def entropy_bits(counts):
    counts = np.asarray(counts, dtype=float)
    positive = counts[counts > 0]
    probabilities = positive / positive.sum()
    return float(-np.sum(probabilities * np.log2(probabilities)))


def miller_madow_bits(counts):
    counts = np.asarray(counts, dtype=float)
    return entropy_bits(counts) + (np.sum(counts > 0) - 1) / (2 * counts.sum() * np.log(2))


def main():
    output = sys.argv[1] if len(sys.argv) >= 2 else "reports/research/statistical-validation.tsv"

    # ---- Frozen numerical reference values for production functions. ----
    sample_values = np.array([0.24, 0.26, 0.25, 0.23, 0.27])

    def one_sample_t_against(mu, alternative):
        means = sample_values.mean()
        se = sample_values.std(ddof=1) / np.sqrt(sample_values.size)
        t = (means - mu) / se
        df = sample_values.size - 1
        p = stats.t.sf(t, df) if alternative == "greater" else stats.t.cdf(t, df)
        return t, p

    # one-sample t on shifted sample vs mu=0.25 (greater)
    shifted = sample_values + 0.10
    t_stat = (shifted.mean() - 0.25) / (shifted.std(ddof=1) / np.sqrt(shifted.size))
    t_p = stats.t.sf(t_stat, shifted.size - 1)
    tost_lower = one_sample_t_against(0.20, "greater")[1]
    tost_upper = one_sample_t_against(0.30, "less")[1]
    wilson_lo, wilson_hi = mc_interval(8, 10)  # == prop.test(8,10,correct=FALSE)$conf.int

    add_row("reference", "normal", "qnorm-0.975", stats.norm.ppf(0.975))
    add_row("reference", "student-t", "qt-0.975-df10", stats.t.ppf(0.975, 10))
    add_row("reference", "student-t", "pt-2.228138851964-df10", stats.t.cdf(2.228138851964, 10))
    add_row("reference", "one-sample-t", "t", t_stat)
    add_row("reference", "one-sample-t", "p-greater", t_p)
    add_row("reference", "tost", "p-lower", tost_lower)
    add_row("reference", "tost", "p-upper", tost_upper)
    add_row("reference", "tost", "p-max", max(tost_lower, tost_upper))
    holm = holm_adjust([0.01, 0.04, 0.03, 0.005])
    for i, value in enumerate(holm, start=1):
        add_row("reference", "holm", f"adjusted-{i}", value)
    add_row("reference", "wilson-8-of-10", "lower", wilson_lo)
    add_row("reference", "wilson-8-of-10", "upper", wilson_hi)
    add_row("reference", "binomial-4-of-5", "greater-p", stats.binom.sf(3, 5, 0.5))
    add_row("reference", "quantile-type7", "q-0.025", quantile_type7([0, 1, 2, 3, 4], 0.025))
    add_row("reference", "quantile-type7", "q-0.975", quantile_type7([0, 1, 2, 3, 4], 0.975))
    add_row("reference", "special", "lbeta-2-3", special.betaln(2, 3))

    x1 = np.array([1.2, 1.5, 1.7, 1.9, 2.2])
    x2 = np.array([0.8, 1.0, 1.1, 1.3, 1.4, 1.5])
    v1, v2 = x1.var(ddof=1) / x1.size, x2.var(ddof=1) / x2.size
    welch_t = (x1.mean() - x2.mean()) / np.sqrt(v1 + v2)
    welch_df = (v1 + v2) ** 2 / (v1**2 / (x1.size - 1) + v2**2 / (x2.size - 1))
    add_row("reference", "welch", "t", welch_t)
    add_row("reference", "welch", "df", welch_df)
    add_row("reference", "welch", "p-greater", stats.t.sf(welch_t, welch_df))

    add_row("reference", "entropy-2-3-5", "plugin-bits", entropy_bits([2, 3, 5]))
    add_row("reference", "entropy-2-3-5", "miller-madow-bits", miller_madow_bits([2, 3, 5]))
    joint = np.array([[10, 0], [0, 10]])
    plugin_mi = (
        entropy_bits(joint.sum(axis=1)) + entropy_bits(joint.sum(axis=0)) - entropy_bits(joint.ravel())
    )
    mm_mi = (
        miller_madow_bits(joint.sum(axis=1))
        + miller_madow_bits(joint.sum(axis=0))
        - miller_madow_bits(joint.ravel())
    )
    add_row("reference", "mutual-information-perfect-binary", "plugin-bits", plugin_mi)
    add_row("reference", "mutual-information-perfect-binary", "miller-madow-bits", mm_mi)

    beta_successes = np.array([1, 9, 2, 8, 5], dtype=float)
    beta_trials = np.full(5, 10.0)

    def nll(parameters):
        mu = special.expit(parameters[0])
        precision = np.exp(parameters[1])
        alpha, beta = mu * precision, (1 - mu) * precision
        return -float(
            np.sum(
                special.gammaln(beta_trials + 1)
                - special.gammaln(beta_successes + 1)
                - special.gammaln(beta_trials - beta_successes + 1)
                + special.betaln(beta_successes + alpha, beta_trials - beta_successes + beta)
                - special.betaln(alpha, beta)
            )
        )

    # R uses optim(..., method="BFGS", reltol=1e-13); scipy's BFGS has no
    # function-value reltol, and gtol << 1e-5 trips "precision loss" on this
    # flat optimum, so keep the default gradient tolerance (mu/precision agree
    # with Nelder-Mead to ~1e-6, well within the checker's 1e-3/1e-6 bands).
    beta_fit = optimize.minimize(nll, np.array([0.0, np.log(2.5)]), method="BFGS")
    if not beta_fit.success:
        raise RuntimeError(f"beta-binomial fit did not converge: {beta_fit.message}")
    add_row("reference", "beta-binomial-overdispersed", "mu", special.expit(beta_fit.x[0]))
    add_row("reference", "beta-binomial-overdispersed", "precision", np.exp(beta_fit.x[1]))
    add_row("reference", "beta-binomial-overdispersed", "log-likelihood", -beta_fit.fun)

    # ---- Interval coverage for bounded episode outcomes. ----
    coverage_repetitions = 30000
    counts = rng.binomial(200, 0.25, size=coverage_repetitions)
    observed = counts / 200
    denominator = 1 + Z95**2 / 200
    centers = (observed + Z95**2 / 400) / denominator
    halves = Z95 / denominator * np.sqrt(observed * (1 - observed) / 200 + Z95**2 / (4 * 200**2))
    add_mc(
        "coverage", "wilson-binomial-p0.25-n200", "contains-true-mean",
        int(np.sum((centers - halves <= 0.25) & (centers + halves >= 0.25))),
        coverage_repetitions,
    )

    seed_samples = draw_rates(coverage_repetitions, 25, 0.25, 0.05, 200)
    seed_means = seed_samples.mean(axis=1)
    seed_half = stats.t.ppf(0.975, 24) * row_sd(seed_samples) / 5
    add_mc(
        "coverage", "seed-t-beta-binomial-n25-sd0.05", "contains-true-mean",
        int(np.sum((seed_means - seed_half <= 0.25) & (seed_means + seed_half >= 0.25))),
        coverage_repetitions,
    )

    bootstrap_repetitions = 2000
    bootstrap_iterations = 999
    bootstrap_samples = draw_rates(bootstrap_repetitions, 25, 0.25, 0.05, 200)
    bootstrap_covered = np.empty(bootstrap_repetitions, dtype=bool)
    for i in range(bootstrap_repetitions):
        values = bootstrap_samples[i]
        indices = rng.integers(0, 25, size=(bootstrap_iterations, 25))
        means = values[indices].mean(axis=1)
        interval = quantile_type7(means, [0.025, 0.975])
        bootstrap_covered[i] = interval[0] <= 0.25 and interval[1] >= 0.25
    add_mc(
        "coverage", "percentile-bootstrap-beta-binomial-n25-sd0.05-b999", "contains-true-mean",
        int(np.sum(bootstrap_covered)), bootstrap_repetitions,
    )

    # ---- TOST size at both equivalence boundaries. ----
    # 300k reps (not 30k): the max-cell true size is 0.0120, exactly at the old
    # bar, so 30k could not distinguish truth from noise (see plans/decisions.md
    # 2026-10-04). The checker threshold is 0.013 = truth + 5x MC sigma.
    boundary_repetitions = 300000
    for n in (25, 75, 155, 300):
        lower_data = draw_rates(boundary_repetitions, n, 0.20, 0.05, 200)
        upper_data = draw_rates(boundary_repetitions, n, 0.30, 0.05, 200)
        add_mc("type-i", f"tost-lower-bound-n{n}", "declares-equivalence-alpha0.01",
               int(np.sum(tost_p(lower_data, 0.20, 0.30) < 0.01)), boundary_repetitions)
        add_mc("type-i", f"tost-upper-bound-n{n}", "declares-equivalence-alpha0.01",
               int(np.sum(tost_p(upper_data, 0.20, 0.30) < 0.01)), boundary_repetitions)

    # ---- Pseudoreplication stress test. ----
    cluster_repetitions = 30000
    clustered = draw_rates(cluster_repetitions, 25, 0.25, 0.10, 200)
    # R sums float rates*200; the true sums are integers and |fp error| << 1
    # cannot move P(X > pooled-1), so round to integers for the binomial tail.
    pooled_successes = np.rint(clustered * 200).sum(axis=1).astype(int)
    pooled_p = stats.binom.sf(pooled_successes - 1, 25 * 200, 0.25)
    seed_p = one_sided_p(clustered, 0.25, "greater")
    add_mc("clustering", "beta-binomial-n25-sd0.10", "pooled-episode-type-i",
           int(np.sum(pooled_p < 0.05)), cluster_repetitions)
    add_mc("clustering", "beta-binomial-n25-sd0.10", "seed-level-type-i",
           int(np.sum(seed_p < 0.05)), cluster_repetitions)

    # ---- Full E03 numerical rule under bounded beta-binomial data. ----
    design_repetitions = 10000
    for latent_sd, n in ((0.05, 25), (0.10, 75), (0.15, 155), (0.20, 300)):
        controls = [draw_rates(design_repetitions, n, 0.25, latent_sd, 200) for _ in range(5)]
        oracle = draw_rates(design_repetitions, n, 0.98, 0.01, 200)
        control_p = np.column_stack([tost_p(c, 0.20, 0.30) for c in controls])
        controls_pass = all_holm_rejected(control_p)
        oracle_pass = one_sided_p(oracle, 0.90, "greater") < 0.05
        separation_p = np.column_stack(
            [one_sided_p(oracle - c, 0.60, "greater") for c in controls]
        )
        separation_pass = all_holm_rejected(separation_p)
        numeric_pass = controls_pass & oracle_pass & separation_pass
        old_tail_pass = np.ones(design_repetitions, dtype=bool)
        for c in controls:
            old_tail_pass &= (c >= 0.35).mean(axis=1) <= 0.05
        label = f"n{n}-latent-sd{latent_sd:.2f}"
        add_mc("full-e03", label, "numeric-rule-power", int(np.sum(numeric_pass)), design_repetitions)
        add_mc("full-e03", label, "old-high-tail-cap-pass", int(np.sum(old_tail_pass)), design_repetitions)
        add_mc("full-e03", label, "old-complete-rule-power",
               int(np.sum(numeric_pass & old_tail_pass)), design_repetitions)

        if n == 75 and abs(latent_sd - 0.10) < 1e-12:
            invalid_count = int(np.ceil(0.05 * n))
            worst_controls = []
            for c in controls:
                w = c.copy()
                w[:, :invalid_count] = 0
                worst_controls.append(w)
            worst_oracle = oracle.copy()
            worst_oracle[:, :invalid_count] = 0
            worst_control_p = np.column_stack([tost_p(w, 0.20, 0.30) for w in worst_controls])
            worst_controls_pass = all_holm_rejected(worst_control_p)
            worst_oracle_pass = one_sided_p(worst_oracle, 0.90, "greater") < 0.05
            worst_separation_p = np.column_stack(
                [one_sided_p(worst_oracle - w, 0.60, "greater") for w in worst_controls]
            )
            worst_separation_pass = all_holm_rejected(worst_separation_p)
            add_mc("invalid-runs", "n75-sd0.10-five-percent-as-failures", "numeric-rule-power",
                   int(np.sum(worst_controls_pass & worst_oracle_pass & worst_separation_pass)),
                   design_repetitions)

    for q in (0.02, 0.05, 0.10):
        primary = 75
        reserves = int(np.ceil(0.10 * primary))
        one_condition = stats.binom.cdf(reserves, primary, q)
        add_row("invalid-runs", f"n75-reserve8-q{q:.2f}",
                "all-six-conditions-avoid-reserve-exhaustion", one_condition**6)

    # ---- Family-level sensitivity for nine independent one-sided tests. ----
    family_repetitions = 30000
    for n in (75, 100, 150):
        for d in (0.30, 0.40, 0.50):
            p_values = np.empty((family_repetitions, 9))
            for member in range(9):
                sample = rng.normal(d, 1.0, size=(family_repetitions, n))
                p_values[:, member] = one_sided_p(sample, 0, "greater")
            add_mc("confirmatory-family", f"n{n}-d{d:.2f}", "all-nine-holm-power",
                   int(np.sum(all_holm_rejected(p_values))), family_repetitions)

    directory = os.path.dirname(output)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        handle.write("category\tcase\tmetric\tvalue\tmc_n\tlower95\tupper95\n")
        for category, case, metric, value, mc_n, lo, hi in rows:
            handle.write(
                f"{category}\t{case}\t{metric}\t{value!r}\t"
                f"{'' if mc_n is None else mc_n}\t"
                f"{'' if lo is None else lo!r}\t{'' if hi is None else hi!r}\n"
            )
    print(
        f"Wrote {output} ({len(rows)} validation rows) "
        f"with Python {sys.version.split()[0]} (numpy/scipy port; MC streams differ from R)"
    )


if __name__ == "__main__":
    main()
