/**
 * Special functions the pre-registered statistics of SPECIFICATION.md §15.3
 * depend on. Dependency-free, deterministic, and double-precision: the same
 * inputs give bit-identical outputs on every machine that runs the analysis,
 * which is what makes a re-run of a registered analysis script reproducible
 * (RESEARCH.md §7.3, Appendix D §D.1).
 *
 * Algorithms follow the standard references: Lanczos for `logGamma`, the
 * modified Lentz continued fraction of Numerical Recipes (`betacf`) for the
 * regularized incomplete beta, the series/continued-fraction pair for the
 * regularized incomplete gamma (which supplies `erf` and hence `normalCdf`),
 * and Acklam's rational approximation plus one Halley step for
 * `normalQuantile`.
 */
import { AnalysisError, assertProbability } from './errors.js';

/** Relative convergence target for the continued fractions below. */
const EPSILON = 3e-16;
/** Guard against division by a vanishing denominator in Lentz's method. */
const TINY = 1e-300;
const MAX_ITERATIONS = 400;

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.9999999999998099, 676.5203681218851, -1259.1392167224028,
  771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
];

const LOG_SQRT_TWO_PI = 0.9189385332046727;
const SQRT_TWO_PI = 2.5066282746310002;

/**
 * Natural log of the gamma function for x > 0 (Lanczos, g = 7, 9 terms).
 * Relative error is at the 1e-15 level across the range the toolkit uses
 * (beta/binomial coefficients with small half-integer and integer arguments).
 */
export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) {
    throw new AnalysisError('domain', 'logGamma requires a finite x > 0');
  }
  const shifted = x - 1;
  let series = LANCZOS_COEFFICIENTS[0] as number;
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) {
    series += (LANCZOS_COEFFICIENTS[index] as number) / (shifted + index);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return (
    LOG_SQRT_TWO_PI + (shifted + 0.5) * Math.log(t) - t + Math.log(series)
  );
}

/** Natural log of the beta function B(a, b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Natural log of the binomial coefficient C(n, k) for integers 0 <= k <= n. */
export function logBinomialCoefficient(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) {
    throw new AnalysisError(
      'domain',
      'logBinomialCoefficient requires integers with 0 <= k <= n',
    );
  }
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Numerical Recipes `betacf`: the continued fraction for the incomplete beta,
 * evaluated with the modified Lentz algorithm. Only called for
 * x < (a + 1) / (a + b + 2), where it converges quickly; the caller applies
 * the symmetry swap for the other half of the range.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) {
    d = TINY;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    h *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) {
      return h;
    }
  }
  throw new AnalysisError(
    'no-convergence',
    'incomplete beta continued fraction did not converge',
  );
}

/**
 * Regularized incomplete beta I_x(a, b) — the CDF of the Beta(a, b)
 * distribution, and the engine behind `studentTCdf`.
 *
 * Exact reference value used in tests: I_0.5(2, 3) = 11/16 = 0.6875.
 */
export function regularizedIncompleteBeta(
  x: number,
  a: number,
  b: number,
): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    throw new AnalysisError(
      'domain',
      'regularizedIncompleteBeta requires a > 0 and b > 0',
    );
  }
  if (!Number.isFinite(x) || x < 0 || x > 1) {
    throw new AnalysisError(
      'domain',
      'regularizedIncompleteBeta requires x within [0, 1]',
    );
  }
  if (x === 0) {
    return 0;
  }
  if (x === 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Series expansion for P(a, x); used when x < a + 1. */
function lowerGammaSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let delta = sum;
  for (let index = 0; index < MAX_ITERATIONS; index += 1) {
    ap += 1;
    delta *= x / ap;
    sum += delta;
    if (Math.abs(delta) < Math.abs(sum) * EPSILON) {
      return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
  }
  throw new AnalysisError(
    'no-convergence',
    'lower incomplete gamma series did not converge',
  );
}

/** Modified Lentz continued fraction for Q(a, x); used when x >= a + 1. */
function upperGammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let index = 1; index <= MAX_ITERATIONS; index += 1) {
    const an = -index * (index - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) {
      d = TINY;
    }
    c = b + an / c;
    if (Math.abs(c) < TINY) {
      c = TINY;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) {
      return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
  }
  throw new AnalysisError(
    'no-convergence',
    'upper incomplete gamma continued fraction did not converge',
  );
}

/** Regularized lower incomplete gamma P(a, x). */
export function regularizedLowerGamma(a: number, x: number): number {
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(x) || x < 0) {
    throw new AnalysisError(
      'domain',
      'regularizedLowerGamma requires a > 0 and x >= 0',
    );
  }
  if (x === 0) {
    return 0;
  }
  return x < a + 1
    ? lowerGammaSeries(a, x)
    : 1 - upperGammaContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function regularizedUpperGamma(a: number, x: number): number {
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(x) || x < 0) {
    throw new AnalysisError(
      'domain',
      'regularizedUpperGamma requires a > 0 and x >= 0',
    );
  }
  if (x === 0) {
    return 1;
  }
  return x < a + 1
    ? 1 - lowerGammaSeries(a, x)
    : upperGammaContinuedFraction(a, x);
}

