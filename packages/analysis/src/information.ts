/**
 * Discrete information-theoretic estimators for the SPECIFICATION.md §15.3
 * leakage analyses (SPEC §9.3 rule 7, §9.2; EXPERIMENT-NOTEBOOK.md E20).
 *
 * E20 names the estimator exactly, and this module implements that name and
 * nothing more:
 *
 * > Estimate conditional mutual information between affect and four-way
 * > referent after stratifying by binary success/failure outcome, using a
 * > Miller-Madow bias-corrected discrete estimator and within-outcome
 * > permutation null.
 *
 * Everything here is a pure function of counts plus, where randomness is
 * needed, a `SeededPrng` stream, so a leakage analysis replays bit-for-bit
 * from the registered seed (SPEC §14.3, RESEARCH.md Appendix D §D.1).
 *
 * Estimator notes, stated plainly because they bound what any result means:
 *
 * - the plug-in ("maximum likelihood") entropy of a finite sample is
 *   *downward* biased and the plug-in mutual information is therefore
 *   *upward* biased. Miller-Madow adds the first-order correction
 *   `(K̂ − 1) / (2 N ln 2)` bits, where `K̂` counts the bins actually observed.
 *   It reduces, and does not remove, that bias — which is exactly why E20
 *   pairs it with a permutation null and compares the *excess* over the null
 *   mean against the bound rather than the raw estimate;
 * - a conditional estimate is the stratum-weighted mean of within-stratum
 *   estimates, so a stratum with no observations contributes nothing and a
 *   stratum with one observation contributes zero information;
 * - none of these functions decides anything. `affect-leakage.ts` applies the
 *   pre-registered rule; the numbers here are inputs to that rule, never a
 *   scientific conclusion.
 */
import { SeededPrng } from '@ald/hashing';

import { AnalysisError, assertCount, assertLevel, assertSample } from './errors.js';
import { mean as sampleMean, quantileSorted } from './descriptive.js';

const LN2 = Math.LN2;

/** A joint contingency table: `table[x][y]` is a non-negative count. */
export type JointCounts = readonly (readonly number[])[];

/** One observation of two discrete variables inside one stratum. */
export interface StratifiedObservation {
  /** Zero-based level of the first variable. */
  x: number;
  /** Zero-based level of the second variable. */
  y: number;
  /** Zero-based stratum index (E20: the binary outcome). */
  stratum: number;
}

function assertCounts(counts: readonly number[], label: string): void {
  if (counts.length === 0) {
    throw new AnalysisError('empty-sample', `${label} must not be empty`);
  }
  for (let index = 0; index < counts.length; index += 1) {
    assertCount(counts[index] as number, `${label}[${index}]`);
  }
}

function total(counts: readonly number[]): number {
  let sum = 0;
  for (const count of counts) {
    sum += count;
  }
  return sum;
}

/** Number of bins with a non-zero count: Miller-Madow's `K̂`. */
export function observedSupport(counts: readonly number[]): number {
  let support = 0;
  for (const count of counts) {
    if (count > 0) {
      support += 1;
    }
  }
  return support;
}

/**
 * Plug-in Shannon entropy in bits. An empty sample (every count zero) has
 * entropy 0 by convention, matching the `0 log 0 = 0` convention inside the
 * sum.
 */
