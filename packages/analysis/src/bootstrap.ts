/**
 * Percentile bootstrap over seed-level outcomes (RESEARCH.md Appendix D §D.6
 * item 2 "Oracle adequacy": lower bound of the two-sided 95% bootstrap
 * interval for mean seed-level oracle success; item 3 "Oracle separation":
 * paired seed-level oracle-minus-control differences).
 *
 * Randomness comes only from `SeededPrng` (@ald/hashing), so a bootstrap is a
 * pure function of `(values, seed, iterations, confidence)` and replays
 * exactly from the registered seed manifest (SPECIFICATION.md §14.3,
 * Appendix D §D.4).
 */
import { SeededPrng } from '@ald/hashing';

import {
  AnalysisError,
  assertLevel,
  assertSample,
} from './errors.js';
import {
  mean as sampleMean,
  quantileSorted,
  type ConfidenceInterval,
} from './descriptive.js';

export interface BootstrapOptions {
  /** Required: the toolkit never draws unseeded randomness. */
  readonly seed: string;
  /** Resample count; Appendix D-scale analyses use the 10000 default. */
  readonly iterations?: number;
  /** Two-sided coverage of the returned interval. */
  readonly confidence?: number;
}

export interface BootstrapCi extends ConfidenceInterval {
  /** Observed statistic on the original sample (not the replicate mean). */
  readonly estimate: number;
  readonly n: number;
  readonly iterations: number;
  readonly seed: string;
}

const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_CONFIDENCE = 0.95;

interface ResolvedOptions {
  readonly seed: string;
  readonly iterations: number;
  readonly confidence: number;
}

function resolveOptions(options: BootstrapOptions): ResolvedOptions {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  if (typeof options.seed !== 'string' || options.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new AnalysisError('domain', 'iterations must be a positive integer');
  }
  assertLevel(confidence, 'confidence');
  return { seed: options.seed, iterations, confidence };
}

/**
 * Bootstrap replicate means, in draw order. Resampling draws `n` indices with
 * replacement per replicate from a single `SeededPrng` stream, so the whole
 * sequence is fixed by the seed.
 */
export function bootstrapMeanReplicates(
  values: readonly number[],
  options: BootstrapOptions,
): number[] {
  assertSample(values, 'values');
  const resolved = resolveOptions(options);
  const prng = new SeededPrng(resolved.seed);
  const n = values.length;
  const replicates = new Array<number>(resolved.iterations);
  for (let replicate = 0; replicate < resolved.iterations; replicate += 1) {
    let total = 0;
    for (let draw = 0; draw < n; draw += 1) {
      total += values[prng.nextInt(n)] as number;
    }
    replicates[replicate] = total / n;
  }
  return replicates;
}

/**
 * Bootstrap replicate means of the paired differences `a[i] - b[i]`. Pairs are
 * resampled as units, which is what a paired seed-level contrast requires
 * (Appendix D §D.6 item 3: the same scenario seed is used in every condition,
 * so oracle and control outcomes are paired by seed slot).
 */
export function bootstrapPairedDifferenceReplicates(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions,
): number[] {
  assertSample(a, 'a');
  assertSample(b, 'b');
  if (a.length !== b.length) {
    throw new AnalysisError(
      'length-mismatch',
      'paired samples must have equal length',
    );
  }
  const differences = a.map((value, index) => value - (b[index] as number));
  return bootstrapMeanReplicates(differences, options);
}

/**
 * Percentile interval from replicates: the `(1 - level) / 2` and
 * `1 - (1 - level) / 2` empirical quantiles (type-7 interpolation).
 */
export function percentileInterval(
  replicates: readonly number[],
  level: number,
): ConfidenceInterval {
  assertSample(replicates, 'replicates');
  assertLevel(level, 'level');
  const sorted = [...replicates].sort((left, right) => left - right);
  const tail = (1 - level) / 2;
  return {
    lower: quantileSorted(sorted, tail),
    upper: quantileSorted(sorted, 1 - tail),
    level,
  };
}

/** Percentile bootstrap confidence interval for the mean of `values`. */
export function bootstrapMeanCi(
  values: readonly number[],
  options: BootstrapOptions,
): BootstrapCi {
  const resolved = resolveOptions(options);
  const replicates = bootstrapMeanReplicates(values, options);
  const interval = percentileInterval(replicates, resolved.confidence);
  return {
    ...interval,
    estimate: sampleMean(values),
    n: values.length,
    iterations: resolved.iterations,
    seed: resolved.seed,
  };
}

/**
 * Percentile bootstrap confidence interval for the mean paired difference
 * `a - b` (Appendix D §D.6 "Oracle separation").
 */
export function bootstrapPairedDifferenceCi(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions,
): BootstrapCi {
  const resolved = resolveOptions(options);
  const replicates = bootstrapPairedDifferenceReplicates(a, b, options);
  const interval = percentileInterval(replicates, resolved.confidence);
  const differences = a.map((value, index) => value - (b[index] as number));
  return {
    ...interval,
    estimate: sampleMean(differences),
    n: differences.length,
    iterations: resolved.iterations,
    seed: resolved.seed,
  };
}
