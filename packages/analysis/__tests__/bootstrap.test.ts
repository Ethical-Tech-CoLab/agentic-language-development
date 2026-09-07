import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  bootstrapMeanCi,
  bootstrapMeanReplicates,
  bootstrapPairedDifferenceCi,
  bootstrapPairedDifferenceReplicates,
  percentileInterval,
} from '../src/index.js';
import { ratesAround } from './fixtures.js';

const SEEDS = ratesAround(0.25, 0.02, 75);

describe('bootstrapMeanCi', () => {
  it('brackets the sample mean and covers the generating mean', () => {
    const ci = bootstrapMeanCi(SEEDS, { seed: 'e03-slot-1', iterations: 2000 });
    expect(ci.estimate).toBeCloseTo(0.25, 10);
    expect(ci.lower).toBeLessThan(ci.estimate);
    expect(ci.upper).toBeGreaterThan(ci.estimate);
    // The generating mean of the fixture is 0.25.
    expect(ci.lower).toBeLessThan(0.25);
    expect(ci.upper).toBeGreaterThan(0.25);
    expect(ci.level).toBe(0.95);
    expect(ci.n).toBe(75);
    expect(ci.iterations).toBe(2000);
    expect(ci.seed).toBe('e03-slot-1');
  });

  it('is byte-identical across two calls with the same seed', () => {
    const options = { seed: 'ald-e03-v1/oracle', iterations: 500 };
    const first = bootstrapMeanCi(SEEDS, options);
    const second = bootstrapMeanCi(SEEDS, options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(bootstrapMeanReplicates(SEEDS, options)).toEqual(
      bootstrapMeanReplicates(SEEDS, options),
    );
  });

  it('changes with the seed and narrows with the level', () => {
    const a = bootstrapMeanCi(SEEDS, { seed: 'seed-a', iterations: 500 });
    const b = bootstrapMeanCi(SEEDS, { seed: 'seed-b', iterations: 500 });
    expect(a.lower).not.toBe(b.lower);
    const wide = bootstrapMeanCi(SEEDS, {
      seed: 'seed-a',
      iterations: 500,
      confidence: 0.99,
    });
    expect(wide.upper - wide.lower).toBeGreaterThan(a.upper - a.lower);
  });

  it('collapses to the point mass for a constant sample', () => {
    const ci = bootstrapMeanCi([0.4, 0.4, 0.4], {
      seed: 'constant',
      iterations: 100,
    });
    expect(ci.lower).toBeCloseTo(0.4, 12);
    expect(ci.upper).toBeCloseTo(0.4, 12);
  });

  it('rejects a missing seed, bad iteration count, or empty sample', () => {
    expect(() =>
      bootstrapMeanCi(SEEDS, { seed: '', iterations: 10 }),
    ).toThrow(AnalysisError);
    expect(() =>
      bootstrapMeanCi(SEEDS, { seed: 's', iterations: 0 }),
    ).toThrow(/positive integer/);
    expect(() => bootstrapMeanCi([], { seed: 's' })).toThrow(AnalysisError);
  });
});

describe('bootstrapPairedDifferenceCi', () => {
  it('estimates a known paired separation and stays above the E03 bound', () => {
    const oracle = ratesAround(0.97, 0.01, 75);
    const control = ratesAround(0.25, 0.02, 75);
    const ci = bootstrapPairedDifferenceCi(oracle, control, {
      seed: 'ald-e03-v1/separation',
      iterations: 2000,
    });
    expect(ci.estimate).toBeCloseTo(0.72, 6);
    expect(ci.lower).toBeGreaterThan(0.6);
    expect(ci.lower).toBeLessThan(ci.estimate);
    expect(ci.upper).toBeGreaterThan(ci.estimate);
  });

  it('is deterministic for a seed and resamples pairs as units', () => {
    const a = [1, 2, 3, 4];
    const b = [0, 1, 2, 3];
    const options = { seed: 'paired', iterations: 200 };
    const first = bootstrapPairedDifferenceCi(a, b, options);
    const second = bootstrapPairedDifferenceCi(a, b, options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Every pairwise difference is exactly 1, so every replicate must be 1.
    const replicates = bootstrapPairedDifferenceReplicates(a, b, options);
    expect(new Set(replicates)).toEqual(new Set([1]));
  });

  it('rejects mismatched pair lengths', () => {
    expect(() =>
      bootstrapPairedDifferenceCi([1, 2], [1], { seed: 's' }),
    ).toThrow(/equal length/);
  });
});

describe('percentileInterval', () => {
  it('takes the symmetric empirical quantiles of the replicates', () => {
    const replicates = Array.from({ length: 101 }, (_unused, i) => i / 100);
    const interval = percentileInterval(replicates, 0.9);
    expect(interval.lower).toBeCloseTo(0.05, 12);
    expect(interval.upper).toBeCloseTo(0.95, 12);
    expect(interval.level).toBe(0.9);
  });

  it('rejects an empty replicate set or invalid level', () => {
    expect(() => percentileInterval([], 0.95)).toThrow(AnalysisError);
    expect(() => percentileInterval([1, 2], 1)).toThrow(AnalysisError);
  });
});