export function shannonEntropyBits(counts: readonly number[]): number {
  assertCounts(counts, 'counts');
  const n = total(counts);
  if (n === 0) {
    return 0;
  }
  let entropy = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / n;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * Miller-Madow bias-corrected entropy in bits:
 * `Ĥ_MM = Ĥ_plug-in + (K̂ − 1) / (2 N ln 2)`.
 */
export function millerMadowEntropyBits(counts: readonly number[]): number {
  assertCounts(counts, 'counts');
  const n = total(counts);
  if (n === 0) {
    return 0;
  }
  const support = observedSupport(counts);
  return shannonEntropyBits(counts) + (support - 1) / (2 * n * LN2);
}

function assertJoint(joint: JointCounts): void {
  if (joint.length === 0) {
    throw new AnalysisError('empty-sample', 'joint must have at least one row');
  }
  const width = (joint[0] as readonly number[]).length;
  if (width === 0) {
    throw new AnalysisError('empty-sample', 'joint rows must not be empty');
  }
  for (let row = 0; row < joint.length; row += 1) {
    const values = joint[row] as readonly number[];
    if (values.length !== width) {
      throw new AnalysisError(
        'length-mismatch',
        'every joint row must have the same length',
      );
    }
    assertCounts(values, `joint[${row}]`);
  }
}

function flatten(joint: JointCounts): number[] {
  const flat: number[] = [];
  for (const row of joint) {
    for (const count of row) {
      flat.push(count);
    }
  }
  return flat;
}

function rowMargin(joint: JointCounts): number[] {
  return joint.map((row) => total(row as readonly number[]));
}

function columnMargin(joint: JointCounts): number[] {
  const width = (joint[0] as readonly number[]).length;
  const margin = new Array<number>(width).fill(0);
  for (const row of joint) {
    for (let column = 0; column < width; column += 1) {
      margin[column] = (margin[column] as number) + ((row[column] as number) ?? 0);
    }
  }
  return margin;
}

/** Plug-in mutual information in bits, `Ĥ(X) + Ĥ(Y) − Ĥ(X,Y)`. */
export function mutualInformationBits(joint: JointCounts): number {
  assertJoint(joint);
  const flat = flatten(joint);
  if (total(flat) === 0) {
    return 0;
  }
  return Math.max(
    0,
    shannonEntropyBits(rowMargin(joint)) +
      shannonEntropyBits(columnMargin(joint)) -
      shannonEntropyBits(flat),
  );
}

/**
 * Miller-Madow mutual information in bits: the same identity with each of the
 * three entropies corrected separately, so the joint table's larger observed
 * support drives the correction's sign.
 *
 * The result is *not* clamped at zero: the correction can push an estimate
 * slightly negative on independent data, and clamping would bias the
 * permutation null upward and make the E20 comparison optimistic.
 */
export function millerMadowMutualInformationBits(joint: JointCounts): number {
  assertJoint(joint);
  const flat = flatten(joint);
  if (total(flat) === 0) {
    return 0;
  }
  return (
    millerMadowEntropyBits(rowMargin(joint)) +
    millerMadowEntropyBits(columnMargin(joint)) -
    millerMadowEntropyBits(flat)
  );
}

/**
 * Stratum-weighted conditional mutual information `Î(X;Y|Z)` in bits, with
 * `Î` the Miller-Madow estimator inside each stratum and weights `N_z / N`.
 */
export function millerMadowConditionalMutualInformationBits(
  strata: readonly JointCounts[],
): number {
  if (strata.length === 0) {
    throw new AnalysisError('empty-sample', 'strata must not be empty');
  }
  const sizes = strata.map((joint) => {
    assertJoint(joint);
    return total(flatten(joint));
  });
  const n = total(sizes);
  if (n === 0) {
    return 0;
  }
  let cmi = 0;
  for (let index = 0; index < strata.length; index += 1) {
    const size = sizes[index] as number;
    if (size === 0) {
      continue;
    }
    cmi +=
      (size / n) *
      millerMadowMutualInformationBits(strata[index] as JointCounts);
  }
  return cmi;
}

/** Plug-in conditional mutual information in bits, for comparison/tests. */
export function conditionalMutualInformationBits(
  strata: readonly JointCounts[],
): number {
  if (strata.length === 0) {
    throw new AnalysisError('empty-sample', 'strata must not be empty');
  }
  const sizes = strata.map((joint) => {
    assertJoint(joint);
    return total(flatten(joint));
  });
  const n = total(sizes);
  if (n === 0) {
    return 0;
  }
  let cmi = 0;
  for (let index = 0; index < strata.length; index += 1) {
    const size = sizes[index] as number;
    if (size === 0) {
      continue;
    }
    cmi += (size / n) * mutualInformationBits(strata[index] as JointCounts);
  }
  return cmi;
}

export interface LevelCounts {
  /** Number of levels of `x` (E20: six affect displays). */
  xLevels: number;
  /** Number of levels of `y` (E20: the four-way referent). */
  yLevels: number;
  /** Number of strata (E20: two, success and failure). */
  strata: number;
}

function assertLevels(levels: LevelCounts): void {
  for (const [label, value] of [
    ['xLevels', levels.xLevels],
    ['yLevels', levels.yLevels],
    ['strata', levels.strata],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new AnalysisError('domain', `${label} must be a positive integer`);
    }
  }
}

function emptyTable(xLevels: number, yLevels: number): number[][] {
  return Array.from({ length: xLevels }, () =>
    new Array<number>(yLevels).fill(0),
  );
}

/** Contingency tables, one per stratum, built from raw observations. */
export function stratifiedJointCounts(
  observations: readonly StratifiedObservation[],
  levels: LevelCounts,
): number[][][] {
  assertLevels(levels);
  const tables = Array.from({ length: levels.strata }, () =>
    emptyTable(levels.xLevels, levels.yLevels),
  );
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index] as StratifiedObservation;
    assertIndex(observation.x, levels.xLevels, `observations[${index}].x`);
    assertIndex(observation.y, levels.yLevels, `observations[${index}].y`);
    assertIndex(
      observation.stratum,
      levels.strata,
      `observations[${index}].stratum`,
    );
    const table = tables[observation.stratum] as number[][];
    const row = table[observation.x] as number[];
    row[observation.y] = (row[observation.y] as number) + 1;
  }
  return tables;
}

function assertIndex(value: number, levels: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= levels) {
    throw new AnalysisError(
      'domain',
      `${label} must be an integer within [0, ${levels - 1}]`,
    );
  }
}

export interface PermutationNullOptions {
  /** Number of within-stratum permutations (E20 registers 1,000). */
  permutations: number;
  /** Required: the toolkit never draws unseeded randomness. */
  seed: string;
}

export interface PermutationNullResult {
  /** Replicate statistics, in draw order. */
  replicates: number[];
  /** Mean of the replicates: E20's quantity to subtract from the observed. */
  mean: number;
  permutations: number;
  seed: string;
}

