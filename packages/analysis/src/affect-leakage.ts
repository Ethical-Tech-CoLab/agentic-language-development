/**
 * The pre-registered affect-channel leakage evaluation (SPECIFICATION.md
 * §9.3 rule 7 and §15.3; EXPERIMENT-NOTEBOOK.md E20; ALD-033).
 *
 * SPEC §9.3 rule 7 is the requirement:
 *
 * > Analysis (§15.3) MUST test mutual information between affect choice and
 * > referent/task state, controlling for the stated emotional context; any
 * > unexpected correlation is treated as suspected leakage and reported as
 * > such, never silently dropped.
 *
 * E20 fixes the estimator and the decision rule:
 *
 * > Estimate conditional mutual information between affect and four-way
 * > referent after stratifying by binary success/failure outcome, using a
 * > Miller-Madow bias-corrected discrete estimator and within-outcome
 * > permutation null. For each seed, subtract the mean of 1,000 within-outcome
 * > permutations from the observed Miller-Madow estimate; test whether the
 * > seed-bootstrap one-sided 95% upper bound on this excess CMI is below 0.02
 * > bits.
 *
 * {@link evaluateAffectLeakage} implements exactly that and returns a
 * canonical object ready to be written as a bundle attachment of kind
 * `affect-leakage` (docs/evidence-bundle-format.md §10). It does not write the
 * attachment, does not touch the Evidence Store, and does not interpret the
 * result: `decision` is the mechanical outcome of the pre-registered rule
 * applied to the numbers, and `suspectedLeakage` is the §9.3 rule 7 reporting
 * obligation — never a claim that a run did or did not leak.
 *
 * Honesty constraints encoded here:
 *
 * - a seed with too few eligible windows is reported as ineligible and
 *   excluded from the bound, never quietly padded or included;
 * - `meetsE20SeedCount` / `meetsE20WindowCount` say whether the input reaches
 *   E20's registered scale (75 seeds, 1,000 windows per seed). A Mode P
 *   readiness run over a handful of windows will report `false` for both, and
 *   the decision must not be presented as an E20 result;
 * - per-seed excesses above the bound are always listed, even when the
 *   aggregate bound passes, so an "unexpected correlation" cannot vanish into
 *   an aggregate.
 */
import { AFFECT_DISPLAY_IDS, type AffectDisplayId } from '@ald/types';

import { AnalysisError, assertLevel, assertProbability } from './errors.js';
import {
  millerMadowConditionalMutualInformationBits,
  permutationNullWithinStrata,
  replicateQuantile,
  seedBootstrapUpperBound,
  stratifiedJointCounts,
  type StratifiedObservation,
} from './information.js';

/** Version stamped on the attachment; bump on any estimator change. */
export const AFFECT_LEAKAGE_ANALYSIS_VERSION = 'affect-leakage-v1';

/** The estimator E20 registers, named in the output for reproducibility. */
export const AFFECT_LEAKAGE_ESTIMATOR =
  'miller-madow-conditional-mutual-information-stratified-by-outcome';

/** E20: the excess-CMI bound in bits. */
export const E20_EXCESS_CMI_BOUND_BITS = 0.02;
/** E20: within-outcome permutations per seed. */
export const E20_PERMUTATIONS = 1_000;
/** E20: eligible affect windows required per seed. */
export const E20_MINIMUM_WINDOWS_PER_SEED = 1_000;
/** E20: independent seeds required per enabled affect condition. */
export const E20_MINIMUM_SEEDS = 75;
/** E20: the referent is four-way. */
export const E20_REFERENT_LEVELS = 4;
/** SPEC §9.3: the display allowlist has six members. */
export const AFFECT_DISPLAY_LEVELS = AFFECT_DISPLAY_IDS.length;
/** SPEC §15.3 α. */
export const DEFAULT_ALPHA = 0.05;
/** Strata: binary success/failure outcome. */
const OUTCOME_STRATA = 2;
/** Decimals every reported number is rounded to, for canonical stability. */
const ANALYSIS_DECIMALS = 12;

/** One eligible affect window, as recorded by the Gateway and the runtime. */
export interface AffectLeakageWindow {
  /** The sender's chosen display (`AffectEvent.displayId`). */
  displayId: AffectDisplayId;
  /** Zero-based referent type code for the turn the window followed. */
  referentTypeCode: number;
  /** The turn's binary outcome; the stratifying variable. */
  success: boolean;
}

export interface AffectLeakageSeedInput {
  /** Run seed label; only used for reporting and stream derivation. */
  seed: string;
  windows: readonly AffectLeakageWindow[];
}

export interface AffectLeakageInput {
  perSeed: readonly AffectLeakageSeedInput[];
  /** Analysis seed; every permutation and bootstrap stream derives from it. */
  seed: string;
  /** Default {@link E20_PERMUTATIONS}. */
  permutations?: number;
  /** Default {@link E20_EXCESS_CMI_BOUND_BITS}. */
  bound?: number;
  /** Default {@link DEFAULT_ALPHA}. */
  alpha?: number;
  /** Default {@link E20_REFERENT_LEVELS}. */
  referentLevels?: number;
  /** Default {@link E20_MINIMUM_WINDOWS_PER_SEED}. */
  minimumWindowsPerSeed?: number;
  /** Bootstrap resamples over seeds; default 10,000. */
  bootstrapIterations?: number;
}

