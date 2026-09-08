/**
 * Seed-clustered inference for the SPECIFICATION.md §15.2 intervention suite
 * (BACKLOG ALD-072, EXPERIMENT-NOTEBOOK.md E16).
 *
 * §15.2 fixes two things and separates them deliberately:
 *
 * 1. a *descriptive* readiness threshold — "within each run, ledger-predicted
 *    direction matches observed behavior change in at least 70% of probed
 *    instances. This is not an inferential test" — which lives in
 *    `@ald/interventions` next to the probe schedule; and
 * 2. *confirmatory* inference, which "MUST account for probe clustering within
 *    run/seed using a hierarchical Bernoulli model or a pre-registered
 *    seed-level equivalent against the E03 chance baseline at alpha = 0.05".
 *
 * This module implements both halves of (2) so a pre-registration can name
 * which one is primary:
 *
 * - {@link seedLevelAgreement} — the pre-registered seed-level equivalent. The
 *   unit of analysis is the per-seed agreement proportion (RESEARCH.md
 *   Appendix D §D.6), so probe clustering is handled by aggregation: a
 *   one-sample t test of the seed proportions against the chance baseline,
 *   with the pooled Wilson interval reported alongside it as descriptive only
 *   (§D.7) and a seeded percentile bootstrap of the seed mean.
 * - {@link betaBinomialAgreement} — the two-level hierarchical Bernoulli
 *   model: probes within a seed are Bernoulli(p_seed), and p_seed is
 *   Beta(mu * s, (1 - mu) * s), i.e. the beta-binomial marginal likelihood.
 *   `mu` is the population agreement rate and `rho = 1 / (s + 1)` the
 *   intra-seed correlation that a pooled-probe analysis would ignore. The
 *   fit is a deterministic grid search with fixed refinement rounds (no
 *   iterative solver, no randomness), and its uncertainty is a seeded
 *   bootstrap over *seeds*, which is the clustered resampling unit.
 *
 * {@link welchTTest} is the unequal-variance two-sample test the E15 bandwidth
 * contrast needs on seed means (`composition.ts`).
 *
 * Nothing here interprets a result. A `decision` field is the mechanical
 * outcome of the pre-registered rule applied to the numbers (ALD-072
 * acceptance criterion 3): `above-chance` means "the pre-registered rule fired
 * on this sample", never "communication happened".
 */
import { SeededPrng } from '@ald/hashing';

import {
  bootstrapMeanCi,
  percentileInterval,
  type BootstrapCi,
} from './bootstrap.js';
import {
  proportion,
  summarize,
  wilsonInterval,
  type ConfidenceInterval,
  type ProportionSummary,
  type WilsonInterval,
} from './descriptive.js';
import { cohensH } from './effects.js';
import {
  AnalysisError,
  assertCount,
  assertLevel,
  assertProbability,
} from './errors.js';
import { oneSampleTTest, type OneSampleTTestResult } from './hypothesis.js';
import { logBeta, logBinomialCoefficient, studentTCdf } from './special.js';

/** Analysis version stamped on every readout of this module. */
export const HIERARCHICAL_ANALYSIS_VERSION = 'hierarchical-agreement/v1';

/**
 * §15.3 minimum seeds: 5 per condition for the qualification-stage
 * experiments (E00-E03), 10 for any publication-facing claim (E10 onward).
 * The default is the qualification floor; a confirmatory pre-registration
 * passes `minimumSeeds: 10` (or E15/E16's own 75).
 */
export const QUALIFICATION_MINIMUM_SEEDS = 5;

/** One seed's probe tally. `agreements` counts scored probes that agreed. */
export interface SeedAgreementCount {
  readonly seed: string;
  readonly agreements: number;
  readonly probes: number;
}

export interface SeedAgreementProportion extends SeedAgreementCount {
  readonly proportion: number;
}

export type AgreementDecision =
  | 'above-chance'
  | 'not-above-chance'
  | 'insufficient-seeds';

