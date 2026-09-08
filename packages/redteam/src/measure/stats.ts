/**
 * Two-sample statistics for the side-channel measurement library
 * (ALD-040 criterion 2, reused by ALD-067 criterion 2;
 * SPECIFICATION.md §10.3).
 *
 * §10.3 requires that "a rejected/failed turn and an accepted turn MUST
 * produce externally indistinguishable timing/size profiles where technically
 * feasible", and ALD-040 criterion 2 requires "a test harness measuring the
 * relevant channel … confirms the mitigation is effective within the
 * tolerance §10.3 implies". Indistinguishability is a two-sample question, so
 * this module provides the two-sample tools and nothing else:
 *
 * - Welch's t (unequal variances) with its Satterthwaite degrees of freedom
 *   and a two-sided p-value from the Student-t CDF;
 * - the two-sample Kolmogorov-Smirnov distance, which catches a difference in
 *   *shape* (a bimodal rejected-turn distribution with the same mean) that a
 *   t-test misses — the realistic timing-channel signature;
 * - Cohen's d, the effect size a tolerance is actually stated in, because a
 *   large enough sample makes any p-value small.
 *
 * Deliberately dependency-free (no `@ald/analysis` import): ALD-040 criterion
 * 3 requires the ALD-067 harness to *reuse* this tooling, and a measurement
 * library with no domain imports can be reused by a harness that is itself
 * measuring the Gateway.
 *
 * A p-value here is a diagnostic for an engineering tolerance, not a
 * pre-registered inferential test; §15.3 governs the latter and this module
 * makes no claim under it.
 */
import { RedTeamError, assertFiniteSample } from '../errors.js';

export function mean(values: readonly number[]): number {
  assertFiniteSample(values, 'sample');
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/** Unbiased sample variance; zero for a single observation. */
export function variance(values: readonly number[]): number {
  assertFiniteSample(values, 'sample');
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  let total = 0;
  for (const value of values) {
    total += (value - average) ** 2;
  }
  return total / (values.length - 1);
}

export function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

export interface WelchResult {
  t: number;
  degreesOfFreedom: number;
  /** Two-sided p-value of `t` under the Student-t distribution. */
  pValue: number;
}

/**
 * Welch's unequal-variance t test. Two samples with zero variance and equal
 * means are *identical*, which is the ideal normalization outcome: `t` is 0
 * and `pValue` is 1 rather than NaN.
 */
export function welchT(left: readonly number[], right: readonly number[]): WelchResult {
  assertFiniteSample(left, 'left');
  assertFiniteSample(right, 'right');
  const meanLeft = mean(left);
  const meanRight = mean(right);
  const varianceLeft = variance(left);
  const varianceRight = variance(right);
  const scaledLeft = varianceLeft / left.length;
  const scaledRight = varianceRight / right.length;
  const denominator = scaledLeft + scaledRight;
  if (denominator === 0) {
    return {
      t: meanLeft === meanRight ? 0 : Number.POSITIVE_INFINITY * Math.sign(meanLeft - meanRight),
      degreesOfFreedom: Math.max(1, left.length + right.length - 2),
      pValue: meanLeft === meanRight ? 1 : 0,
    };
  }
  const t = (meanLeft - meanRight) / Math.sqrt(denominator);
  const degreesOfFreedom =
    denominator ** 2 /
    (scaledLeft ** 2 / Math.max(1, left.length - 1) +
      scaledRight ** 2 / Math.max(1, right.length - 1));
  return { t, degreesOfFreedom, pValue: studentTTwoSidedP(t, degreesOfFreedom) };
}

function logGamma(value: number): number {
  // Lanczos approximation, g = 7, n = 9.
  const coefficients = [
    0.999_999_999_999_809_93, 676.520_368_121_885_1, -1_259.139_216_722_402_8,
    771.323_428_777_653_13, -176.615_029_162_140_6, 12.507_343_278_686_905,
    -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6, 1.505_632_735_149_311_6e-7,
  ];
  if (value < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value)
    );
  }
  const shifted = value - 1;
  let series = coefficients[0] ?? 0;
  for (let index = 1; index < coefficients.length; index += 1) {
    series += (coefficients[index] ?? 0) / (shifted + index);
  }
  const t = shifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(series)
  );
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) {
    d = tiny;
  }
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    result *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 3e-16) {
      break;
    }
  }
  return result;
}

