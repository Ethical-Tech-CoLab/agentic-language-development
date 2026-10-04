import { describe, expect, it } from 'vitest';
import {
  analyzeLv01DyadVectors,
  analyzeLv01Family,
  LV01_COMPONENT_IDS,
  type Lv01ComponentId,
  type Lv01DyadVector,
} from '../src/index.js';

const componentRecord = (value: number): Record<Lv01ComponentId, number> =>
  Object.fromEntries(LV01_COMPONENT_IDS.map((component) => [component, value])) as Record<
    Lv01ComponentId,
    number
  >;

const dyad = (seedId: string, value: number): Lv01DyadVector => ({
  seedId,
  values: componentRecord(value),
});

describe('LV01 dyad-vector family entry', () => {
  it('reduces each dyad value exactly through both roles', () => {
    const vectors = [dyad('dyad-1', 0.06), dyad('dyad-2', 0.08), dyad('dyad-3', 0.1)];
    const result = analyzeLv01DyadVectors(vectors);
    for (const vector of vectors) {
      for (const component of LV01_COMPONENT_IDS) {
        expect(result.seedStatistics[vector.seedId]![component]).toBe(
          vector.values[component],
        );
      }
    }
  });

  it('matches analyzeLv01Family on independently built role-split rows', () => {
    const vectors = [dyad('seed-a', -0.015), dyad('seed-b', 0.22)];
    const direct = analyzeLv01Family(
      vectors.map((vector) => ({
        seedId: vector.seedId,
        byRole: {
          'baby-a': Object.fromEntries(
            LV01_COMPONENT_IDS.map((component) => [component, [vector.values[component]]]),
          ),
          'baby-b': Object.fromEntries(
            LV01_COMPONENT_IDS.map((component) => [component, [vector.values[component]]]),
          ),
        },
      })),
    );
    expect(analyzeLv01DyadVectors(vectors)).toEqual(direct);
  });

  it('reproduces hand-derived t/Holm/dispositions/intervals (df=2 closed form)', () => {
    // n=3 dyads x [0.06, 0.08, 0.10]: mean 0.08, sd 0.02, se 0.02/sqrt(3).
    // t_2 CDF: F(x) = 1/2 + x / (2 sqrt(x^2 + 2)); one-sided greater p = 1 - F(t).
    // incremental (mu0 0.02): t = 3 sqrt(3), p = 0.01754936.
    // fidelity (mu0 -0.02): t = 5 sqrt(3), p = 0.00653623.
    // controls/intervention (mu0 0.05): t = 1.5 sqrt(3), p = 0.060845.
    // Holm over [LV-U, LV-P, LV-C, LV-L]: adjusted =
    // [0.05264808, 0.02614492, 0.121690, 0.121690]; only LV-P supported.
    // (An earlier draft wrote 0.017544/0.006556/0.052632/0.026225 from
    // faulty long division; corrected per HANDYM once-review + independent
    // recomputation. The implementation was never wrong.)
    // Intervals (t*.975,2 = 4.302653; t*.992857,2 = 8.27669):
    // marginal [0.030317, 0.129683], simultaneous lower -0.015571.
    const result = analyzeLv01DyadVectors([dyad('d1', 0.06), dyad('d2', 0.08), dyad('d3', 0.1)]);
    expect(result.memberPValues['LV-U']).toBeCloseTo(0.017549, 4);
    expect(result.memberPValues['LV-P']).toBeCloseTo(0.006536, 4);
    expect(result.memberPValues['LV-C']).toBeCloseTo(0.060845, 4);
    expect(result.memberPValues['LV-L']).toBeCloseTo(0.060845, 4);
    expect(result.adjustedPValues['LV-U']).toBeCloseTo(0.052648, 4);
    expect(result.adjustedPValues['LV-P']).toBeCloseTo(0.026145, 4);
    expect(result.adjustedPValues['LV-C']).toBeCloseTo(0.12169, 4);
    expect(result.adjustedPValues['LV-L']).toBeCloseTo(0.12169, 4);
    expect(result.dispositions).toEqual({
      'LV-U': 'not-supported',
      'LV-P': 'supported',
      'LV-C': 'not-supported',
      'LV-L': 'not-supported',
    });
    for (const component of LV01_COMPONENT_IDS) {
      expect(result.componentIntervals[component].degenerate).toBe(false);
      expect(result.componentIntervals[component].marginal95.lower).toBeCloseTo(0.030317, 4);
      expect(result.componentIntervals[component].marginal95.upper).toBeCloseTo(0.129683, 4);
      expect(result.componentIntervals[component].simultaneousLowerBound).toBeCloseTo(
        -0.015571,
        4,
      );
    }
  });

  it('takes LV-C from the maximum control p-value', () => {
    // Disabled mean equals its boundary exactly: t = 0, p = 0.5, the maximum
    // (other components keep the [0.06, 0.08, 0.10] spread, p = 0.060845).
    const vectors: Lv01DyadVector[] = [
      { seedId: 'd1', values: { ...componentRecord(0.06), disabled: 0.045 } },
      { seedId: 'd2', values: { ...componentRecord(0.08), disabled: 0.05 } },
      { seedId: 'd3', values: { ...componentRecord(0.1), disabled: 0.055 } },
    ];
    const result = analyzeLv01DyadVectors(vectors);
    expect(result.memberPValues['LV-C']).toBeCloseTo(0.5, 10);
  });

  it('flags zero-variance components p=1 with only the determined member inconclusive', () => {
    const varied = [0.06, 0.08, 0.1].map(
      (value, index): Lv01DyadVector => ({
        seedId: `v${index + 1}`,
        values: { ...componentRecord(value), incremental: 0.05 },
      }),
    );
    const result = analyzeLv01DyadVectors(varied);
    expect(result.memberPValues['LV-U']).toBe(1);
    expect(result.dispositions['LV-U']).toBe('inconclusive');
    expect(result.dispositions['LV-P']).toBe('supported');
    expect(result.dispositions['LV-C']).toBe('not-supported');
    expect(result.dispositions['LV-L']).toBe('not-supported');
    expect(result.componentIntervals.incremental.degenerate).toBe(true);
    expect(result.componentIntervals.incremental.marginal95.lower).toBe(0.05);
    expect(result.componentIntervals.incremental.marginal95.upper).toBe(0.05);
  });

  it('rejects malformed dyad inputs fail-closed', () => {
    expect(() => analyzeLv01DyadVectors([])).toThrow();
    expect(() => analyzeLv01DyadVectors([dyad('only', 0.1)])).toThrow();
    expect(() => analyzeLv01DyadVectors([dyad('dup', 0.1), dyad('dup', 0.2)])).toThrow();
    expect(() => analyzeLv01DyadVectors([dyad('d1', Number.NaN), dyad('d2', 0.1)])).toThrow();
    expect(() =>
      analyzeLv01DyadVectors([
        { seedId: 'd1', values: { ...componentRecord(0.1), incremental: undefined } } as unknown as Lv01DyadVector,
        dyad('d2', 0.1),
      ]),
    ).toThrow();
    expect(() => analyzeLv01DyadVectors([dyad('', 0.1), dyad('d2', 0.1)])).toThrow();
  });
});
