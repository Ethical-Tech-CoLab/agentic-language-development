/**
 * E03 analysis: the pre-registered chance-baseline analysis of RESEARCH.md
 * Appendix D (§D.6 primary outcomes, §D.7 sensitivity, §D.10 decision rule)
 * for EXPERIMENT-NOTEBOOK.md E03 and SPECIFICATION.md §15.3.
 *
 * The function is a calculator: it computes each registered quantity and
 * evaluates the registered decision rule mechanically. It draws no scientific
 * conclusion, stores nothing, and reads nothing — `qualifies` is "the
 * registered arithmetic came out this way", and the two §D.10 clauses that
 * depend on evidence verification and the leakage audit are supplied by the
 * harness, not by this package (ALD-072 acceptance criterion 3).
 */
import { deriveSeedHex } from '@ald/hashing';

import {
  bootstrapMeanReplicates,
  bootstrapPairedDifferenceReplicates,
  percentileInterval,
  type BootstrapCi,
} from './bootstrap.js';
import {
  mean as sampleMean,
  proportion,
  pooledProportion,
  summarize,
  wilsonInterval,
  type DescriptiveSummary,
  type ConfidenceInterval,
  type ProportionSummary,
  type WilsonInterval,
} from './descriptive.js';
import { cohensH, rankBiserial } from './effects.js';
import {
  AnalysisError,
  assertLevel,
  assertProbability,
  assertSample,
} from './errors.js';
import {
  evaluateControlEquivalence,
  type EquivalenceDecision,
} from './equivalence.js';
import {
  holmBonferroni,
  oneSampleTTest,
  type OneSampleTTestResult,
  type TostResult,
} from './hypothesis.js';
import { studentTQuantile } from './special.js';

/** Appendix D §D.10 clause 3: seeds at or above this success rate are audited. */
export const E03_HIGH_SEED_THRESHOLD = 0.35;
/** Appendix D §D.10 clause 3: at most this share of a condition's seeds may be high. */
export const E03_HIGH_SEED_SHARE_LIMIT = 0.05;
/** Appendix D §D.2/§D.3 oracle adequacy floor. */
export const E03_ORACLE_LOWER_BOUND = 0.9;
/** Appendix D §D.6 item 3 oracle separation floor. */
export const E03_SEPARATION_LOWER_BOUND = 0.6;
/** SPECIFICATION.md §15.3 floor for E00-E03. */
export const E03_MINIMUM_SEEDS = 5;

const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_CONFIDENCE = 0.95;

/** Per-seed episode counts, or one count that applies to every seed. */
export type EpisodeCounts = number | readonly number[];

export interface E03AnalysisInput {
  readonly alpha: number;
  /** Lower equivalence bound (Appendix D §D.6: 0.20). */
  readonly equivalenceLower: number;
  /** Upper equivalence bound (Appendix D §D.6: 0.30). */
  readonly equivalenceUpper: number;
  /** Oracle adequacy floor (Appendix D §D.6 item 2: 0.90). */
  readonly oracleLowerBound: number;
  /** Oracle separation floor (Appendix D §D.6 item 3: 0.60). */
  readonly separationLowerBound: number;
  /** Root seed for every bootstrap stream; child seeds are derived from it. */
  readonly seed: string;
  /**
   * Seed-level success proportions per non-oracle condition, keyed by
   * `communicationCondition` (Appendix D §D.5: disabled, constant, random,
   * shuffled, normal no-learning). Every array must be paired with `oracle`
   * by seed slot, hence of equal length.
   */
  readonly conditions: Readonly<Record<string, readonly number[]>>;
  /** Seed-level success proportions for the oracle condition. */
  readonly oracle: readonly number[];
  /** Bootstrap resamples per interval (default 10000). */
  readonly bootstrapIterations?: number;
  /** Nominal two-sided bootstrap coverage (default 0.95). */
  readonly confidence?: number;
  /**
   * Optional episode counts per condition (and `oracle`), enabling the
   * descriptive pooled-episode Wilson intervals of Appendix D §D.7.
   */
  readonly episodeCounts?: Readonly<Record<string, EpisodeCounts>>;
  /** Override the §D.10 high-seed threshold (default 0.35). */
  readonly highSeedThreshold?: number;
  /** Override the §D.10 high-seed share limit (default 0.05). */
  readonly highSeedShareLimit?: number;
  /** Qualification seed floor; defaults to the normative five-seed minimum. */
  readonly minimumSeeds?: number;
}

