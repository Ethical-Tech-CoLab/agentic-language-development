/**
 * ALD-033 — the discrete estimators E20 registers (SPECIFICATION.md §9.3
 * rule 7, §15.3; EXPERIMENT-NOTEBOOK.md E20).
 *
 * Known-answer vectors first (a uniform distribution's entropy, a perfectly
 * dependent table's mutual information), then the two properties the E20
 * decision rule actually rests on: the within-outcome permutation null is
 * calibrated on independent data, and every number is reproducible from the
 * seed.
 */
import { describe, expect, it } from 'vitest';

import { SeededPrng } from '@ald/hashing';

import { AnalysisError } from '../src/errors.js';
import {
  conditionalMutualInformationBits,
  millerMadowConditionalMutualInformationBits,
  millerMadowEntropyBits,
  millerMadowMutualInformationBits,
  mutualInformationBits,
  observedSupport,
  permutationNullWithinStrata,
  replicateQuantile,
  seedBootstrapUpperBound,
  shannonEntropyBits,
  stratifiedJointCounts,
  type StratifiedObservation,
} from '../src/information.js';

const LEVELS = { xLevels: 6, yLevels: 4, strata: 2 };

describe('ALD-033: shannonEntropyBits known answers', () => {
  it('matches the closed form for uniform and degenerate distributions', () => {
    expect(shannonEntropyBits([1, 1])).toBeCloseTo(1, 12);
    expect(shannonEntropyBits([25, 25, 25, 25])).toBeCloseTo(2, 12);
    expect(shannonEntropyBits([1, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(3, 12);
    expect(shannonEntropyBits([10, 0, 0, 0])).toBeCloseTo(0, 12);
    expect(shannonEntropyBits([0, 0])).toBe(0);
    // H(1/4, 3/4) = 0.8112781244591328 bits.
    expect(shannonEntropyBits([1, 3])).toBeCloseTo(0.8112781244591328, 12);
  });

  it('reports the observed support and rejects malformed counts', () => {
    expect(observedSupport([3, 0, 1, 0])).toBe(2);
    expect(() => shannonEntropyBits([])).toThrow(AnalysisError);
    expect(() => shannonEntropyBits([1, -1])).toThrow(AnalysisError);
    expect(() => shannonEntropyBits([1, 1.5])).toThrow(AnalysisError);
  });
});

describe('ALD-033: Miller-Madow correction', () => {
  it('adds exactly (K - 1) / (2 N ln 2) bits', () => {
    const counts = [10, 20, 30, 0];
    const n = 60;
    const support = 3;
    expect(millerMadowEntropyBits(counts)).toBeCloseTo(
      shannonEntropyBits(counts) + (support - 1) / (2 * n * Math.LN2),
      12,
    );
    expect(millerMadowEntropyBits([5])).toBeCloseTo(0, 12);
    expect(millerMadowEntropyBits([0, 0])).toBe(0);
  });

  it('corrects each of the three entropies of a mutual information separately', () => {
    const joint = [
      [50, 0],
      [0, 50],
    ];
    const expected =
      millerMadowEntropyBits([50, 50]) +
      millerMadowEntropyBits([50, 50]) -
      millerMadowEntropyBits([50, 0, 0, 50]);
    expect(millerMadowMutualInformationBits(joint)).toBeCloseTo(expected, 12);
  });
});

describe('ALD-033: mutual and conditional mutual information known answers', () => {
  it('is zero on an exactly independent table and one bit on a perfectly dependent one', () => {
    expect(
      mutualInformationBits([
        [25, 25],
        [25, 25],
      ]),
    ).toBeCloseTo(0, 12);
    expect(
      mutualInformationBits([
        [50, 0],
        [0, 50],
      ]),
    ).toBeCloseTo(1, 12);
    expect(
      mutualInformationBits([
        [10, 10, 10, 10],
        [10, 10, 10, 10],
      ]),
    ).toBeCloseTo(0, 12);
  });

  it('weights strata by size for the conditional estimate', () => {
    const dependent = [
      [50, 0],
      [0, 50],
    ];
    const independent = [
      [25, 25],
      [25, 25],
    ];
    expect(conditionalMutualInformationBits([dependent, dependent])).toBeCloseTo(
      1,
      12,
    );
    expect(
      conditionalMutualInformationBits([dependent, independent]),
    ).toBeCloseTo(0.5, 12);
    // A stratum with no observations contributes nothing at all.
    expect(
      conditionalMutualInformationBits([
        dependent,
        [
          [0, 0],
          [0, 0],
        ],
      ]),
    ).toBeCloseTo(1, 12);
  });

  it('rejects ragged or empty tables', () => {
    expect(() => mutualInformationBits([])).toThrow(AnalysisError);
    expect(() => mutualInformationBits([[]])).toThrow(AnalysisError);
    expect(() => mutualInformationBits([[1, 2], [3]])).toThrow(AnalysisError);
    expect(() => millerMadowConditionalMutualInformationBits([])).toThrow(
      AnalysisError,
    );
  });
});

describe('ALD-033: stratifiedJointCounts', () => {
  it('tallies observations into one table per stratum', () => {
    const observations: StratifiedObservation[] = [
      { x: 0, y: 0, stratum: 0 },
      { x: 0, y: 0, stratum: 0 },
      { x: 5, y: 3, stratum: 1 },
    ];
    const tables = stratifiedJointCounts(observations, LEVELS);
    expect(tables).toHaveLength(2);
    expect(tables[0]?.[0]?.[0]).toBe(2);
    expect(tables[1]?.[5]?.[3]).toBe(1);
    expect(tables[1]?.[0]?.[0]).toBe(0);
  });

  it('refuses an out-of-range level rather than dropping the observation', () => {
    for (const bad of [
      { x: 6, y: 0, stratum: 0 },
      { x: 0, y: 4, stratum: 0 },
      { x: 0, y: 0, stratum: 2 },
      { x: -1, y: 0, stratum: 0 },
      { x: 0.5, y: 0, stratum: 0 },
    ]) {
      expect(() => stratifiedJointCounts([bad], LEVELS)).toThrow(AnalysisError);
    }
    expect(() =>
      stratifiedJointCounts([], { xLevels: 0, yLevels: 4, strata: 2 }),
    ).toThrow(AnalysisError);
  });
});

// ---------------------------------------------------------------------------
// Permutation null: calibration and reproducibility
// ---------------------------------------------------------------------------

/**
 * Independent affect and referent, but *both* correlated with the outcome —
 * the case §9.3 rule 7 says to control for. A within-outcome permutation null
 * must absorb that shared dependence, leaving an excess near zero.
 */
function outcomeConfoundedSample(
  seed: string,
  count: number,
): StratifiedObservation[] {
  const prng = new SeededPrng(seed);
  const observations: StratifiedObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const stratum = prng.nextInt(2);
    const x = stratum === 1 ? prng.nextInt(3) : 3 + prng.nextInt(3);
    const y = stratum === 1 ? prng.nextInt(2) : 2 + prng.nextInt(2);
    observations.push({ x, y, stratum });
  }
  return observations;
}

describe('ALD-033: within-outcome permutation null', () => {
  it('is calibrated on data where affect and referent are independent given the outcome', () => {
    const observations = outcomeConfoundedSample('null-calibration', 3000);
    const observed = millerMadowConditionalMutualInformationBits(
      stratifiedJointCounts(observations, LEVELS),
    );
    const nullResult = permutationNullWithinStrata(observations, LEVELS, {
      permutations: 200,
      seed: 'null-calibration/permutation',
    });
    // The excess over the null mean is what E20 tests; under independence it
    // sits far below the 0.02-bit bound.
    expect(Math.abs(observed - nullResult.mean)).toBeLessThan(0.01);
    expect(nullResult.replicates).toHaveLength(200);
  });

  it('separates a planted dependence from the null', () => {
    const prng = new SeededPrng('planted');
    const observations: StratifiedObservation[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const stratum = prng.nextInt(2);
      const y = prng.nextInt(4);
      // The display is a deterministic function of the referent: maximal leak.
      observations.push({ x: y, y, stratum });
    }
    const observed = millerMadowConditionalMutualInformationBits(
      stratifiedJointCounts(observations, LEVELS),
    );
    const nullResult = permutationNullWithinStrata(observations, LEVELS, {
      permutations: 100,
      seed: 'planted/permutation',
    });
    expect(observed).toBeGreaterThan(1.9);
    expect(nullResult.mean).toBeLessThan(0.05);
    expect(observed - nullResult.mean).toBeGreaterThan(1.5);
  });

  it('is reproducible from the seed and sensitive to it', () => {
    const observations = outcomeConfoundedSample('repro', 400);
    const options = { permutations: 25, seed: 'stream-a' };
    const first = permutationNullWithinStrata(observations, LEVELS, options);
    const again = permutationNullWithinStrata(observations, LEVELS, options);
    expect(again.replicates).toEqual(first.replicates);
    const other = permutationNullWithinStrata(observations, LEVELS, {
      permutations: 25,
      seed: 'stream-b',
    });
    expect(other.replicates).not.toEqual(first.replicates);
  });

  it('refuses an unseeded or degenerate permutation request', () => {
    const observations = outcomeConfoundedSample('domain', 10);
    expect(() =>
      permutationNullWithinStrata(observations, LEVELS, {
        permutations: 0,
        seed: 'x',
      }),
    ).toThrow(AnalysisError);
    expect(() =>
      permutationNullWithinStrata(observations, LEVELS, {
        permutations: 5,
        seed: '',
      }),
    ).toThrow(AnalysisError);
  });
});

describe('ALD-033: seedBootstrapUpperBound', () => {
  it('returns a one-sided upper bound above the sample mean', () => {
    const values = [0.001, -0.002, 0.004, 0.0, -0.001, 0.002, 0.003, -0.003];
    const bound = seedBootstrapUpperBound(values, {
      seed: 'bootstrap-seed',
      iterations: 2000,
      level: 0.95,
    });
    expect(bound.estimate).toBeCloseTo(
      values.reduce((sum, value) => sum + value, 0) / values.length,
      12,
    );
    expect(bound.upperBound).toBeGreaterThan(bound.estimate);
    expect(bound.n).toBe(values.length);
    expect(bound.level).toBe(0.95);
  });

  it('collapses to the value itself on a constant sample', () => {
    const bound = seedBootstrapUpperBound([0.5, 0.5, 0.5], {
      seed: 'constant',
      iterations: 100,
    });
    expect(bound.estimate).toBeCloseTo(0.5, 12);
    expect(bound.upperBound).toBeCloseTo(0.5, 12);
  });

  it('is reproducible from the seed and rejects bad options', () => {
    const values = [0.1, 0.2, 0.3];
    const options = { seed: 'repro', iterations: 500 };
    expect(seedBootstrapUpperBound(values, options)).toEqual(
      seedBootstrapUpperBound(values, options),
    );
    expect(() => seedBootstrapUpperBound([], options)).toThrow(AnalysisError);
    expect(() =>
      seedBootstrapUpperBound(values, { seed: '', iterations: 10 }),
    ).toThrow(AnalysisError);
    expect(() =>
      seedBootstrapUpperBound(values, { seed: 's', iterations: 0 }),
    ).toThrow(AnalysisError);
    expect(() =>
      seedBootstrapUpperBound(values, { seed: 's', level: 1 }),
    ).toThrow(AnalysisError);
  });

  it('reports replicate quantiles', () => {
    const replicates = [5, 1, 4, 2, 3];
    expect(replicateQuantile(replicates, 0)).toBe(1);
    expect(replicateQuantile(replicates, 1)).toBe(5);
    expect(replicateQuantile(replicates, 0.5)).toBe(3);
    expect(() => replicateQuantile(replicates, 1.5)).toThrow(AnalysisError);
    expect(() => replicateQuantile([], 0.5)).toThrow(AnalysisError);
  });
});
