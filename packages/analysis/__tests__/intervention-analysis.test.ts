import { describe, expect, it } from 'vitest';

import {
  attributeHammingDistance,
  betaBinomialAgreement,
  checkHeldOutSplitIntegrity,
  evaluateCheckpointDrift,
  evaluateComposition,
  messageEditDistance,
  seedLevelAgreement,
  symbolUsageDivergenceBits,
  type CompositionEpisode,
} from '../src/index.js';

describe('composition and held-out evaluation', () => {
  const episodes: CompositionEpisode[] = [
    {
      split: 'train',
      typeCode: 0,
      attributes: [0, 0],
      message: ['a', 'a'],
      success: true,
      seed: 's1',
    },
    {
      split: 'train',
      typeCode: 1,
      attributes: [0, 1],
      message: ['a', 'b'],
      success: true,
      seed: 's2',
    },
    {
      split: 'held-out',
      typeCode: 2,
      attributes: [1, 0],
      message: ['b', 'a'],
      success: false,
      seed: 's1',
    },
    {
      split: 'held-out',
      typeCode: 3,
      attributes: [1, 1],
      message: ['b', 'b'],
      success: true,
      seed: 's2',
    },
  ];

  it('computes the registered distances and split-integrity result', () => {
    expect(attributeHammingDistance([0, 1, 2], [0, 2, 3])).toBe(2);
    expect(messageEditDistance(['a', 'b'], ['a', 'c', 'b'])).toBe(1);
    expect(
      checkHeldOutSplitIntegrity({ episodes, heldOutTypeCodes: [2, 3] }),
    ).toMatchObject({ intact: true, violations: [] });
  });

  it('reports separate deterministic metrics without a composition verdict', () => {
    const input = {
      episodes,
      heldOutTypeCodes: [2, 3],
      seed: 'composition-test',
      permutations: 50,
      orderProbes: [
        { baselineSuccess: true, reorderedSuccess: false },
        { baselineSuccess: true, reorderedSuccess: true },
      ],
    } as const;
    const result = evaluateComposition(input);

    expect(result.seen.summary.proportion).toBe(1);
    expect(result.heldOut.summary.proportion).toBe(0.5);
    expect(result.splitIntegrity.intact).toBe(true);
    expect(result.topographic.degenerate).toBe(false);
    expect(result.symbolReuse).toMatchObject({
      distinctForms: 2,
      distinctMessages: 4,
      formsSharedAcrossMessages: 2,
    });
    expect(result.orderSensitivity?.difference).toBe(0.5);
    expect(evaluateComposition(input)).toEqual(result);
    expect(result).not.toHaveProperty('isCompositional');
  });
});

describe('checkpoint drift', () => {
  it('uses bounded Jensen-Shannon divergence for identical and disjoint usage', () => {
    expect(symbolUsageDivergenceBits([4, 0], [8, 0])).toBeCloseTo(0);
    expect(symbolUsageDivergenceBits([4, 0], [0, 8])).toBeCloseTo(1);
  });

  it('separates within-regime drift from a declared distribution shift', () => {
    const result = evaluateCheckpointDrift({
      distributionShiftAt: [15],
      checkpoints: [
        {
          checkpointSequence: 0,
          turn: 0,
          success: { successes: 5, n: 10 },
          vocabularySize: 2,
          meaningChanges: 0,
          messageEntropyBits: 1,
          symbolUsage: [10, 0],
        },
        {
          checkpointSequence: 1,
          turn: 10,
          success: { successes: 6, n: 10 },
          vocabularySize: 2,
          meaningChanges: 1,
          messageEntropyBits: 1,
          symbolUsage: [20, 0],
        },
        {
          checkpointSequence: 2,
          turn: 20,
          success: { successes: 4, n: 10 },
          vocabularySize: 3,
          meaningChanges: 4,
          messageEntropyBits: 0.8,
          symbolUsage: [0, 20],
        },
      ],
    });

    expect(result.pairs.map((pair) => pair.driftScoreBits)).toEqual([0, 1]);
    expect(result.pairs.map((pair) => pair.spansDistributionShift)).toEqual([
      false, true,
    ]);
    expect(result.stabilityIntervals.map((interval) => interval.checkpoints)).toEqual([
      2, 1,
    ]);
    expect(result.regimeSeparation).toMatchObject({
      meanDifferenceBits: 1,
      decision: 'separated',
    });
  });
});

describe('seed-clustered intervention inference', () => {
  const seeds = [
    { seed: 's1', agreements: 8, probes: 10 },
    { seed: 's2', agreements: 9, probes: 10 },
    { seed: 's3', agreements: 7, probes: 10 },
    { seed: 's4', agreements: 8, probes: 10 },
    { seed: 's5', agreements: 9, probes: 10 },
  ];

  it('treats seeds, rather than pooled probes, as the inferential units', () => {
    const result = seedLevelAgreement({
      seeds,
      chanceRate: 0.25,
      minimumSeeds: 5,
      bootstrap: { seed: 'seed-level', iterations: 100 },
    });

    expect(result.seedCount).toBe(5);
    expect(result.seedMean).toBeCloseTo(0.82);
    expect(result.meetsSeedMinimum).toBe(true);
    expect(result.decision).toBe('above-chance');
    expect(result.seedMeanBootstrap?.iterations).toBe(100);
  });

  it('fits and bootstraps the hierarchical Bernoulli model deterministically', () => {
    const input = {
      seeds,
      chanceRate: 0.25,
      minimumSeeds: 5,
      bootstrap: { seed: 'beta-binomial', iterations: 25 },
    } as const;
    const result = betaBinomialAgreement(input);

    expect(result.mu).toBeGreaterThan(0.7);
    expect(result.totalProbes).toBe(50);
    expect(result.totalAgreements).toBe(41);
    expect(result.bootstrap?.iterations).toBe(25);
    expect(betaBinomialAgreement(input)).toEqual(result);
  });
});