export interface E03HighSeedAudit {
  readonly threshold: number;
  readonly shareLimit: number;
  readonly count: number;
  readonly share: number;
  /** Zero-based seed slots at or above `threshold`, for the leakage audit. */
  readonly seedIndices: number[];
  /** Diagnostic threshold only; every listed seed requires a leakage audit. */
  readonly auditRequired: boolean;
  /** Retained for transparent comparison with the original diagnostic cap. */
  readonly withinLimit: boolean;
}

export interface E03SeparationResult {
  /** Nominal paired bootstrap interval, retained as a sensitivity estimate. */
  readonly interval: BootstrapCi;
  /** One-sided seed-level t test of difference above the practical floor. */
  readonly test: OneSampleTTestResult;
  readonly rawP: number;
  readonly holmAdjustedP: number;
  /** Holm rank by ascending raw p, 1 = smallest p. */
  readonly rank: number;
  /** Conservative one-sided Bonferroni simultaneous interval. */
  readonly simultaneousInterval: ConfidenceInterval;
  /** Holm rejects and the simultaneous lower bound exceeds the floor. */
  readonly meets: boolean;
}

export interface E03ConditionResult {
  readonly condition: string;
  /** Number of valid seeds analysed for this condition. */
  readonly n: number;
  readonly summary: DescriptiveSummary;
  readonly tost: TostResult;
  /** TOST p before multiplicity correction: `max(pLower, pUpper)`. */
  readonly rawP: number;
  /** Holm-adjusted TOST p across the non-oracle conditions; `NaN` if excluded. */
  readonly holmAdjustedP: number;
  /** Decision before correction, from `evaluateControlEquivalence`. */
  readonly unadjustedDecision: EquivalenceDecision;
  /** Registered decision: Holm-adjusted equivalence across conditions. */
  readonly decision: EquivalenceDecision;
  /** Cohen's h of the observed mean against the equivalence-bound midpoint. */
  readonly cohensHVersusMidpoint: number;
  /** Rank-biserial correlation of oracle over this condition (seed level). */
  readonly rankBiserialOracleOverCondition: number;
  readonly separation: E03SeparationResult;
  readonly highSeeds: E03HighSeedAudit;
  /** Pooled-episode Wilson interval, present only when episode counts are given. */
  readonly pooledEpisodes?: WilsonInterval;
}

export interface E03OracleResult {
  readonly n: number;
  readonly summary: DescriptiveSummary;
  /** Two-sided bootstrap interval retained as a sensitivity estimate. */
  readonly adequacy: BootstrapCi;
  /** Primary one-sided seed-level t test above `lowerBound`. */
  readonly test: OneSampleTTestResult;
  readonly simultaneousInterval: ConfidenceInterval;
  readonly lowerBound: number;
  readonly meetsAdequacy: boolean;
  readonly pooledEpisodes?: WilsonInterval;
}

export interface E03Criteria {
  /** §D.10 clause 1: all non-oracle conditions meet equivalence. */
  readonly allControlsEquivalent: boolean;
  /** §D.10 clause 2a: oracle adequacy. */
  readonly oracleAdequate: boolean;
  /** §D.10 clause 2b: oracle separation for every non-oracle condition. */
  readonly allSeparationsMeet: boolean;
}

