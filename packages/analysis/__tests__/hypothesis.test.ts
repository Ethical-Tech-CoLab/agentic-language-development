import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  binomialTest,
  evaluateControlEquivalence,
  holmBonferroni,
  MINIMUM_EQUIVALENCE_SEEDS,
  oneSampleTTest,
  tost,
} from '../src/index.js';
import { ratesAround } from './fixtures.js';

/** Hand-computable sample: mean exactly 0.25, sd 0.0158..., so t = 0. */
const CENTRED = [0.24, 0.26, 0.25, 0.23, 0.27];

describe('oneSampleTTest', () => {
  it('matches the hand-computed example centred on mu0', () => {
    const result = oneSampleTTest(CENTRED, 0.25, 'two-sided');
    expect(result.n).toBe(5);
    expect(result.df).toBe(4);
    expect(result.mean).toBeCloseTo(0.25, 12);
    expect(result.se).toBeCloseTo(Math.sqrt(0.00025 / 5), 12);
    expect(result.t).toBeCloseTo(0, 12);
    expect(result.p).toBeCloseTo(1, 12);
    expect(result.degenerate).toBe(false);
  });

  it('matches a hand-computed shifted example in all three alternatives', () => {
    // Same spread, mean 0.35: t = (0.35 - 0.25) / (0.0158114 / sqrt(5)).
    const shifted = CENTRED.map((value) => value + 0.1);
    const se = Math.sqrt(0.00025 / 5);
    const expectedT = 0.1 / se;
    const two = oneSampleTTest(shifted, 0.25, 'two-sided');
    expect(two.t).toBeCloseTo(expectedT, 10);
    const greater = oneSampleTTest(shifted, 0.25, 'greater');
    const less = oneSampleTTest(shifted, 0.25, 'less');
    expect(greater.p).toBeCloseTo(two.p / 2, 12);
    expect(less.p).toBeCloseTo(1 - greater.p, 12);
    expect(greater.p).toBeLessThan(0.05);
  });

  it('reports n < 2 as degenerate with no p value', () => {
    const result = oneSampleTTest([0.25], 0.25);
    expect(result.degenerate).toBe(true);
    expect(result.p).toBeNaN();
    expect(result.t).toBeNaN();
    expect(result.se).toBeNaN();
    expect(result.df).toBe(0);
  });

  it('applies the documented zero-variance rule', () => {
    const equal = oneSampleTTest([0.25, 0.25, 0.25], 0.25, 'two-sided');
    expect(equal.degenerate).toBe(true);
    expect(equal.se).toBe(0);
    expect(equal.t).toBe(0);
    expect(equal.p).toBe(1);

    const above = [0.3, 0.3, 0.3];
    expect(oneSampleTTest(above, 0.25, 'two-sided').t).toBe(Infinity);
    expect(oneSampleTTest(above, 0.25, 'two-sided').p).toBe(0);
    expect(oneSampleTTest(above, 0.25, 'greater').p).toBe(0);
    expect(oneSampleTTest(above, 0.25, 'less').p).toBe(1);

    const below = [0.2, 0.2, 0.2];
    expect(oneSampleTTest(below, 0.25, 'two-sided').t).toBe(-Infinity);
    expect(oneSampleTTest(below, 0.25, 'less').p).toBe(0);
    expect(oneSampleTTest(below, 0.25, 'greater').p).toBe(1);
  });

  it('rejects an empty sample or non-finite mu0', () => {
    expect(() => oneSampleTTest([], 0.25)).toThrow(AnalysisError);
    expect(() => oneSampleTTest(CENTRED, NaN)).toThrow(/finite/);
  });
});

describe('tost', () => {
  it('declares equivalence for 75 seeds around chance', () => {
    const result = tost(ratesAround(0.25, 0.02, 75), 0.2, 0.3, 0.05);
    expect(result.n).toBe(75);
    expect(result.mean).toBeCloseTo(0.25, 10);
    expect(result.pLower).toBeLessThan(0.05);
    expect(result.pUpper).toBeLessThan(0.05);
    expect(result.p).toBe(Math.max(result.pLower, result.pUpper));
    expect(result.equivalent).toBe(true);
    // The TOST interval is the (1 - 2 alpha) interval and sits inside the bounds.
    expect(result.interval.level).toBeCloseTo(0.9, 12);
    expect(result.interval.lower).toBeGreaterThan(0.2);
    expect(result.interval.upper).toBeLessThan(0.3);
  });

  it('refuses equivalence for 75 seeds at 0.35', () => {
    const result = tost(ratesAround(0.35, 0.02, 75), 0.2, 0.3, 0.05);
    expect(result.pLower).toBeLessThan(0.05);
    expect(result.pUpper).toBeGreaterThan(0.05);
    expect(result.equivalent).toBe(false);
    expect(result.interval.lower).toBeGreaterThan(0.3);
  });

  it('refuses equivalence when the sample is too noisy to resolve the bounds', () => {
    const result = tost(ratesAround(0.25, 0.2, 8), 0.2, 0.3, 0.05);
    expect(result.equivalent).toBe(false);
    expect(result.interval.lower).toBeLessThan(0.2);
  });

  it('rejects inverted or non-finite bounds', () => {
    expect(() => tost(CENTRED, 0.3, 0.2, 0.05)).toThrow(/lower bound/);
    expect(() => tost(CENTRED, 0.2, NaN, 0.05)).toThrow(AnalysisError);
    expect(() => tost(CENTRED, 0.2, 0.3, 0)).toThrow(AnalysisError);
  });
});