export interface SeedLevelAgreementInput {
  readonly seeds: readonly SeedAgreementCount[];
  /** E03 chance baseline for the task, e.g. 0.25 for four candidates. */
  readonly chanceRate: number;
  /** Pre-registered α per primary hypothesis (§15.3 default 0.05). */
  readonly alpha?: number;
  /** Coverage of the reported intervals (default 0.95). */
  readonly confidence?: number;
  /** §15.3 seed floor for the claim this analysis backs (default 5). */
  readonly minimumSeeds?: number;
  /** Omit to skip the bootstrap; the t test does not need it. */
  readonly bootstrap?: { readonly seed: string; readonly iterations?: number };
}

export interface SeedLevelAgreementResult {
  readonly analysisVersion: string;
  readonly method: 'seed-level-equivalent';
  readonly seeds: readonly SeedAgreementProportion[];
  readonly seedCount: number;
  /** Mean of the per-seed proportions — the §15.3/§D.6 unit of analysis. */
  readonly seedMean: number;
  readonly seedSd: number;
  /** Probes pooled across seeds. Descriptive only (Appendix D §D.7). */
  readonly pooledDescriptive: ProportionSummary;
  /** Wilson interval over the pooled probes. Descriptive only (§D.7). */
  readonly pooledWilsonDescriptive: WilsonInterval;
  /** One-sided (`greater`) t test of the seed proportions against chance. */
  readonly seedMeanTTest: OneSampleTTestResult;
  /** Seeded percentile bootstrap of the seed mean; `null` when not requested. */
  readonly seedMeanBootstrap: BootstrapCi | null;
  /** §15.3 mandatory effect size: seed mean versus the chance baseline. */
  readonly cohensHVersusChance: number;
  readonly seedsAtOrBelowChance: number;
  readonly chanceRate: number;
  readonly alpha: number;
  readonly confidence: number;
  readonly minimumSeeds: number;
  readonly meetsSeedMinimum: boolean;
  readonly decision: AgreementDecision;
}

function assertSeeds(seeds: readonly SeedAgreementCount[]): void {
  if (seeds.length === 0) {
    throw new AnalysisError('empty-sample', 'seeds must not be empty');
  }
  const seen = new Set<string>();
  seeds.forEach((entry, index) => {
    if (typeof entry.seed !== 'string' || entry.seed.length === 0) {
      throw new AnalysisError(
        'domain',
        `seeds[${index}].seed must be a non-empty string`,
      );
    }
    if (seen.has(entry.seed)) {
      throw new AnalysisError(
        'domain',
        `seeds[${index}].seed is a duplicate: ${entry.seed}`,
      );
    }
    seen.add(entry.seed);
    assertCount(entry.agreements, `seeds[${index}].agreements`);
    assertCount(entry.probes, `seeds[${index}].probes`);
    if (entry.probes === 0) {
      throw new AnalysisError(
        'empty-sample',
        `seeds[${index}].probes must be greater than zero`,
      );
    }
    if (entry.agreements > entry.probes) {
      throw new AnalysisError(
        'domain',
        `seeds[${index}].agreements must not exceed probes`,
      );
    }
  });
}

/**
 * The pre-registered seed-level equivalent of a hierarchical model
 * (SPECIFICATION.md §15.2): aggregate each seed's probes into one proportion
 * and test the seed proportions against the E03 chance baseline.
 *
 * `decision` is `insufficient-seeds` whenever fewer than two seeds are
 * present (a t test has no variance estimate at n = 1) or the sample is
 * degenerate in the sense `oneSampleTTest` documents; otherwise it is
 * `above-chance` exactly when the one-sided p value is below `alpha`.
 * `meetsSeedMinimum` is reported separately: an `above-chance` decision on
 * three seeds still fails the §15.3 seed policy, and the caller must not
 * present it as a publication-facing result.
 */