export interface AffectLeakageSeedResult {
  seed: string;
  windows: number;
  /** False when `windows < minimumWindowsPerSeed`; excluded from the bound. */
  eligible: boolean;
  /** Miller-Madow CMI of the observed data, in bits. */
  observedCmiBits: number;
  /** Mean of the within-outcome permutation null, in bits. */
  permutationMeanBits: number;
  /** `observed − null mean`: E20's excess CMI, in bits. */
  excessCmiBits: number;
  /** The `1 − α` quantile of the null replicates, in bits. */
  permutationUpperQuantileBits: number;
  /** True when the observed CMI exceeds that null quantile. */
  exceedsPermutationNull: boolean;
  /** True when this seed's excess alone exceeds the bound. */
  excessAboveBound: boolean;
}

export type AffectLeakageDecision =
  | 'below-bound'
  | 'not-below-bound'
  | 'insufficient-windows';

export interface AffectLeakageResult {
  analysisVersion: typeof AFFECT_LEAKAGE_ANALYSIS_VERSION;
  estimator: typeof AFFECT_LEAKAGE_ESTIMATOR;
  displayLevels: number;
  referentLevels: number;
  outcomeStrata: number;
  permutations: number;
  boundBits: number;
  alpha: number;
  minimumWindowsPerSeed: number;
  seed: string;
  bootstrapIterations: number;
  seeds: number;
  eligibleSeeds: number;
  totalWindows: number;
  perSeed: AffectLeakageSeedResult[];
  /** Mean excess CMI over eligible seeds, in bits; 0 when none are eligible. */
  meanExcessCmiBits: number;
  /** One-sided `1 − α` upper bound on the mean excess, in bits. */
  excessCmiUpperBoundBits: number;
  decision: AffectLeakageDecision;
  /**
   * SPEC §9.3 rule 7: set whenever the pre-registered rule did not clear the
   * bound. It is a reporting obligation, not a finding.
   */
  suspectedLeakage: boolean;
  /** Seeds whose own excess exceeded the bound, always reported. */
  seedsAboveBound: number;
  /** Seeds whose observed CMI exceeded their own null `1 − α` quantile. */
  seedsExceedingNull: number;
  /** Whether the input reaches E20's registered seed count. */
  meetsE20SeedCount: boolean;
  /** Whether every eligible seed reaches E20's registered window count. */
  meetsE20WindowCount: boolean;
}

function round(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AnalysisError('domain', 'estimator produced a non-finite value');
  }
  const factor = 10 ** ANALYSIS_DECIMALS;
  return Math.round(value * factor) / factor;
}

function displayIndex(displayId: AffectDisplayId, where: string): number {
  const index = (AFFECT_DISPLAY_IDS as readonly string[]).indexOf(displayId);
  if (index < 0) {
    throw new AnalysisError(
      'domain',
      `${where}.displayId must be one of the six allowlisted displays`,
    );
  }
  return index;
}

function toObservations(
  windows: readonly AffectLeakageWindow[],
  referentLevels: number,
  seed: string,
): StratifiedObservation[] {
  return windows.map((window, index) => {
    const where = `perSeed[${seed}].windows[${index}]`;
    const referent = window.referentTypeCode;
    if (
      !Number.isInteger(referent) ||
      referent < 0 ||
      referent >= referentLevels
    ) {
      throw new AnalysisError(
        'domain',
        `${where}.referentTypeCode must be an integer within [0, ${referentLevels - 1}]`,
      );
    }
    if (typeof window.success !== 'boolean') {
      throw new AnalysisError('domain', `${where}.success must be a boolean`);
    }
    return {
      x: displayIndex(window.displayId, where),
      y: referent,
      stratum: window.success ? 1 : 0,
    };
  });
}

/**
 * Runs the E20 estimator over per-seed affect windows.
 *
 * Determinism: every permutation stream is
 * `seed → 'affect-leakage' → 'permutation' → <seed label>` and the bootstrap
 * stream is `seed → 'affect-leakage' → 'bootstrap'`, so two calls with the
 * same input and seed return byte-identical canonical JSON.
 *
 * The input is never modified, and no window is ever excluded except by the
 * declared `minimumWindowsPerSeed` eligibility rule.
 */
