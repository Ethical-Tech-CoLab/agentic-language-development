import { describe, expect, it } from 'vitest';

import { AnalysisError, cohensH, rankBiserial } from '../src/index.js';

describe('cohensH', () => {
  it('matches the arcsine formula and is zero for equal proportions', () => {
    expect(cohensH(0.25, 0.25)).toBe(0);
    // 2*asin(sqrt(0.5)) - 2*asin(sqrt(0.25)) = pi/2 - pi/3
    expect(cohensH(0.5, 0.25)).toBeCloseTo(Math.PI / 2 - Math.PI / 3, 12);
    expect(cohensH(1, 0)).toBeCloseTo(Math.PI, 12);
  });

  it('is antisymmetric and rejects non-proportions', () => {
    expect(cohensH(0.8, 0.2)).toBeCloseTo(-cohensH(0.2, 0.8), 12);
    expect(() => cohensH(1.2, 0.2)).toThrow(AnalysisError);
  });
});

describe('rankBiserial', () => {
  it('is +1 when a dominates and -1 when b dominates', () => {
    expect(rankBiserial([4, 5, 6], [1, 2, 3]).r).toBe(1);
    expect(rankBiserial([1, 2, 3], [4, 5, 6]).r).toBe(-1);
  });

  it('is zero for identical samples and counts ties as one half', () => {
    const tied = rankBiserial([1, 2, 3], [1, 2, 3]);
    expect(tied.r).toBe(0);
    expect(tied.u).toBe(4.5);
    expect(tied.nA).toBe(3);
    expect(tied.nB).toBe(3);
  });

  it('matches a hand-counted mixed comparison', () => {
    // a = [1, 3], b = [2, 4]: a > b in 1 of 4 pairs, no ties.
    const result = rankBiserial([1, 3], [2, 4]);
    expect(result.u).toBe(1);
    expect(result.r).toBeCloseTo(2 * (1 / 4) - 1, 12);
  });

  it('rejects an empty sample', () => {
    expect(() => rankBiserial([], [1])).toThrow(AnalysisError);
  });
});
