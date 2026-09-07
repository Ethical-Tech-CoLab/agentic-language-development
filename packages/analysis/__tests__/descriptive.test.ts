import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  mean,
  pooledProportion,
  proportion,
  proportionOfSuccesses,
  quantile,
  quantileSorted,
  summarize,
  wilsonInterval,
} from '../src/index.js';

describe('summarize', () => {
  it('reports n, mean, sample variance, sd, min and max', () => {
    const stats = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.n).toBe(8);
    expect(stats.mean).toBeCloseTo(5, 12);
    // Sample (n - 1) variance of this textbook set is 32/7.
    expect(stats.variance).toBeCloseTo(32 / 7, 12);
    expect(stats.sd).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(9);
  });

  it('leaves variance undefined for a single observation', () => {
    const stats = summarize([0.25]);
    expect(stats.n).toBe(1);
    expect(stats.mean).toBe(0.25);
    expect(stats.variance).toBeNaN();
    expect(stats.sd).toBeNaN();
  });

  it('reports an exact zero variance and mean for a point mass', () => {
    const stats = summarize([0.2, 0.2, 0.2]);
    expect(stats.variance).toBe(0);
    expect(stats.sd).toBe(0);
    expect(stats.mean).toBe(0.2);
  });

  it('rejects an empty or non-finite sample', () => {
    expect(() => summarize([])).toThrow(AnalysisError);
    expect(() => summarize([])).toThrow(/must not be empty/);
    expect(() => summarize([1, NaN])).toThrow(/finite/);
    expect(() => mean([])).toThrow(AnalysisError);
  });
});

describe('quantile', () => {
  it('interpolates like the R type-7 default', () => {
    const values = [1, 2, 3, 4];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(4);
    expect(quantile(values, 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile(values, 0.25)).toBeCloseTo(1.75, 12);
  });

  it('does not mutate the caller array and accepts pre-sorted input', () => {
    const values = [3, 1, 2];
    expect(quantile(values, 0.5)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
    expect(quantileSorted([1, 2, 3], 0.5)).toBe(2);
  });

  it('rejects a probability outside the unit interval', () => {
    expect(() => quantile([1, 2], 1.5)).toThrow(AnalysisError);
  });
});

describe('proportion helpers', () => {
  it('computes and pools observed proportions', () => {
    expect(proportion(8, 10).proportion).toBeCloseTo(0.8, 12);
    const pooled = pooledProportion([proportion(2, 10), proportion(4, 10)]);
    expect(pooled).toEqual({ successes: 6, n: 20, proportion: 0.3 });
    expect(proportionOfSuccesses([1, 0, 1, 0]).proportion).toBe(0.5);
  });

  it('rejects impossible counts and non-binary outcomes', () => {
    expect(() => proportion(11, 10)).toThrow(/must not exceed n/);
    expect(() => proportion(1, 0)).toThrow(AnalysisError);
    expect(() => proportionOfSuccesses([1, 2])).toThrow(/must be 0 or 1/);
  });
});

describe('wilsonInterval', () => {
  it('matches the published 95% interval for 8 of 10', () => {
    // Published interval, rounded to four places, is [0.4902, 0.9433].
    const interval = wilsonInterval(8, 10);
    expect(interval.lower).toBeCloseTo(0.49016, 5);
    expect(interval.upper).toBeCloseTo(0.94332, 5);
    expect(interval.center).toBeCloseTo(0.71674, 5);
    expect(interval.level).toBe(0.95);
    expect(interval.proportion).toBe(0.8);
  });

  it('clamps to [0, 1] at the boundaries and narrows with n', () => {
    const zero = wilsonInterval(0, 10);
    expect(zero.lower).toBeCloseTo(0, 15);
    expect(zero.upper).toBeLessThan(1);
    const all = wilsonInterval(10, 10);
    expect(all.upper).toBe(1);
    expect(all.lower).toBeGreaterThan(0);
    const wide = wilsonInterval(50, 100);
    const narrow = wilsonInterval(5000, 10_000);
    expect(narrow.upper - narrow.lower).toBeLessThan(wide.upper - wide.lower);
  });

  it('widens with the requested confidence and rejects a bad level', () => {
    const ninety = wilsonInterval(8, 10, 0.9);
    const ninetyNine = wilsonInterval(8, 10, 0.99);
    expect(ninetyNine.upper - ninetyNine.lower).toBeGreaterThan(
      ninety.upper - ninety.lower,
    );
    expect(() => wilsonInterval(8, 10, 1)).toThrow(AnalysisError);
  });
});