/**
 * The E20 within-outcome permutation null: inside each stratum, the `y` labels
 * are shuffled against the `x` labels, which destroys any within-stratum
 * association while preserving both margins and the stratum sizes. The
 * statistic is the Miller-Madow conditional mutual information.
 *
 * Shuffling *within* strata is the whole point: a permutation across strata
 * would also destroy the outcome→display and outcome→referent relationships
 * that §9.3 rule 7 says to control for, and would make the null too easy to
 * beat.
 */
export function permutationNullWithinStrata(
  observations: readonly StratifiedObservation[],
  levels: LevelCounts,
  options: PermutationNullOptions,
): PermutationNullResult {
  assertLevels(levels);
  if (!Number.isInteger(options.permutations) || options.permutations < 1) {
    throw new AnalysisError('domain', 'permutations must be a positive integer');
  }
  if (typeof options.seed !== 'string' || options.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }

  // Group the (x, y) pairs by stratum once; each replicate then shuffles the
  // stratum's y column in place over a copy.
  const xByStratum: number[][] = Array.from(
    { length: levels.strata },
    () => [],
  );
  const yByStratum: number[][] = Array.from(
    { length: levels.strata },
    () => [],
  );
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index] as StratifiedObservation;
    assertIndex(observation.x, levels.xLevels, `observations[${index}].x`);
    assertIndex(observation.y, levels.yLevels, `observations[${index}].y`);
    assertIndex(
      observation.stratum,
      levels.strata,
      `observations[${index}].stratum`,
    );
    (xByStratum[observation.stratum] as number[]).push(observation.x);
    (yByStratum[observation.stratum] as number[]).push(observation.y);
  }

  const prng = new SeededPrng(options.seed);
  const replicates = new Array<number>(options.permutations);
  for (let replicate = 0; replicate < options.permutations; replicate += 1) {
    const tables: number[][][] = [];
    for (let stratum = 0; stratum < levels.strata; stratum += 1) {
      const xs = xByStratum[stratum] as number[];
      const ys = shuffleInPlace([...(yByStratum[stratum] as number[])], prng);
      const table = emptyTable(levels.xLevels, levels.yLevels);
      for (let index = 0; index < xs.length; index += 1) {
        const row = table[xs[index] as number] as number[];
        const column = ys[index] as number;
        row[column] = (row[column] as number) + 1;
      }
      tables.push(table);
    }
    replicates[replicate] =
      millerMadowConditionalMutualInformationBits(tables);
  }

  return {
    replicates,
    mean: replicates.length === 0 ? 0 : sampleMean(replicates),
    permutations: options.permutations,
    seed: options.seed,
  };
}

/** Fisher-Yates over the given array, using the shared seeded stream. */
function shuffleInPlace(values: number[], prng: SeededPrng): number[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = prng.nextInt(index + 1);
    const held = values[index] as number;
    values[index] = values[swap] as number;
    values[swap] = held;
  }
  return values;
}

export interface OneSidedBoundOptions {
  seed: string;
  iterations?: number;
  /** One-sided coverage, e.g. `0.95`. */
  level?: number;
}

export interface OneSidedUpperBound {
  /** Mean of the original sample. */
  estimate: number;
  /** One-sided upper bound at `level` over bootstrap replicate means. */
  upperBound: number;
  n: number;
  iterations: number;
  level: number;
  seed: string;
}

const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_ONE_SIDED_LEVEL = 0.95;

/**
 * E20's seed-bootstrap one-sided upper bound: resample the seed-level values
 * with replacement and take the `level` quantile of the replicate means. The
 * bound is one-sided by construction — the pre-registered decision is "is the
 * upper bound below 0.02 bits", so only the upper tail matters.
 */
export function seedBootstrapUpperBound(
  values: readonly number[],
  options: OneSidedBoundOptions,
): OneSidedUpperBound {
  assertSample(values, 'values');
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const level = options.level ?? DEFAULT_ONE_SIDED_LEVEL;
  if (typeof options.seed !== 'string' || options.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new AnalysisError('domain', 'iterations must be a positive integer');
  }
  assertLevel(level, 'level');

  const prng = new SeededPrng(options.seed);
  const n = values.length;
  const replicates = new Array<number>(iterations);
  for (let replicate = 0; replicate < iterations; replicate += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) {
      sum += values[prng.nextInt(n)] as number;
    }
    replicates[replicate] = sum / n;
  }
  const sorted = [...replicates].sort((a, b) => a - b);

  return {
    estimate: sampleMean(values),
    upperBound: quantileSorted(sorted, level),
    n,
    iterations,
    level,
    seed: options.seed,
  };
}

/** The `probability` quantile of an unsorted replicate sample. */
export function replicateQuantile(
  replicates: readonly number[],
  probability: number,
): number {
  assertSample(replicates, 'replicates');
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new AnalysisError('domain', 'probability must be within [0, 1]');
  }
  return quantileSorted(
    [...replicates].sort((a, b) => a - b),
    probability,
  );
}