export function evaluateAffectLeakage(
  input: AffectLeakageInput,
): AffectLeakageResult {
  if (typeof input.seed !== 'string' || input.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }
  if (input.perSeed.length === 0) {
    throw new AnalysisError('empty-sample', 'perSeed must not be empty');
  }
  const permutations = input.permutations ?? E20_PERMUTATIONS;
  const bound = input.bound ?? E20_EXCESS_CMI_BOUND_BITS;
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const referentLevels = input.referentLevels ?? E20_REFERENT_LEVELS;
  const minimumWindowsPerSeed =
    input.minimumWindowsPerSeed ?? E20_MINIMUM_WINDOWS_PER_SEED;
  const bootstrapIterations = input.bootstrapIterations ?? 10_000;

  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new AnalysisError('domain', 'permutations must be a positive integer');
  }
  if (!Number.isFinite(bound) || bound < 0) {
    throw new AnalysisError('domain', 'bound must be a non-negative number');
  }
  assertProbability(alpha, 'alpha');
  assertLevel(1 - alpha, 'one-sided level');
  if (!Number.isInteger(referentLevels) || referentLevels < 2) {
    throw new AnalysisError(
      'domain',
      'referentLevels must be an integer of at least 2',
    );
  }
  if (!Number.isInteger(minimumWindowsPerSeed) || minimumWindowsPerSeed < 1) {
    throw new AnalysisError(
      'domain',
      'minimumWindowsPerSeed must be a positive integer',
    );
  }
  if (new Set(input.perSeed.map((entry) => entry.seed)).size !== input.perSeed.length) {
    throw new AnalysisError('domain', 'perSeed seed labels must be unique');
  }

  const levels = {
    xLevels: AFFECT_DISPLAY_LEVELS,
    yLevels: referentLevels,
    strata: OUTCOME_STRATA,
  };
  const permutationRoot = `${input.seed}/affect-leakage/permutation`;

  const perSeed: AffectLeakageSeedResult[] = [];
  let totalWindows = 0;

  for (const entry of input.perSeed) {
    if (typeof entry.seed !== 'string' || entry.seed.length === 0) {
      throw new AnalysisError('domain', 'perSeed[].seed must be a non-empty string');
    }
    const observations = toObservations(entry.windows, referentLevels, entry.seed);
    totalWindows += observations.length;
    const eligible = observations.length >= minimumWindowsPerSeed;

    if (observations.length === 0) {
      perSeed.push({
        seed: entry.seed,
        windows: 0,
        eligible: false,
        observedCmiBits: 0,
        permutationMeanBits: 0,
        excessCmiBits: 0,
        permutationUpperQuantileBits: 0,
        exceedsPermutationNull: false,
        excessAboveBound: false,
      });
      continue;
    }

    const observed = millerMadowConditionalMutualInformationBits(
      stratifiedJointCounts(observations, levels),
    );
    const nullResult = permutationNullWithinStrata(observations, levels, {
      permutations,
      seed: `${permutationRoot}/${entry.seed}`,
    });
    const excess = observed - nullResult.mean;
    const upperQuantile = replicateQuantile(nullResult.replicates, 1 - alpha);

    perSeed.push({
      seed: entry.seed,
      windows: observations.length,
      eligible,
      observedCmiBits: round(observed),
      permutationMeanBits: round(nullResult.mean),
      excessCmiBits: round(excess),
      permutationUpperQuantileBits: round(upperQuantile),
      exceedsPermutationNull: observed > upperQuantile,
      excessAboveBound: excess > bound,
    });
  }

  const eligible = perSeed.filter((result) => result.eligible);
  const excesses = eligible.map((result) => result.excessCmiBits);

  let meanExcess = 0;
  let upperBound = 0;
  let decision: AffectLeakageDecision = 'insufficient-windows';
  if (excesses.length > 0) {
    const bootstrap = seedBootstrapUpperBound(excesses, {
      seed: `${input.seed}/affect-leakage/bootstrap`,
      iterations: bootstrapIterations,
      level: 1 - alpha,
    });
    meanExcess = round(bootstrap.estimate);
    upperBound = round(bootstrap.upperBound);
    decision = upperBound < bound ? 'below-bound' : 'not-below-bound';
  }

  return {
    analysisVersion: AFFECT_LEAKAGE_ANALYSIS_VERSION,
    estimator: AFFECT_LEAKAGE_ESTIMATOR,
    displayLevels: AFFECT_DISPLAY_LEVELS,
    referentLevels,
    outcomeStrata: OUTCOME_STRATA,
    permutations,
    boundBits: bound,
    alpha,
    minimumWindowsPerSeed,
    seed: input.seed,
    bootstrapIterations,
    seeds: perSeed.length,
    eligibleSeeds: eligible.length,
    totalWindows,
    perSeed,
    meanExcessCmiBits: meanExcess,
    excessCmiUpperBoundBits: upperBound,
    decision,
    suspectedLeakage: decision !== 'below-bound',
    seedsAboveBound: perSeed.filter((result) => result.excessAboveBound).length,
    seedsExceedingNull: perSeed.filter((result) => result.exceedsPermutationNull)
      .length,
    meetsE20SeedCount: eligible.length >= E20_MINIMUM_SEEDS,
    meetsE20WindowCount:
      eligible.length > 0 &&
      eligible.every(
        (result) => result.windows >= E20_MINIMUM_WINDOWS_PER_SEED,
      ),
  };
}