export function seedLevelAgreement(
  input: SeedLevelAgreementInput,
): SeedLevelAgreementResult {
  assertSeeds(input.seeds);
  assertProbability(input.chanceRate, 'chanceRate');
  const alpha = input.alpha ?? 0.05;
  const confidence = input.confidence ?? 0.95;
  assertLevel(alpha, 'alpha');
  assertLevel(confidence, 'confidence');
  const minimumSeeds = input.minimumSeeds ?? QUALIFICATION_MINIMUM_SEEDS;
  assertCount(minimumSeeds, 'minimumSeeds');

  const seeds: SeedAgreementProportion[] = input.seeds.map((entry) => ({
    ...entry,
    proportion: entry.agreements / entry.probes,
  }));
  const proportions = seeds.map((entry) => entry.proportion);
  const stats = summarize(proportions);
  const pooled = proportion(
    seeds.reduce((total, entry) => total + entry.agreements, 0),
    seeds.reduce((total, entry) => total + entry.probes, 0),
  );
  const tTest = oneSampleTTest(proportions, input.chanceRate, 'greater');
  const bootstrap =
    input.bootstrap === undefined
      ? null
      : bootstrapMeanCi(proportions, {
          seed: input.bootstrap.seed,
          ...(input.bootstrap.iterations === undefined
            ? {}
            : { iterations: input.bootstrap.iterations }),
          confidence,
        });

  let decision: AgreementDecision;
  if (seeds.length < 2 || Number.isNaN(tTest.p)) {
    decision = 'insufficient-seeds';
  } else {
    decision = tTest.p < alpha ? 'above-chance' : 'not-above-chance';
  }

  return {
    analysisVersion: HIERARCHICAL_ANALYSIS_VERSION,
    method: 'seed-level-equivalent',
    seeds,
    seedCount: seeds.length,
    seedMean: stats.mean,
    seedSd: stats.sd,
    pooledDescriptive: pooled,
    pooledWilsonDescriptive: wilsonInterval(
      pooled.successes,
      pooled.n,
      confidence,
    ),
    seedMeanTTest: tTest,
    seedMeanBootstrap: bootstrap,
    cohensHVersusChance: cohensH(
      Math.min(1, Math.max(0, stats.mean)),
      input.chanceRate,
    ),
    seedsAtOrBelowChance: proportions.filter(
      (value) => value <= input.chanceRate,
    ).length,
    chanceRate: input.chanceRate,
    alpha,
    confidence,
    minimumSeeds,
    meetsSeedMinimum: seeds.length >= minimumSeeds,
    decision,
  };
}

// ---------------------------------------------------------------------------
// Two-level hierarchical Bernoulli (beta-binomial) fit
// ---------------------------------------------------------------------------

/** Grid points per parameter per refinement round. Fixed, so the fit replays. */
const GRID_POINTS = 25;
/** Refinement rounds; each shrinks the search window by `GRID_SHRINK`. */
const GRID_ROUNDS = 3;
const GRID_SHRINK = 4;
/** Search window for `log10(s)`; `s` is the beta precision `a + b`. */
const LOG_PRECISION_MIN = -2;
const LOG_PRECISION_MAX = 4;
const DEFAULT_BOOTSTRAP_ITERATIONS = 500;

export interface BetaBinomialFit {
  /** Population agreement rate `a / (a + b)`. */
  readonly mu: number;
  /** Beta precision `s = a + b`. */
  readonly precision: number;
  readonly alphaParameter: number;
  readonly betaParameter: number;
  /** Intra-seed correlation `1 / (s + 1)`: the clustering a pooled test hides. */
  readonly intraSeedCorrelation: number;
  /** Marginal log-likelihood at the reported optimum. */
  readonly logLikelihood: number;
  /**
   * False when the optimum sat on an edge of the final `log10(s)` window,
   * which happens for perfectly homogeneous or perfectly split data. `mu` is
   * still the maximiser on the searched grid; the precision is not identified.
   */
  readonly precisionIdentified: boolean;
}

