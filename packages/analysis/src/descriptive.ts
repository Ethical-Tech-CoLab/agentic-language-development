/**
 * Descriptive statistics for seed-level and episode-level outcomes
 * (SPECIFICATION.md §15.3; RESEARCH.md Appendix D §D.6 "The unit of analysis
 * is the run/seed success proportion", §D.7 "Wilson intervals over pooled
 * episodes are descriptive only").
 */
import {
  AnalysisError,
  assertCount,
  assertLevel,
  assertSample,
} from './errors.js';
import { normalQuantile } from './special.js';

/** A two-sided interval and the level it was computed at. */
export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  /** Nominal coverage, e.g. 0.95. */
  readonly level: number;
}

export interface DescriptiveSummary {
  readonly n: number;
  readonly mean: number;
  /** Sample (n - 1) variance; `NaN` when n < 2, where it is undefined. */
  readonly variance: number;
  /** Square root of `variance`; `NaN` when n < 2. */
  readonly sd: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Sample summary with the unbiased (n - 1) variance. Throws on an empty
 * sample: a zero-seed condition is a data problem for the harness to report,
 * not a statistic. For n = 1 the mean/min/max are exact and variance/sd are
 * `NaN` (undefined, never silently 0). A sample whose values are all equal
 * (`min === max`) reports that common value as the mean and a variance of
 * exactly 0, which is what makes the zero-variance rule of `oneSampleTTest`
 * exact rather than floating-point dependent.
 */
export function summarize(values: readonly number[]): DescriptiveSummary {
  assertSample(values, 'values');
  const n = values.length;
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    total += value;
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  const mean = total / n;
  if (n < 2) {
    return { n, mean, variance: NaN, sd: NaN, min, max };
  }
  if (min === max) {
    // Exact point mass: report the common value and a variance of exactly
    // zero rather than the ~1e-33 that summing equal floats can leave behind,
    // so the degenerate branch of `oneSampleTTest` is reached reliably.
    return { n, mean: min, variance: 0, sd: 0, min, max };
  }
  let sumSquares = 0;
  for (const value of values) {
    const deviation = value - mean;
    sumSquares += deviation * deviation;
  }
  const variance = sumSquares / (n - 1);
  return { n, mean, variance, sd: Math.sqrt(variance), min, max };
}

/** Arithmetic mean of a non-empty finite sample. */
export function mean(values: readonly number[]): number {
  assertSample(values, 'values');
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * Type-7 (R default) empirical quantile with linear interpolation, computed on
 * a sorted copy so the caller's array is never mutated. Deterministic, which
 * is what the percentile bootstrap needs.
 */
export function quantile(values: readonly number[], probability: number): number {
  assertSample(values, 'values');
  if (
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new AnalysisError('domain', 'probability must be within [0, 1]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return quantileSorted(sorted, probability);
}

/** `quantile` for an already ascending array; used by the bootstrap. */
export function quantileSorted(
  sorted: readonly number[],
  probability: number,
): number {
  assertSample(sorted, 'sorted');
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] as number;
  if (low === high) {
    return lowValue;
  }
  const highValue = sorted[high] as number;
  return lowValue + (position - low) * (highValue - lowValue);
}

export interface ProportionSummary {
  readonly successes: number;
  readonly n: number;
  readonly proportion: number;
}

/** Observed proportion for `successes` out of `n` (n > 0). */
export function proportion(successes: number, n: number): ProportionSummary {
  assertCount(successes, 'successes');
  assertCount(n, 'n');
  if (n === 0) {
    throw new AnalysisError('empty-sample', 'n must be greater than zero');
  }
  if (successes > n) {
    throw new AnalysisError('domain', 'successes must not exceed n');
  }
  return { successes, n, proportion: successes / n };
}

/**
 * Pool independent success counts (Appendix D §D.7: episodes pooled across
 * seeds, descriptive only — never treated as independent runs, §D.6).
 */
export function pooledProportion(
  parts: readonly ProportionSummary[],
): ProportionSummary {
  let successes = 0;
  let n = 0;
  for (const part of parts) {
    successes += part.successes;
    n += part.n;
  }
  return proportion(successes, n);
}

/** Count of a 0/1 (or truthy-numeric) outcome vector, as a proportion. */
export function proportionOfSuccesses(
  outcomes: readonly number[],
): ProportionSummary {
  assertSample(outcomes, 'outcomes');
  let successes = 0;
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index] as number;
    if (outcome !== 0 && outcome !== 1) {
      throw new AnalysisError(
        'domain',
        `outcomes[${index}] must be 0 or 1`,
      );
    }
    successes += outcome;
  }
  return proportion(successes, outcomes.length);
}

export interface WilsonInterval extends ConfidenceInterval {
  /** The Wilson score centre (a shrunken point estimate), not `successes / n`. */
  readonly center: number;
  readonly successes: number;
  readonly n: number;
  /** Observed `successes / n`, reported alongside the shrunken centre. */
  readonly proportion: number;
}

/**
 * Wilson score interval for a binomial proportion (SPECIFICATION.md §15.3
 * confidence-interval reporting; RESEARCH.md Appendix D §D.7 pooled-episode
 * descriptive intervals). Bounds are clamped to [0, 1].
 *
 * Reference value used in tests: k = 8, n = 10 at 95% gives
 * [0.49016, 0.94332] with centre 0.71674 (the published four-place rounding
 * of this interval is [0.4902, 0.9433]).
 */
export function wilsonInterval(
  successes: number,
  n: number,
  confidence = 0.95,
): WilsonInterval {
  const observed = proportion(successes, n);
  assertLevel(confidence, 'confidence');
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = (observed.proportion + zSquared / (2 * n)) / denominator;
  const halfWidth =
    (z / denominator) *
    Math.sqrt(
      (observed.proportion * (1 - observed.proportion)) / n +
        zSquared / (4 * n * n),
    );
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    center,
    level: confidence,
    successes,
    n,
    proportion: observed.proportion,
  };
}
