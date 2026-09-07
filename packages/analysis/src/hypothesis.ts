/**
 * Hypothesis tests named by SPECIFICATION.md §15.3: one-sample t tests on
 * seed-level outcomes, the two one-sided tests (TOST) that back every
 * "equivalent to chance" claim, Holm-Bonferroni correction across the primary
 * metrics of one experiment, and the one-sided binomial chance comparison E11
 * reports.
 *
 * Nothing here decides anything scientific: a `rejected` or `equivalent` flag
 * is the mechanical outcome of the pre-registered rule applied to the numbers
 * (ALD-072 acceptance criterion 3).
 */
import {
  AnalysisError,
  assertCount,
  assertLevel,
  assertProbability,
  assertSample,
} from './errors.js';
import {
  summarize,
  type ConfidenceInterval,
  type DescriptiveSummary,
} from './descriptive.js';
import {
  binomialLogPmf,
  normalCdf,
  studentTCdf,
  studentTQuantile,
} from './special.js';

export type Alternative = 'two-sided' | 'greater' | 'less';

export interface OneSampleTTestResult {
  readonly n: number;
  readonly mean: number;
  /** Standard error of the mean; `0` for a zero-variance sample, `NaN` when n < 2. */
  readonly se: number;
  readonly t: number;
  readonly df: number;
  readonly p: number;
  readonly mu0: number;
  readonly alternative: Alternative;
  /**
   * True when the sample cannot support an ordinary t test: n < 2 (no
   * variance estimate at all, `t`/`p` are `NaN`) or zero sample variance
   * (`t` is +/-Infinity or 0 and `p` comes from the documented degenerate
   * rule below).
   */
  readonly degenerate: boolean;
}

/**
 * Convert a t statistic to a p value for the requested alternative.
 */
function tTestP(t: number, df: number, alternative: Alternative): number {
  const cdf = studentTCdf(t, df);
  if (alternative === 'greater') {
    return 1 - cdf;
  }
  if (alternative === 'less') {
    return cdf;
  }
  return 2 * Math.min(cdf, 1 - cdf);
}

/**
 * One-sample t test of `mean(values) === mu0` (SPECIFICATION.md §15.3;
 * RESEARCH.md Appendix D §D.6 runs two of these per control condition).
 *
 * Degenerate samples are handled explicitly rather than emitting a silent
 * `NaN`:
 *
 * - **n < 2** — no variance estimate exists, so `t`, `se`, and `p` are `NaN`
 *   and `degenerate` is true. A caller must not treat this as a failure to
 *   reject; `evaluateControlEquivalence` reports `insufficient-seeds`.
 * - **zero sample variance** — the sample is a point mass. If `mean === mu0`
 *   the observed data are exactly the null, so `t = 0` and `p = 1` for every
 *   alternative. Otherwise the data are infinitely far from the null in the
 *   observed direction: `t` is +/-Infinity, `p = 0` for the alternative that
 *   the observed direction supports (`two-sided` always, plus `greater` when
 *   `mean > mu0` or `less` when `mean < mu0`) and `p = 1` for the opposite
 *   one-sided alternative.
 */
export function oneSampleTTest(
  values: readonly number[],
  mu0: number,
  alternative: Alternative = 'two-sided',
): OneSampleTTestResult {
  assertSample(values, 'values');
  if (!Number.isFinite(mu0)) {
    throw new AnalysisError('domain', 'mu0 must be a finite number');
  }
  const stats: DescriptiveSummary = summarize(values);
  const n = stats.n;
  const df = n - 1;
  if (n < 2) {
    return {
      n,
      mean: stats.mean,
      se: NaN,
      t: NaN,
      df,
      p: NaN,
      mu0,
      alternative,
      degenerate: true,
    };
  }
  const se = stats.sd / Math.sqrt(n);
  if (se === 0) {
    const difference = stats.mean - mu0;
    let t: number;
    let p: number;
    if (difference === 0) {
      t = 0;
      p = 1;
    } else {
      t = difference > 0 ? Infinity : -Infinity;
      const supported =
        alternative === 'two-sided' ||
        (alternative === 'greater' && difference > 0) ||
        (alternative === 'less' && difference < 0);
      p = supported ? 0 : 1;
    }
    return { n, mean: stats.mean, se, t, df, p, mu0, alternative, degenerate: true };
  }
  const t = (stats.mean - mu0) / se;
  return {
    n,
    mean: stats.mean,
    se,
    t,
    df,
    p: tTestP(t, df, alternative),
    mu0,
    alternative,
    degenerate: false,
  };
}