export interface BetaBinomialAgreementInput {
  readonly seeds: readonly SeedAgreementCount[];
  readonly chanceRate: number;
  readonly alpha?: number;
  readonly confidence?: number;
  readonly minimumSeeds?: number;
  /**
   * Seeded cluster bootstrap over seeds. Required for an interval: the
   * beta-binomial likelihood has no closed-form standard error here, and the
   * toolkit never draws unseeded randomness.
   */
  readonly bootstrap?: { readonly seed: string; readonly iterations?: number };
}

export interface BetaBinomialAgreementResult extends BetaBinomialFit {
  readonly analysisVersion: string;
  readonly method: 'beta-binomial-hierarchical-bernoulli';
  readonly seedCount: number;
  readonly totalProbes: number;
  readonly totalAgreements: number;
  readonly grid: {
    readonly points: number;
    readonly rounds: number;
    readonly logPrecisionWindow: readonly [number, number];
  };
  readonly bootstrap: {
    readonly seed: string;
    readonly iterations: number;
    readonly muInterval: ConfidenceInterval;
    /** One-sided `1 - alpha` lower bound on `mu` from the same replicates. */
    readonly muOneSidedLowerBound: number;
  } | null;
  readonly chanceRate: number;
  readonly alpha: number;
  readonly confidence: number;
  readonly minimumSeeds: number;
  readonly meetsSeedMinimum: boolean;
  /**
   * `above-chance` only when the bootstrap one-sided lower bound on `mu`
   * exceeds `chanceRate`; without a bootstrap the model reports
   * `insufficient-seeds` rather than deciding from a point estimate.
   */
  readonly decision: AgreementDecision;
}

/** Beta-binomial marginal log-likelihood of the clustered probe tallies. */
function betaBinomialLogLikelihood(
  seeds: readonly SeedAgreementCount[],
  mu: number,
  precision: number,
): number {
  const a = mu * precision;
  const b = (1 - mu) * precision;
  if (!(a > 0) || !(b > 0)) {
    return -Infinity;
  }
  const reference = logBeta(a, b);
  let total = 0;
  for (const entry of seeds) {
    total +=
      logBinomialCoefficient(entry.probes, entry.agreements) +
      logBeta(entry.agreements + a, entry.probes - entry.agreements + b) -
      reference;
  }
  return total;
}

function gridPoints(low: number, high: number, points: number): number[] {
  if (points < 2) {
    return [(low + high) / 2];
  }
  const step = (high - low) / (points - 1);
  return Array.from({ length: points }, (_unused, index) => low + index * step);
}

/**
 * Deterministic maximum-likelihood fit by nested grid search over
 * `(mu, log10(s))`. Three rounds of a 25 x 25 grid, each round centred on the
 * previous winner with a window shrunk by four, is enough to place `mu` to
 * better than 1e-4 while staying a pure function of the data — no iterative
 * solver, no starting-point randomness, so the fit replays bit-for-bit
 * (SPEC §14.3).
 */