export interface E03Analysis {
  readonly alpha: number;
  readonly equivalenceLower: number;
  readonly equivalenceUpper: number;
  readonly oracleLowerBound: number;
  readonly separationLowerBound: number;
  readonly seed: string;
  readonly bootstrapIterations: number;
  readonly confidence: number;
  /** Conditions in the caller's key order. */
  readonly conditions: E03ConditionResult[];
  readonly oracle: E03OracleResult;
  readonly criteria: E03Criteria;
  /**
   * Every registered clause this run fails, as stable codes such as
   * `equivalence:shuffled`, `separation:random`, or `oracle-adequacy`.
   * Empty iff `qualifies` is true.
   */
  readonly unmetCriteria: string[];
  /**
   * The three computable §D.10 clauses all hold. The two remaining clauses
   * (all included evidence bundles verify; no unplanned metadata or channel
   * leakage detected) are the harness's to add.
   */
  readonly qualifies: boolean;
  /** High-tail diagnostics requiring case-level leakage review by the harness. */
  readonly auditTriggers: string[];
  readonly minimumSeeds: number;
  /** Human-readable provenance of the rule that produced `qualifies`. */
  readonly decisionRule: string;
}

const DECISION_RULE =
  'RESEARCH.md Appendix D §D.10 numeric clauses (Holm control equivalence, ' +
  'one-sided seed-level oracle adequacy, and Holm separation). High-tail ' +
  'case review, evidence-bundle verification, and leakage disposition are ' +
  'supplied by the harness.';

/** Seed-level success proportions must be probabilities (Appendix D §D.6). */
function assertProportions(rates: readonly number[], label: string): void {
  rates.forEach((rate, index) => {
    assertProbability(rate, `${label}[${index}]`);
  });
}

function episodeCountsFor(
  counts: EpisodeCounts | undefined,
  seeds: number,
  label: string,
): number[] | undefined {
  if (counts === undefined) {
    return undefined;
  }
  if (typeof counts === 'number') {
    if (!Number.isInteger(counts) || counts < 1) {
      throw new AnalysisError(
        'domain',
        `episodeCounts.${label} must be a positive integer`,
      );
    }
    return new Array<number>(seeds).fill(counts);
  }
  if (counts.length !== seeds) {
    throw new AnalysisError(
      'length-mismatch',
      `episodeCounts.${label} must have one count per seed`,
    );
  }
  return counts.map((count, index) => {
    if (!Number.isInteger(count) || count < 1) {
      throw new AnalysisError(
        'domain',
        `episodeCounts.${label}[${index}] must be a positive integer`,
      );
    }
    return count;
  });
}

/**
 * Pooled-episode Wilson interval. Seed-level proportions are converted back to
 * episode counts by `round(rate * episodes)`, which is exact whenever the rate
 * came from that episode count. Appendix D §D.7 marks these intervals
 * descriptive only: the inferential unit stays the seed (§D.6).
 */
function pooledWilson(
  rates: readonly number[],
  counts: readonly number[],
  confidence: number,
): WilsonInterval {
  const parts: ProportionSummary[] = rates.map((rate, index) => {
    const episodes = counts[index] as number;
    return proportion(Math.round(rate * episodes), episodes);
  });
  const pooled = pooledProportion(parts);
  return wilsonInterval(pooled.successes, pooled.n, confidence);
}

function highSeedAudit(
  rates: readonly number[],
  threshold: number,
  shareLimit: number,
): E03HighSeedAudit {
  const seedIndices: number[] = [];
  rates.forEach((rate, index) => {
    if (rate >= threshold) {
      seedIndices.push(index);
    }
  });
  const share = seedIndices.length / rates.length;
  return {
    threshold,
    shareLimit,
    count: seedIndices.length,
    share,
    seedIndices,
    auditRequired: seedIndices.length > 0,
    withinLimit: share <= shareLimit,
  };
}

function oneSidedLowerInterval(
  test: OneSampleTTestResult,
  alpha: number,
): ConfidenceInterval {
  const level = 1 - alpha;
  if (test.n < 2 || Number.isNaN(test.se)) {
    return { lower: NaN, upper: 1, level };
  }
  const critical = studentTQuantile(level, test.df);
  return {
    lower: test.mean - critical * test.se,
    upper: 1,
    level,
  };
}