/** Regularized incomplete beta `I_x(a, b)`. */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (Math.exp(
        logGamma(a + b) -
          logGamma(a) -
          logGamma(b) +
          b * Math.log(1 - x) +
          a * Math.log(x),
      ) *
        betaContinuedFraction(b, a, 1 - x)) /
        b;
}

/** Two-sided p-value of a t statistic with `degreesOfFreedom`. */
export function studentTTwoSidedP(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(t)) {
    return 0;
  }
  if (degreesOfFreedom <= 0) {
    throw new RedTeamError('domain', 'degreesOfFreedom must be positive');
  }
  const x = degreesOfFreedom / (degreesOfFreedom + t * t);
  return Math.min(1, Math.max(0, incompleteBeta(degreesOfFreedom / 2, 0.5, x)));
}

/** Pooled-standard-deviation Cohen's d; 0 when both samples are constant. */
export function cohensD(left: readonly number[], right: readonly number[]): number {
  assertFiniteSample(left, 'left');
  assertFiniteSample(right, 'right');
  const meanDifference = mean(left) - mean(right);
  const pooled = Math.sqrt(
    ((left.length - 1) * variance(left) + (right.length - 1) * variance(right)) /
      Math.max(1, left.length + right.length - 2),
  );
  if (pooled === 0) {
    return meanDifference === 0 ? 0 : Number.POSITIVE_INFINITY * Math.sign(meanDifference);
  }
  return meanDifference / pooled;
}

/** Two-sample Kolmogorov-Smirnov distance: max |ECDF difference|. */
export function ksDistance(left: readonly number[], right: readonly number[]): number {
  assertFiniteSample(left, 'left');
  assertFiniteSample(right, 'right');
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  let indexLeft = 0;
  let indexRight = 0;
  let distance = 0;
  while (indexLeft < sortedLeft.length && indexRight < sortedRight.length) {
    const valueLeft = sortedLeft[indexLeft] ?? 0;
    const valueRight = sortedRight[indexRight] ?? 0;
    const step = Math.min(valueLeft, valueRight);
    while (indexLeft < sortedLeft.length && (sortedLeft[indexLeft] ?? 0) <= step) {
      indexLeft += 1;
    }
    while (indexRight < sortedRight.length && (sortedRight[indexRight] ?? 0) <= step) {
      indexRight += 1;
    }
    distance = Math.max(
      distance,
      Math.abs(indexLeft / sortedLeft.length - indexRight / sortedRight.length),
    );
  }
  return Math.max(
    distance,
    Math.abs(indexLeft / sortedLeft.length - indexRight / sortedRight.length),
  );
}

/** Asymptotic p-value for a two-sample KS distance. */
export function ksTwoSampleP(
  distance: number,
  leftCount: number,
  rightCount: number,
): number {
  if (leftCount <= 0 || rightCount <= 0) {
    throw new RedTeamError('domain', 'sample sizes must be positive');
  }
  if (distance <= 0) {
    return 1;
  }
  const effective = (leftCount * rightCount) / (leftCount + rightCount);
  const root = Math.sqrt(effective);
  const lambda = (root + 0.12 + 0.11 / root) * distance;
  let total = 0;
  for (let term = 1; term <= 100; term += 1) {
    total += (term % 2 === 1 ? 1 : -1) * Math.exp(-2 * term * term * lambda * lambda);
  }
  return Math.min(1, Math.max(0, 2 * total));
}
