import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  binomialLogPmf,
  logBeta,
  logBinomialCoefficient,
  logGamma,
  normalCdf,
  normalPdf,
  normalQuantile,
  regularizedIncompleteBeta,
  regularizedLowerGamma,
  regularizedUpperGamma,
  studentTCdf,
  studentTQuantile,
} from '../src/index.js';

describe('logGamma', () => {
  it('matches closed-form values', () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
    // log(5!) = log(120)
    expect(logGamma(6)).toBeCloseTo(Math.log(120), 10);
  });

  it('rejects a non-positive argument', () => {
    expect(() => logGamma(0)).toThrow(AnalysisError);
    expect(() => logGamma(-1)).toThrow(/x > 0/);
  });
});

describe('logBeta and logBinomialCoefficient', () => {
  it('matches closed-form values', () => {
    // B(2, 3) = 1/12
    expect(Math.exp(logBeta(2, 3))).toBeCloseTo(1 / 12, 12);
    expect(Math.exp(logBinomialCoefficient(10, 3))).toBeCloseTo(120, 8);
    expect(logBinomialCoefficient(5, 0)).toBeCloseTo(0, 12);
  });

  it('rejects k outside 0..n', () => {
    expect(() => logBinomialCoefficient(5, 6)).toThrow(AnalysisError);
    expect(() => logBinomialCoefficient(5, -1)).toThrow(AnalysisError);
  });
});

describe('regularizedIncompleteBeta', () => {
  it('reproduces the exact value I_0.5(2, 3) = 11/16', () => {
    expect(regularizedIncompleteBeta(0.5, 2, 3)).toBeCloseTo(0.6875, 12);
  });

  it('is a CDF: 0 at 0, 1 at 1, and symmetric under the argument swap', () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    // I_x(a, b) = 1 - I_{1-x}(b, a) on both sides of the continued-fraction swap
    for (const x of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      expect(regularizedIncompleteBeta(x, 3.5, 0.5)).toBeCloseTo(
        1 - regularizedIncompleteBeta(1 - x, 0.5, 3.5),
        12,
      );
    }
  });

  it('rejects out-of-domain arguments', () => {
    expect(() => regularizedIncompleteBeta(1.5, 2, 3)).toThrow(AnalysisError);
    expect(() => regularizedIncompleteBeta(0.5, 0, 3)).toThrow(AnalysisError);
  });
});

describe('incomplete gamma', () => {
  it('splits unity between the lower and upper branches', () => {
    for (const x of [0.1, 0.5, 1, 2, 5, 20]) {
      expect(
        regularizedLowerGamma(0.5, x) + regularizedUpperGamma(0.5, x),
      ).toBeCloseTo(1, 12);
    }
  });
});

describe('normalCdf and normalQuantile', () => {
  it('is exactly 0.5 at zero and symmetric', () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(-1.5)).toBeCloseTo(1 - normalCdf(1.5), 14);
  });

  it('matches the standard 95% two-sided critical value', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 6);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 12);
  });

  it('round-trips across the tails to double precision', () => {
    for (const p of [1e-12, 1e-6, 0.01, 0.2, 0.5, 0.8, 0.99, 1 - 1e-9]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 12);
    }
  });

  it('returns the infinite quantiles at the boundary and rejects outside', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(() => normalQuantile(1.1)).toThrow(AnalysisError);
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 14);
  });
});

describe('studentTCdf', () => {
  it('matches the t(10) 97.5% point', () => {
    expect(studentTCdf(2.228139, 10)).toBeCloseTo(0.975, 4);
  });

  it('is exactly 0.5 at t = 0 for every df', () => {
    for (const df of [1, 2, 4, 10, 74, 1000]) {
      expect(studentTCdf(0, df)).toBe(0.5);
    }
  });

  it('is symmetric and approaches the normal for large df', () => {
    expect(studentTCdf(-1.7, 12)).toBeCloseTo(1 - studentTCdf(1.7, 12), 12);
    expect(studentTCdf(1.96, 1_000_000)).toBeCloseTo(normalCdf(1.96), 5);
  });

  it('rejects df <= 0', () => {
    expect(() => studentTCdf(1, 0)).toThrow(AnalysisError);
  });
});

describe('studentTQuantile', () => {
  it('matches the textbook t(10) 97.5% critical value', () => {
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 4);
  });

  it('is exactly zero at the median and mirrors below it', () => {
    expect(studentTQuantile(0.5, 7)).toBe(0);
    expect(studentTQuantile(0.05, 7)).toBeCloseTo(
      -studentTQuantile(0.95, 7),
      12,
    );
  });

  it('inverts studentTCdf to 1e-10 across df', () => {
    for (const df of [1, 3, 10, 74, 300]) {
      for (const p of [0.01, 0.25, 0.6, 0.9, 0.999]) {
        const recovered = studentTCdf(studentTQuantile(p, df), df);
        expect(Math.abs(recovered - p)).toBeLessThanOrEqual(1e-10);
      }
    }
  });
});

describe('binomialLogPmf', () => {
  it('matches a hand-computed pmf and sums to one', () => {
    // C(4, 2) * 0.5^4 = 6/16
    expect(Math.exp(binomialLogPmf(2, 4, 0.5))).toBeCloseTo(0.375, 12);
    let total = 0;
    for (let k = 0; k <= 20; k += 1) {
      total += Math.exp(binomialLogPmf(k, 20, 0.25));
    }
    expect(total).toBeCloseTo(1, 12);
  });

  it('handles the degenerate success probabilities', () => {
    expect(binomialLogPmf(0, 5, 0)).toBe(0);
    expect(binomialLogPmf(1, 5, 0)).toBe(-Infinity);
    expect(binomialLogPmf(5, 5, 1)).toBe(0);
    expect(binomialLogPmf(4, 5, 1)).toBe(-Infinity);
  });

  it('rejects impossible counts', () => {
    expect(() => binomialLogPmf(6, 5, 0.5)).toThrow(AnalysisError);
    expect(() => binomialLogPmf(1.5, 5, 0.5)).toThrow(AnalysisError);
  });
});