export interface TostResult {
  readonly n: number;
  readonly mean: number;
  readonly se: number;
  readonly df: number;
  /** Lower equivalence bound (Appendix D §D.6: 0.20 for E03). */
  readonly equivalenceLower: number;
  /** Upper equivalence bound (Appendix D §D.6: 0.30 for E03). */
  readonly equivalenceUpper: number;
  readonly alpha: number;
  /** One-sided p for H0: mean <= equivalenceLower (alternative `greater`). */
  readonly pLower: number;
  /** One-sided p for H0: mean >= equivalenceUpper (alternative `less`). */
  readonly pUpper: number;
  /** The TOST p value: `max(pLower, pUpper)`. */
  readonly p: number;
  /** True iff both one-sided tests reject at `alpha` (strictly `p < alpha`). */
  readonly equivalent: boolean;
  /** Two-sided (1 - 2 * alpha) interval, the conventional TOST interval. */
  readonly interval: ConfidenceInterval;
  readonly degenerate: boolean;
}

/**
 * Two one-sided tests for equivalence (SPECIFICATION.md §15.3 "equivalence /
 * non-inferiority bound"; RESEARCH.md Appendix D §D.6 item 1 "Control
 * equivalence": two one-sided one-sample tests against bounds 0.20 and 0.30,
 * equivalence requiring both to reject).
 *
 * `p` is the TOST p value `max(pLower, pUpper)`, which is the quantity a
 * multiplicity correction is applied to when several conditions are tested
 * (see `holmBonferroni` and `e03Analysis`).
 */
export function tost(
  values: readonly number[],
  lower: number,
  upper: number,
  alpha: number,
): TostResult {
  assertSample(values, 'values');
  assertLevel(alpha, 'alpha');
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    throw new AnalysisError('domain', 'bounds must be finite numbers');
  }
  if (!(lower < upper)) {
    throw new AnalysisError('domain', 'lower bound must be below upper bound');
  }
  const greater = oneSampleTTest(values, lower, 'greater');
  const less = oneSampleTTest(values, upper, 'less');
  const pLower = greater.p;
  const pUpper = less.p;
  const p = Number.isNaN(pLower) || Number.isNaN(pUpper)
    ? NaN
    : Math.max(pLower, pUpper);
  const level = 1 - 2 * alpha;
  const critical =
    greater.df > 0 && Number.isFinite(greater.se)
      ? studentTQuantile(1 - alpha, greater.df)
      : NaN;
  const halfWidth = critical * greater.se;
  return {
    n: greater.n,
    mean: greater.mean,
    se: greater.se,
    df: greater.df,
    equivalenceLower: lower,
    equivalenceUpper: upper,
    alpha,
    pLower,
    pUpper,
    p,
    equivalent: pLower < alpha && pUpper < alpha,
    interval: {
      lower: greater.mean - halfWidth,
      upper: greater.mean + halfWidth,
      level,
    },
    degenerate: greater.degenerate || less.degenerate,
  };
}

export interface HolmBonferroniResult {
  /** Holm step-down adjusted p values, in the caller's input order. */
  readonly adjusted: number[];
  /** `adjusted[i] <= alpha`, in the caller's input order. */
  readonly rejected: boolean[];
  readonly alpha: number;
}

/**
 * Holm-Bonferroni step-down correction across the primary metrics of a single
 * experiment (SPECIFICATION.md §15.3; RESEARCH.md §7.3).
 *
 * Adjusted values are `(m - rank) * p` accumulated as a running maximum over
 * the ascending-p order, then clamped to 1 — the standard construction, which
 * keeps them monotone so that once one hypothesis fails to reject every
 * larger p also fails. A hypothesis is rejected when its adjusted value is
 * `<= alpha` (textbook Holm; note `tost` uses a strict `<` on the raw p
 * values, so a family-adjusted TOST decision should read `rejected` here).
 *
 * Textbook example pinned in the tests: p = [0.01, 0.04, 0.03, 0.005] at
 * alpha = 0.05 gives adjusted [0.03, 0.06, 0.06, 0.02] and rejected
 * [true, false, false, true].
 */