export function fitBetaBinomial(
  seeds: readonly SeedAgreementCount[],
): BetaBinomialFit {
  assertSeeds(seeds);
  let muLow = 0;
  let muHigh = 1;
  let logLow = LOG_PRECISION_MIN;
  let logHigh = LOG_PRECISION_MAX;
  let bestMu = 0.5;
  let bestLog = 0;
  let bestValue = -Infinity;

  for (let round = 0; round < GRID_ROUNDS; round += 1) {
    const margin = (muHigh - muLow) / (2 * GRID_POINTS);
    const mus = gridPoints(muLow + margin, muHigh - margin, GRID_POINTS);
    const logs = gridPoints(logLow, logHigh, GRID_POINTS);
    bestValue = -Infinity;
    for (const mu of mus) {
      for (const log of logs) {
        const value = betaBinomialLogLikelihood(seeds, mu, 10 ** log);
        if (value > bestValue) {
          bestValue = value;
          bestMu = mu;
          bestLog = log;
        }
      }
    }
    const muWidth = (muHigh - muLow) / GRID_SHRINK;
    const logWidth = (logHigh - logLow) / GRID_SHRINK;
    muLow = Math.max(0, bestMu - muWidth / 2);
    muHigh = Math.min(1, bestMu + muWidth / 2);
    logLow = Math.max(LOG_PRECISION_MIN, bestLog - logWidth / 2);
    logHigh = Math.min(LOG_PRECISION_MAX, bestLog + logWidth / 2);
  }

  const precision = 10 ** bestLog;
  const identified =
    bestLog > LOG_PRECISION_MIN + 1e-9 && bestLog < LOG_PRECISION_MAX - 1e-9;
  return {
    mu: bestMu,
    precision,
    alphaParameter: bestMu * precision,
    betaParameter: (1 - bestMu) * precision,
    intraSeedCorrelation: 1 / (precision + 1),
    logLikelihood: bestValue,
    precisionIdentified: identified,
  };
}

/**
 * The §15.2 "hierarchical Bernoulli model" branch: fit the beta-binomial to
 * the clustered probe tallies and bound `mu` by a cluster bootstrap that
 * resamples *seeds* (never probes), because seeds are the independent unit.
 */
export function betaBinomialAgreement(
  input: BetaBinomialAgreementInput,
): BetaBinomialAgreementResult {
  assertSeeds(input.seeds);
  assertProbability(input.chanceRate, 'chanceRate');
  const alpha = input.alpha ?? 0.05;
  const confidence = input.confidence ?? 0.95;
  assertLevel(alpha, 'alpha');
  assertLevel(confidence, 'confidence');
  const minimumSeeds = input.minimumSeeds ?? QUALIFICATION_MINIMUM_SEEDS;
  assertCount(minimumSeeds, 'minimumSeeds');

  const fit = fitBetaBinomial(input.seeds);
  const seedCount = input.seeds.length;

  let bootstrap: BetaBinomialAgreementResult['bootstrap'] = null;
  if (input.bootstrap !== undefined) {
    const iterations =
      input.bootstrap.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new AnalysisError(
        'domain',
        'bootstrap.iterations must be a positive integer',
      );
    }
    if (
      typeof input.bootstrap.seed !== 'string' ||
      input.bootstrap.seed.length === 0
    ) {
      throw new AnalysisError('domain', 'bootstrap.seed must be a non-empty string');
    }
    const prng = new SeededPrng(input.bootstrap.seed);
    const replicates = new Array<number>(iterations);
    for (let replicate = 0; replicate < iterations; replicate += 1) {
      const resampled: SeedAgreementCount[] = [];
      for (let draw = 0; draw < seedCount; draw += 1) {
        const picked = input.seeds[prng.nextInt(seedCount)] as SeedAgreementCount;
        // The resampled cluster keeps its tally but needs a unique label,
        // because `assertSeeds` rejects duplicates inside one fit.
        resampled.push({
          seed: `${picked.seed}#${draw}`,
          agreements: picked.agreements,
          probes: picked.probes,
        });
      }
      replicates[replicate] = fitBetaBinomial(resampled).mu;
    }
    const interval = percentileInterval(replicates, confidence);
    const sorted = [...replicates].sort((left, right) => left - right);
    const lowerIndex = Math.max(
      0,
      Math.min(sorted.length - 1, Math.floor(alpha * (sorted.length - 1))),
    );
    bootstrap = {
      seed: input.bootstrap.seed,
      iterations,
      muInterval: interval,
      muOneSidedLowerBound: sorted[lowerIndex] as number,
    };
  }

  let decision: AgreementDecision;
  if (seedCount < 2 || bootstrap === null) {
    decision = 'insufficient-seeds';
  } else {
    decision =
      bootstrap.muOneSidedLowerBound > input.chanceRate
        ? 'above-chance'
        : 'not-above-chance';
  }

  return {
    ...fit,
    analysisVersion: HIERARCHICAL_ANALYSIS_VERSION,
    method: 'beta-binomial-hierarchical-bernoulli',
    seedCount,
    totalProbes: input.seeds.reduce((total, entry) => total + entry.probes, 0),
    totalAgreements: input.seeds.reduce(
      (total, entry) => total + entry.agreements,
      0,
    ),
    grid: {
      points: GRID_POINTS,
      rounds: GRID_ROUNDS,
      logPrecisionWindow: [LOG_PRECISION_MIN, LOG_PRECISION_MAX],
    },
    bootstrap,
    chanceRate: input.chanceRate,
    alpha,
    confidence,
    minimumSeeds,
    meetsSeedMinimum: seedCount >= minimumSeeds,
    decision,
  };
}

