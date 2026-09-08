/**
 * ALD-033 — the reference affect behaviours adapters use inside an open
 * window (SPECIFICATION.md §9.3, §6.2; EXPERIMENT-NOTEBOOK.md E20).
 *
 * The Gateway's rules are tested in `@ald/gateway`; here we pin the purity,
 * determinism, and declared domain of the helpers, plus the end-to-end
 * property that matters for `affectMode: "derived"`: a measurement produced by
 * `measurementFromState` maps, under the Gateway's fixed pre-registered
 * `argmax-v1` mapping, to the display the projection table predicts.
 */
import { describe, expect, it } from 'vitest';

import { AFFECT_DISPLAY_IDS, AffectStateMeasurementSchema } from '@ald/types';
import { SeededPrng, canonicalJson } from '@ald/hashing';
import { resolveAffectDerivedMapping } from '@ald/gateway';

import {
  AFFECT_MEASUREMENT_VERSION,
  AFFECT_POLICY_VERSION,
  AFFECT_SCORE_SLOTS,
  AffectPolicyError,
  OUTCOME_LINKED_AFFECT_MAPPING,
  affectDisplayIndex,
  affectProposal,
  measurementFromState,
  noLearningAffect,
  outcomeLinkedAffect,
  type AffectMeasurementState,
} from '../src/affect-policies.js';

function state(
  overrides: Partial<AffectMeasurementState> = {},
): AffectMeasurementState {
  return {
    recentSuccessRate: 0.5,
    recentRejectionRate: 0,
    recentPredictionError: 0.5,
    noveltyRate: 0,
    ...overrides,
  };
}