describe('holmBonferroni', () => {
  it('reproduces the textbook step-down example', () => {
    const result = holmBonferroni([0.01, 0.04, 0.03, 0.005], 0.05);
    expect(result.adjusted[0]).toBeCloseTo(0.03, 12);
    expect(result.adjusted[1]).toBeCloseTo(0.06, 12);
    expect(result.adjusted[2]).toBeCloseTo(0.06, 12);
    expect(result.adjusted[3]).toBeCloseTo(0.02, 12);
    expect(result.rejected).toEqual([true, false, false, true]);
  });

  it('is monotone in the ascending-p order and clamps at 1', () => {
    const result = holmBonferroni([0.2, 0.5, 0.9, 0.95], 0.05);
    const sorted = [...result.adjusted].sort((a, b) => a - b);
    expect(result.adjusted).toEqual(sorted);
    expect(result.adjusted.every((value) => value <= 1)).toBe(true);
    expect(result.rejected).toEqual([false, false, false, false]);
  });

  it('leaves a single p value unchanged', () => {
    expect(holmBonferroni([0.04], 0.05)).toEqual({
      adjusted: [0.04],
      rejected: [true],
      alpha: 0.05,
    });
  });

  it('rejects an empty family or an out-of-range p', () => {
    expect(() => holmBonferroni([], 0.05)).toThrow(AnalysisError);
    expect(() => holmBonferroni([0.5, 1.5], 0.05)).toThrow(/within \[0, 1\]/);
    expect(() => holmBonferroni([0.5, NaN], 0.05)).toThrow(AnalysisError);
  });
});

describe('binomialTest', () => {
  it('agrees with a hand-summed exact tail', () => {
    // P(X >= 4 | n = 5, p = 0.5) = (5 + 1) / 32
    const result = binomialTest(4, 5, 0.5, 'greater');
    expect(result.exactP).toBeCloseTo(6 / 32, 12);
    expect(result.observedRate).toBe(0.8);
    const lower = binomialTest(4, 5, 0.5, 'less');
    // P(X <= 4) = 31/32
    expect(lower.exactP).toBeCloseTo(31 / 32, 12);
    expect(binomialTest(5, 10, 0.5, 'two-sided').exactP).toBeCloseTo(1, 12);
  });

  it('flags a clearly above-chance evaluation and stays calibrated at chance', () => {
    const above = binomialTest(60, 100, 0.25, 'greater');
    expect(above.exactP).toBeLessThan(1e-10);
    expect(above.z).toBeGreaterThan(8);
    expect(above.normalP).toBeLessThan(1e-10);
    const atChance = binomialTest(25, 100, 0.25, 'greater');
    expect(atChance.z).toBeCloseTo(0, 12);
    expect(atChance.normalP).toBeCloseTo(0.5, 12);
    expect(atChance.exactP).toBeGreaterThan(0.5);
  });

  it('rejects impossible inputs', () => {
    expect(() => binomialTest(5, 0, 0.25)).toThrow(AnalysisError);
    expect(() => binomialTest(11, 10, 0.25)).toThrow(AnalysisError);
    expect(() => binomialTest(1, 10, 1.5)).toThrow(AnalysisError);
  });
});

describe('evaluateControlEquivalence', () => {
  it('maps a well-powered control onto the equivalent decision', () => {
    const result = evaluateControlEquivalence({
      seedSuccessRates: ratesAround(0.25, 0.02, 75),
      lower: 0.2,
      upper: 0.3,
      alpha: 0.05,
    });
    expect(result.decision).toBe('equivalent');
    expect(result.tost.equivalent).toBe(true);
    expect(result.minimumSeeds).toBe(MINIMUM_EQUIVALENCE_SEEDS);
  });

  it('maps an above-bound control onto not-equivalent', () => {
    expect(
      evaluateControlEquivalence({
        seedSuccessRates: ratesAround(0.35, 0.02, 75),
        lower: 0.2,
        upper: 0.3,
        alpha: 0.05,
      }).decision,
    ).toBe('not-equivalent');
  });

  it('never calls too few seeds not-equivalent', () => {
    const result = evaluateControlEquivalence({
      seedSuccessRates: [0.25, 0.26],
      lower: 0.2,
      upper: 0.3,
      alpha: 0.05,
    });
    expect(result.decision).toBe('insufficient-seeds');
  });
});