/**
 * Standard normal CDF via the incomplete gamma identity
 * `erf(z / sqrt(2)) = P(1/2, z^2 / 2)`, taking the upper-tail branch for
 * z < 0 so far-tail probabilities keep full relative precision.
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) {
    throw new AnalysisError('domain', 'normalCdf requires a number');
  }
  if (z === Infinity) {
    return 1;
  }
  if (z === -Infinity) {
    return 0;
  }
  const x = (z * z) / 2;
  return z >= 0
    ? 0.5 + 0.5 * regularizedLowerGamma(0.5, x)
    : 0.5 * regularizedUpperGamma(0.5, x);
}

/** Standard normal probability density. */
export function normalPdf(z: number): number {
  if (!Number.isFinite(z)) {
    throw new AnalysisError('domain', 'normalPdf requires a finite z');
  }
  return Math.exp(-0.5 * z * z) / SQRT_TWO_PI;
}

const ACKLAM_A: readonly number[] = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const ACKLAM_B: readonly number[] = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1, 1,
];
const ACKLAM_C: readonly number[] = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const ACKLAM_D: readonly number[] = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416, 1,
];
const ACKLAM_LOW = 0.02425;

/** Horner evaluation of a polynomial whose coefficients are highest-order first. */
function evaluatePolynomial(coefficients: readonly number[], x: number): number {
  let value = 0;
  for (const coefficient of coefficients) {
    value = value * x + coefficient;
  }
  return value;
}

/**
 * Standard normal quantile: Acklam's rational approximation (relative error
 * ~1.15e-9) refined by one Halley step against `normalCdf`, which brings the
 * result to double-precision agreement with the CDF. `normalQuantile(0.975)`
 * is 1.959963984540054.
 */
export function normalQuantile(p: number): number {
  assertProbability(p, 'p');
  if (p === 0) {
    return -Infinity;
  }
  if (p === 1) {
    return Infinity;
  }
  let x: number;
  if (p < ACKLAM_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = evaluatePolynomial(ACKLAM_C, q) / evaluatePolynomial(ACKLAM_D, q);
  } else if (p <= 1 - ACKLAM_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x =
      (q * evaluatePolynomial(ACKLAM_A, r)) / evaluatePolynomial(ACKLAM_B, r);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -evaluatePolynomial(ACKLAM_C, q) / evaluatePolynomial(ACKLAM_D, q);
  }
  const error = normalCdf(x) - p;
  const u = (error * SQRT_TWO_PI) / Math.exp(-0.5 * x * x);
  return x - u / (1 + (x * u) / 2);
}

/**
 * Student t CDF with `df` degrees of freedom, from the incomplete beta:
 * `P(T <= t) = 1 - I_{df/(df+t^2)}(df/2, 1/2) / 2` for t >= 0, mirrored below
 * zero. `studentTCdf(0, df)` is exactly 0.5.
 */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(df) || df <= 0) {
    throw new AnalysisError('domain', 'studentTCdf requires df > 0');
  }
  if (Number.isNaN(t)) {
    throw new AnalysisError('domain', 'studentTCdf requires a number t');
  }
  if (t === Infinity) {
    return 1;
  }
  if (t === -Infinity) {
    return 0;
  }
  const x = df / (df + t * t);
  const half = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - half : half;
}

/**
 * Convergence target for the quantile search, in probability units: tighter
 * than the 1e-10 the analysis plan needs so the returned quantile inverts the
 * CDF to better than 1e-10 in every case.
 */
const QUANTILE_TOLERANCE = 1e-12;

/**
 * Student t quantile: bisection on `studentTCdf` (monotone, so bisection is
 * unconditionally safe) refined until the CDF matches `p` to within 1e-12, or
 * the bracket collapses to double precision. `studentTQuantile(0.975, 10)` is
 * 2.2281388519...
 */
export function studentTQuantile(p: number, df: number): number {
  assertProbability(p, 'p');
  if (!Number.isFinite(df) || df <= 0) {
    throw new AnalysisError('domain', 'studentTQuantile requires df > 0');
  }
  if (p === 0) {
    return -Infinity;
  }
  if (p === 1) {
    return Infinity;
  }
  if (p === 0.5) {
    return 0;
  }
  if (p < 0.5) {
    return -studentTQuantile(1 - p, df);
  }
  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < p) {
    low = high;
    high *= 2;
    if (high > 1e300) {
      return Infinity;
    }
  }
  let middle = (low + high) / 2;
  for (let index = 0; index < 200; index += 1) {
    middle = (low + high) / 2;
    const value = studentTCdf(middle, df);
    if (Math.abs(value - p) <= QUANTILE_TOLERANCE) {
      return middle;
    }
    if (value < p) {
      low = middle;
    } else {
      high = middle;
    }
    if (high - low <= Number.EPSILON * Math.max(1, Math.abs(middle))) {
      return middle;
    }
  }
  return middle;
}

/**
 * Log of the binomial pmf `P(X = successes)` for `trials` Bernoulli draws with
 * success probability `probability`. Computed in log space so E11's exact
 * chance-rate tail (which sums hundreds of terms) does not underflow.
 */
export function binomialLogPmf(
  successes: number,
  trials: number,
  probability: number,
): number {
  if (!Number.isInteger(trials) || trials < 0) {
    throw new AnalysisError(
      'domain',
      'binomialLogPmf requires a non-negative integer trials',
    );
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new AnalysisError(
      'domain',
      'binomialLogPmf requires 0 <= successes <= trials',
    );
  }
  assertProbability(probability, 'probability');
  if (probability === 0) {
    return successes === 0 ? 0 : -Infinity;
  }
  if (probability === 1) {
    return successes === trials ? 0 : -Infinity;
  }
  return (
    logBinomialCoefficient(trials, successes) +
    successes * Math.log(probability) +
    (trials - successes) * Math.log1p(-probability)
  );
}