describe('ALD-033: noLearningAffect', () => {
  it('draws only allowlisted displays and is reproducible from the seed', () => {
    const draws = (seed: string): string[] => {
      const prng = new SeededPrng(seed).derive('affect');
      return Array.from({ length: 60 }, () => noLearningAffect(prng));
    };
    const first = draws('seed-affect-1');
    expect(draws('seed-affect-1')).toEqual(first);
    expect(draws('seed-affect-2')).not.toEqual(first);
    for (const displayId of first) {
      expect(AFFECT_DISPLAY_IDS).toContain(displayId);
    }
  });

  it('covers all six displays over a long seeded stream (chance baseline)', () => {
    const prng = new SeededPrng('seed-affect-coverage').derive('affect');
    const counts = new Map<string, number>();
    for (let index = 0; index < 6000; index += 1) {
      const displayId = noLearningAffect(prng);
      counts.set(displayId, (counts.get(displayId) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...AFFECT_DISPLAY_IDS]);
    // Observed frequencies, reported as software behaviour, not a finding.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

describe('ALD-033: outcomeLinkedAffect', () => {
  it('maps the unit interval onto the six bands of the pre-registered mapping', () => {
    expect(OUTCOME_LINKED_AFFECT_MAPPING).toBe('outcome-linked-bands-v1');
    expect(outcomeLinkedAffect(0)).toBe('A1');
    expect(outcomeLinkedAffect(0.16)).toBe('A1');
    expect(outcomeLinkedAffect(1 / 6)).toBe('A2');
    expect(outcomeLinkedAffect(0.34)).toBe('A3');
    expect(outcomeLinkedAffect(0.5)).toBe('A4');
    expect(outcomeLinkedAffect(0.7)).toBe('A5');
    expect(outcomeLinkedAffect(0.9)).toBe('A6');
    expect(outcomeLinkedAffect(1)).toBe('A6');
  });

  it('is a pure function of the rate, with no state between calls', () => {
    for (const rate of [0, 0.25, 0.5, 0.75, 1]) {
      expect(outcomeLinkedAffect(rate)).toBe(outcomeLinkedAffect(rate));
    }
  });

  it('refuses a rate outside its declared domain rather than clamping', () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => outcomeLinkedAffect(bad)).toThrow(AffectPolicyError);
    }
    try {
      outcomeLinkedAffect(2);
    } catch (error) {
      expect((error as AffectPolicyError).code).toBe('out-of-range');
    }
  });
});

describe('ALD-033: measurementFromState', () => {
  it('produces a schema-valid six-score measurement at the pinned version', () => {
    const value = measurementFromState(state({ recentSuccessRate: 0.75 }));
    expect(AffectStateMeasurementSchema.parse(value)).toEqual(value);
    expect(value.measurementVersion).toBe(AFFECT_MEASUREMENT_VERSION);
    expect(value.scores).toHaveLength(AFFECT_SCORE_SLOTS.length);
    expect(Object.keys(value).sort()).toEqual(['measurementVersion', 'scores']);
  });

  it('follows the pre-registered projection table exactly', () => {
    const value = measurementFromState({
      recentSuccessRate: 0.8,
      recentRejectionRate: 0.1,
      recentPredictionError: 0.3,
      noveltyRate: 0.2,
    });
    expect(value.scores).toEqual([0.8, 0.2, 0.3, 0.7, 0.1, 0.2]);
  });

  it('is deterministic and canonicalizable', () => {
    const a = measurementFromState(state({ recentPredictionError: 1 / 3 }));
    const b = measurementFromState(state({ recentPredictionError: 1 / 3 }));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('refuses every out-of-domain statistic', () => {
    const fields: (keyof AffectMeasurementState)[] = [
      'recentSuccessRate',
      'recentRejectionRate',
      'recentPredictionError',
      'noveltyRate',
    ];
    for (const field of fields) {
      expect(() => measurementFromState(state({ [field]: -1 }))).toThrow(
        AffectPolicyError,
      );
      expect(() => measurementFromState(state({ [field]: 1.5 }))).toThrow(
        AffectPolicyError,
      );
      expect(() =>
        measurementFromState(state({ [field]: Number.NaN })),
      ).toThrow(AffectPolicyError);
    }
  });

  it('feeds the Gateway argmax-v1 mapping to the display the table predicts', () => {
    const mapping = resolveAffectDerivedMapping('argmax-v1');
    const cases: [AffectMeasurementState, string][] = [
      [state({ recentSuccessRate: 1, recentPredictionError: 0 }), 'A1'],
      [state({ recentSuccessRate: 0, recentPredictionError: 0 }), 'A2'],
      [state({ recentSuccessRate: 0.4, recentPredictionError: 1 }), 'A3'],
      [state({ recentSuccessRate: 0.4, recentPredictionError: 0 }), 'A4'],
      [
        state({
          recentSuccessRate: 0.2,
          recentPredictionError: 0.2,
          recentRejectionRate: 1,
        }),
        'A5',
      ],
      [
        state({
          recentSuccessRate: 0.2,
          recentPredictionError: 0.2,
          noveltyRate: 1,
        }),
        'A6',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(mapping.map(measurementFromState(input))).toBe(expected);
    }
  });
});

describe('ALD-033: window proposal helpers', () => {
  it('builds exactly the tool-only submit_affect proposal', () => {
    expect(affectProposal('A3')).toEqual({
      kind: 'submit_affect',
      publicArtifact: { displayId: 'A3' },
    });
    expect(Object.keys(affectProposal('A3')).sort()).toEqual([
      'kind',
      'publicArtifact',
    ]);
  });

  it('reports the allowlist index and refuses anything else', () => {
    AFFECT_DISPLAY_IDS.forEach((displayId, index) => {
      expect(affectDisplayIndex(displayId)).toBe(index);
    });
    expect(() =>
      affectDisplayIndex('A7' as (typeof AFFECT_DISPLAY_IDS)[number]),
    ).toThrow(AffectPolicyError);
  });

  it('pins the module version recorded in exported policies', () => {
    expect(AFFECT_POLICY_VERSION).toBe('affect-policies-v1');
  });
});