// ---------------------------------------------------------------------------
// Unequal-variance two-sample test (E15 bandwidth contrast on seed means)
// ---------------------------------------------------------------------------

export interface WelchTTestResult {
  readonly nA: number;
  readonly nB: number;
  readonly meanA: number;
  readonly meanB: number;
  readonly difference: number;
  readonly se: number;
  readonly t: number;
  /** Welch-Satterthwaite degrees of freedom. */
  readonly df: number;
  readonly p: number;
  readonly alternative: 'two-sided' | 'greater' | 'less';
  readonly degenerate: boolean;
}

/**
 * Welch's unequal-variance two-sample t test on `a - b`.
 *
 * Degenerate samples follow the same explicit rules as `oneSampleTTest`:
 * fewer than two values in either sample yields `NaN` statistics with
 * `degenerate: true`; a zero pooled standard error is a point-mass contrast,
 * where `t` is +/-Infinity and `p` is 0 for the supported alternative and 1
 * for the opposite one, or `t = 0`/`p = 1` when the means coincide.
 */
export function welchTTest(
  a: readonly number[],
  b: readonly number[],
  alternative: WelchTTestResult['alternative'] = 'two-sided',
): WelchTTestResult {
  const left = summarize(a);
  const right = summarize(b);
  const difference = left.mean - right.mean;
  if (left.n < 2 || right.n < 2) {
    return {
      nA: left.n,
      nB: right.n,
      meanA: left.mean,
      meanB: right.mean,
      difference,
      se: NaN,
      t: NaN,
      df: NaN,
      p: NaN,
      alternative,
      degenerate: true,
    };
  }
  const varianceA = left.variance / left.n;
  const varianceB = right.variance / right.n;
  const se = Math.sqrt(varianceA + varianceB);
  if (se === 0) {
    const supported =
      alternative === 'two-sided' ||
      (alternative === 'greater' && difference > 0) ||
      (alternative === 'less' && difference < 0);
    return {
      nA: left.n,
      nB: right.n,
      meanA: left.mean,
      meanB: right.mean,
      difference,
      se,
      t: difference === 0 ? 0 : difference > 0 ? Infinity : -Infinity,
      df: NaN,
      p: difference === 0 ? 1 : supported ? 0 : 1,
      alternative,
      degenerate: true,
    };
  }
  const df =
    (varianceA + varianceB) ** 2 /
    (varianceA ** 2 / (left.n - 1) + varianceB ** 2 / (right.n - 1));
  const t = difference / se;
  const cdf = studentTCdf(t, df);
  let p: number;
  if (alternative === 'greater') {
    p = 1 - cdf;
  } else if (alternative === 'less') {
    p = cdf;
  } else {
    p = 2 * Math.min(cdf, 1 - cdf);
  }
  return {
    nA: left.n,
    nB: right.n,
    meanA: left.mean,
    meanB: right.mean,
    difference,
    se,
    t,
    df,
    p,
    alternative,
    degenerate: false,
  };
}