export function holmBonferroni(
  pValues: readonly number[],
  alpha: number,
): HolmBonferroniResult {
  assertLevel(alpha, 'alpha');
  const m = pValues.length;
  if (m === 0) {
    throw new AnalysisError('empty-sample', 'pValues must not be empty');
  }
  pValues.forEach((value, index) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new AnalysisError(
        'domain',
        `pValues[${index}] must be within [0, 1]`,
      );
    }
  });
  const order = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) =>
      left.value === right.value
        ? left.index - right.index
        : left.value - right.value,
    );
  const adjusted = new Array<number>(m).fill(NaN);
  let running = 0;
  order.forEach((entry, rank) => {
    const scaled = (m - rank) * entry.value;
    running = Math.max(running, scaled);
    adjusted[entry.index] = Math.min(1, running);
  });
  return {
    adjusted,
    rejected: adjusted.map((value) => value <= alpha),
    alpha,
  };
}

export interface BinomialTestResult {
  readonly successes: number;
  readonly n: number;
  readonly observedRate: number;
  /** Null success probability, e.g. the E03 chance rate 0.25. */
  readonly chanceRate: number;
  readonly alternative: Alternative;
  /** Exact binomial tail probability. */
  readonly exactP: number;
  /** Normal-approximation z statistic (no continuity correction). */
  readonly z: number;
  /** Normal-approximation p value for the same alternative. */
  readonly normalP: number;
}

/** Exact tail sum of the binomial pmf, computed in log space. */
function binomialTailP(
  successes: number,
  n: number,
  chanceRate: number,
  upper: boolean,
): number {
  let total = 0;
  const from = upper ? successes : 0;
  const to = upper ? n : successes;
  for (let k = from; k <= to; k += 1) {
    total += Math.exp(binomialLogPmf(k, n, chanceRate));
  }
  return Math.min(1, total);
}

/**
 * One-sample binomial test against a fixed chance rate — the E11
 * above-chance comparison (EXPERIMENT-NOTEBOOK.md E11; the chance baseline
 * itself comes from E03, SPECIFICATION.md §15.3).
 *
 * Both the exact tail probability and the normal approximation are returned;
 * the pre-registration says which one is primary. Two-sided exact p uses the
 * doubled smaller tail, clamped to 1.
 */
export function binomialTest(
  successes: number,
  n: number,
  chanceRate: number,
  alternative: Alternative = 'greater',
): BinomialTestResult {
  assertCount(successes, 'successes');
  assertCount(n, 'n');
  if (n === 0) {
    throw new AnalysisError('empty-sample', 'n must be greater than zero');
  }
  if (successes > n) {
    throw new AnalysisError('domain', 'successes must not exceed n');
  }
  assertProbability(chanceRate, 'chanceRate');
  const observedRate = successes / n;
  let exactP: number;
  if (alternative === 'greater') {
    exactP = binomialTailP(successes, n, chanceRate, true);
  } else if (alternative === 'less') {
    exactP = binomialTailP(successes, n, chanceRate, false);
  } else {
    const upperTail = binomialTailP(successes, n, chanceRate, true);
    const lowerTail = binomialTailP(successes, n, chanceRate, false);
    exactP = Math.min(1, 2 * Math.min(upperTail, lowerTail));
  }
  const variance = (chanceRate * (1 - chanceRate)) / n;
  const z =
    variance > 0 ? (observedRate - chanceRate) / Math.sqrt(variance) : NaN;
  let normalP: number;
  if (Number.isNaN(z)) {
    normalP = NaN;
  } else if (alternative === 'greater') {
    normalP = 1 - normalCdf(z);
  } else if (alternative === 'less') {
    normalP = normalCdf(z);
  } else {
    normalP = 2 * Math.min(normalCdf(z), 1 - normalCdf(z));
  }
  return {
    successes,
    n,
    observedRate,
    chanceRate,
    alternative,
    exactP,
    z,
    normalP,
  };
}