/**
 * Run the complete Appendix D §D.6 analysis and evaluate the §D.10 rule.
 *
 * Multiplicity choices, both pre-registerable and both documented here
 * because Appendix D fixes the correction family but not its mechanics:
 *
 * 1. **Equivalence.** Holm-Bonferroni is applied to each condition's TOST p
 *    value, `max(pLower, pUpper)`. That maximum *is* the TOST p value, so
 *    rejecting it at the Holm-adjusted alpha is exactly §D.6's "both
 *    one-sided tests reject at the Holm-adjusted alpha", and the family is
 *    the non-oracle conditions. Conditions with fewer than
 *    `MINIMUM_EQUIVALENCE_SEEDS` seeds are excluded from the family (their
 *    p is undefined) and reported as `insufficient-seeds`.
 * 2. **Adequacy and separation.** Primary decisions use one-sided seed-level
 *    t tests. Separation p values receive Holm correction. A conservative
 *    Bonferroni one-sided simultaneous interval accompanies each separation;
 *    the percentile bootstrap remains a sensitivity interval. This avoids
 *    ranking confidence levels by observed effect magnitude, which is not
 *    equivalent to Holm ordering when standard errors differ.
 */
export function e03Analysis(input: E03AnalysisInput): E03Analysis {
  assertLevel(input.alpha, 'alpha');
  assertSample(input.oracle, 'oracle');
  if (typeof input.seed !== 'string' || input.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }
  if (!(input.equivalenceLower < input.equivalenceUpper)) {
    throw new AnalysisError(
      'domain',
      'equivalenceLower must be below equivalenceUpper',
    );
  }
  const names = Object.keys(input.conditions);
  if (names.length === 0) {
    throw new AnalysisError(
      'empty-sample',
      'at least one non-oracle condition is required',
    );
  }
  const iterations = input.bootstrapIterations ?? DEFAULT_ITERATIONS;
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE;
  assertLevel(confidence, 'confidence');
  const threshold = input.highSeedThreshold ?? E03_HIGH_SEED_THRESHOLD;
  const shareLimit = input.highSeedShareLimit ?? E03_HIGH_SEED_SHARE_LIMIT;
  const minimumSeeds = input.minimumSeeds ?? E03_MINIMUM_SEEDS;
  if (!Number.isInteger(minimumSeeds) || minimumSeeds < 2) {
    throw new AnalysisError('domain', 'minimumSeeds must be an integer at least 2');
  }
  const midpoint = (input.equivalenceLower + input.equivalenceUpper) / 2;

  const oracleRates = input.oracle;
  assertProportions(oracleRates, 'oracle');
  const oracleMean = sampleMean(oracleRates);

  // --- per-condition descriptive statistics, TOST, effect sizes -----------
  interface Working {
    readonly condition: string;
    readonly rates: readonly number[];
    readonly summary: DescriptiveSummary;
    readonly tost: TostResult;
    readonly unadjustedDecision: EquivalenceDecision;
    readonly rawP: number;
    readonly replicates: readonly number[];
    readonly differences: readonly number[];
    readonly separationTest: OneSampleTTestResult;
    readonly difference: number;
    readonly highSeeds: E03HighSeedAudit;
    readonly pooledEpisodes?: WilsonInterval;
  }
  const working: Working[] = names.map((condition) => {
    const rates = input.conditions[condition] as readonly number[];
    assertSample(rates, `conditions.${condition}`);
    assertProportions(rates, `conditions.${condition}`);
    if (rates.length !== oracleRates.length) {
      throw new AnalysisError(
        'length-mismatch',
        `conditions.${condition} must be paired with oracle by seed slot`,
      );
    }
    const equivalence = evaluateControlEquivalence({
      seedSuccessRates: rates,
      lower: input.equivalenceLower,
      upper: input.equivalenceUpper,
      alpha: input.alpha,
    });
    const counts = episodeCountsFor(
      input.episodeCounts?.[condition],
      rates.length,
      condition,
    );
    const replicates = bootstrapPairedDifferenceReplicates(
      oracleRates,
      rates,
      {
        seed: deriveSeedHex(input.seed, 'e03-separation', condition),
        iterations,
        confidence,
      },
    );
    const differences = oracleRates.map(
      (oracleRate, index) => oracleRate - (rates[index] as number),
    );
    return {
      condition,
      rates,
      summary: summarize(rates),
      tost: equivalence.tost,
      unadjustedDecision: equivalence.decision,
      rawP: equivalence.tost.p,
      replicates,
      differences,
      separationTest: oneSampleTTest(
        differences,
        input.separationLowerBound,
        'greater',
      ),
      difference: oracleMean - sampleMean(rates),
      highSeeds: highSeedAudit(rates, threshold, shareLimit),
      ...(counts === undefined
        ? {}
        : { pooledEpisodes: pooledWilson(rates, counts, confidence) }),
    };
  });

  // --- Holm across conditions for the equivalence family ------------------
  const family = working.filter(
    (entry) =>
      entry.rates.length >= minimumSeeds &&
      entry.unadjustedDecision !== 'insufficient-seeds' &&
      Number.isFinite(entry.rawP),
  );
  const holmAdjusted = new Map<string, number>();
  const holmRejected = new Map<string, boolean>();
  if (family.length > 0) {
    const holm = holmBonferroni(
      family.map((entry) => entry.rawP),
      input.alpha,
    );
    family.forEach((entry, index) => {
      holmAdjusted.set(entry.condition, holm.adjusted[index] as number);
      holmRejected.set(entry.condition, holm.rejected[index] as boolean);
    });
  }

  // --- Holm separation tests and simultaneous intervals -------------------
  const separationFamily = working.filter(
    (entry) =>
      entry.rates.length >= minimumSeeds &&
      Number.isFinite(entry.separationTest.p),
  );
  const separationAdjusted = new Map<string, number>();
  const separationRejected = new Map<string, boolean>();
  if (separationFamily.length > 0) {
    const holm = holmBonferroni(
      separationFamily.map((entry) => entry.separationTest.p),
      input.alpha,
    );
    separationFamily.forEach((entry, index) => {
      separationAdjusted.set(entry.condition, holm.adjusted[index] as number);
      separationRejected.set(entry.condition, holm.rejected[index] as boolean);
    });
  }
  const separationOrder = [...working].sort((left, right) => {
    const leftP = Number.isFinite(left.separationTest.p)
      ? left.separationTest.p
      : Infinity;
    const rightP = Number.isFinite(right.separationTest.p)
      ? right.separationTest.p
      : Infinity;
    return leftP - rightP;
  });
  const m = working.length;
  const separations = new Map<string, E03SeparationResult>();
  separationOrder.forEach((entry, index) => {
    const rank = index + 1;
    const nominal = percentileInterval(entry.replicates, confidence);
    const base = {
      estimate: entry.difference,
      n: entry.rates.length,
      iterations,
      seed: deriveSeedHex(input.seed, 'e03-separation', entry.condition),
    };
    const adjustedP = separationAdjusted.get(entry.condition) ?? NaN;
    const simultaneousInterval = oneSidedLowerInterval(
      entry.separationTest,
      input.alpha / m,
    );
    const meets =
      (separationRejected.get(entry.condition) ?? false) &&
      simultaneousInterval.lower > input.separationLowerBound;
    separations.set(entry.condition, {
      interval: { ...nominal, ...base },
      test: entry.separationTest,
      rawP: entry.separationTest.p,
      holmAdjustedP: adjustedP,
      rank,
      simultaneousInterval,
      meets,
    });
  });

  // --- oracle adequacy ----------------------------------------------------
  const oracleSeed = deriveSeedHex(input.seed, 'e03-oracle-adequacy');
  const oracleReplicates = bootstrapMeanReplicates(oracleRates, {
    seed: oracleSeed,
    iterations,
    confidence,
  });
  const oracleInterval = percentileInterval(oracleReplicates, confidence);
  const oracleTest = oneSampleTTest(
    oracleRates,
    input.oracleLowerBound,
    'greater',
  );
  const oracleSimultaneousInterval = oneSidedLowerInterval(
    oracleTest,
    input.alpha,
  );
  const oracleCounts = episodeCountsFor(
    input.episodeCounts?.['oracle'],
    oracleRates.length,
    'oracle',
  );
  const oracle: E03OracleResult = {
    n: oracleRates.length,
    summary: summarize(oracleRates),
    adequacy: {
      ...oracleInterval,
      estimate: oracleMean,
      n: oracleRates.length,
      iterations,
      seed: oracleSeed,
    },
    test: oracleTest,
    simultaneousInterval: oracleSimultaneousInterval,
    lowerBound: input.oracleLowerBound,
    meetsAdequacy:
      oracleRates.length >= minimumSeeds &&
      oracleTest.p < input.alpha &&
      oracleSimultaneousInterval.lower > input.oracleLowerBound,
    ...(oracleCounts === undefined
      ? {}
      : {
          pooledEpisodes: pooledWilson(oracleRates, oracleCounts, confidence),
        }),
  };

  // --- assemble -----------------------------------------------------------
  const unmetCriteria: string[] = [];
  const auditTriggers: string[] = [];
  const conditions: E03ConditionResult[] = working.map((entry) => {
    const adjustedP = holmAdjusted.get(entry.condition) ?? NaN;
    const rejected = holmRejected.get(entry.condition) ?? false;
    const decision: EquivalenceDecision =
      entry.rates.length < minimumSeeds ||
      entry.unadjustedDecision === 'insufficient-seeds'
        ? 'insufficient-seeds'
        : rejected
          ? 'equivalent'
          : 'not-equivalent';
    const separation = separations.get(entry.condition) as E03SeparationResult;
    if (decision !== 'equivalent') {
      unmetCriteria.push(`equivalence:${entry.condition}`);
    }
    if (!separation.meets) {
      unmetCriteria.push(`separation:${entry.condition}`);
    }
    if (entry.highSeeds.auditRequired) {
      auditTriggers.push(`high-seed-review:${entry.condition}`);
    }
    return {
      condition: entry.condition,
      n: entry.rates.length,
      summary: entry.summary,
      tost: entry.tost,
      rawP: entry.rawP,
      holmAdjustedP: adjustedP,
      unadjustedDecision: entry.unadjustedDecision,
      decision,
      cohensHVersusMidpoint: cohensH(entry.summary.mean, midpoint),
      rankBiserialOracleOverCondition: rankBiserial(oracleRates, entry.rates).r,
      separation,
      highSeeds: entry.highSeeds,
      ...(entry.pooledEpisodes === undefined
        ? {}
        : { pooledEpisodes: entry.pooledEpisodes }),
    };
  });
  if (!oracle.meetsAdequacy) {
    unmetCriteria.push('oracle-adequacy');
  }
  const criteria: E03Criteria = {
    allControlsEquivalent: conditions.every(
      (entry) => entry.decision === 'equivalent',
    ),
    oracleAdequate: oracle.meetsAdequacy,
    allSeparationsMeet: conditions.every((entry) => entry.separation.meets),
  };
  return {
    alpha: input.alpha,
    equivalenceLower: input.equivalenceLower,
    equivalenceUpper: input.equivalenceUpper,
    oracleLowerBound: input.oracleLowerBound,
    separationLowerBound: input.separationLowerBound,
    seed: input.seed,
    bootstrapIterations: iterations,
    confidence,
    conditions,
    oracle,
    criteria,
    unmetCriteria,
    auditTriggers,
    qualifies:
      criteria.allControlsEquivalent &&
      criteria.oracleAdequate &&
      criteria.allSeparationsMeet,
    minimumSeeds,
    decisionRule: DECISION_RULE,
  };
}
