import type { LearnerProvenance, LearnerTrackId, Sha256Hash } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  evaluateSemanticLeakage,
  type SemanticFeatureRow,
} from '../src/index.js';

const HASH = `sha256:${'1'.repeat(64)}` as Sha256Hash;
const PRE_REGISTRATION = {
  seed: 'semantic-leakage-test-v1',
  confidence: 0.95,
  permutations: 20,
  maximumAccuracyAdvantage: 0.1,
  minimumTestRows: 200,
  positiveControlMinimumAdvantage: 0.2,
} as const;

function provenance(
  track: LearnerTrackId,
  options: { tokenizer?: boolean; textAligned?: boolean } = {},
): LearnerProvenance {
  const frozen = track === 'frozen-llm';
  return {
    track,
    modelRef: `reference:${track}`,
    textTokenizerPresent: options.tokenizer ?? frozen,
    textAlignedEncoderPresent: options.textAligned ?? frozen,
    weightUpdatePath:
      track === 'no-learning' || frozen ? 'none' : 'private-buffers-only',
    components: [
      {
        name: frozen ? 'frozen-language-model' : 'sensory-policy',
        kind: frozen ? 'language-model' : 'sensory-encoder',
        provenance: frozen ? 'frozen-open-weight' : 'random-init',
        hash: HASH,
        textAligned: options.textAligned ?? frozen,
      },
    ],
  };
}

function rows(leaked: boolean, count = 800): SemanticFeatureRow[] {
  return Array.from({ length: count }, (_, index) => {
    const label = index % 4;
    return {
      label: `english-class-${String(label)}`,
      features: leaked
        ? Array.from({ length: 4 }, (_, feature) =>
            feature === label ? 1 : 0,
          )
        : [0, 0, 0, 0],
    };
  });
}

describe('semantic-leakage battery (ALD-057)', () => {
  it.each(['scratch-rl', 'self-supervised', 'hybrid'] as const)(
    'runs all strict qualification checks for %s',
    (track) => {
      const result = evaluateSemanticLeakage({
        provenance: provenance(track),
        frozenFeatures: rows(false),
        preRegistration: PRE_REGISTRATION,
      });
      expect(result.tokenizerVocabularyAudit.passed).toBe(true);
      expect(result.linearProbe).toMatchObject({
        observedAccuracy: 0.25,
        shuffledControl: { confidence: 0.95, lower: 0.25, upper: 0.25 },
        withinShuffledInterval: true,
        majorityBaselineAccuracy: 0.25,
        negativeBoundDecision: 'below-bound',
        positiveControl: { observedAccuracy: 1, detected: true },
      });
      expect(result.visionLanguageEncoderAudit.passed).toBe(true);
      expect(result.classification).toBe('strict-ungrounded-eligible');
      expect(result.claimEligible).toBe(true);
    },
  );

  it('blocks an above-control English-label linear probe', () => {
    const result = evaluateSemanticLeakage({
      provenance: provenance('scratch-rl'),
      frozenFeatures: rows(true),
      preRegistration: PRE_REGISTRATION,
    });
    expect(result.linearProbe?.observedAccuracy).toBe(1);
    expect(result.linearProbe?.withinShuffledInterval).toBe(false);
    expect(result.classification).toBe('strict-ungrounded-blocked');
    expect(result.claimEligible).toBe(false);
  });

  it('blocks an underpowered negative bound even when the point estimate is at chance', () => {
    const result = evaluateSemanticLeakage({
      provenance: provenance('scratch-rl'),
      frozenFeatures: rows(false, 64),
      preRegistration: PRE_REGISTRATION,
    });
    expect(result.linearProbe?.withinShuffledInterval).toBe(true);
    expect(result.linearProbe?.negativeBoundDecision).toBe(
      'insufficient-test-rows',
    );
    expect(result.classification).toBe('strict-ungrounded-blocked');
  });

  it('automatically weakens a hybrid with text-aligned frozen features', () => {
    const result = evaluateSemanticLeakage({
      provenance: provenance('hybrid', { textAligned: true }),
      frozenFeatures: rows(false),
      preRegistration: PRE_REGISTRATION,
    });
    expect(result.visionLanguageEncoderAudit.passed).toBe(false);
    expect(result.classification).toBe('weakened-text-aligned-features');
    expect(result.claimEligible).toBe(false);
  });

  it('classifies exempt and control tracks without ungrounded claims', () => {
    const frozen = evaluateSemanticLeakage({
      provenance: provenance('frozen-llm'),
      frozenFeatures: rows(false),
      preRegistration: PRE_REGISTRATION,
    });
    const control = evaluateSemanticLeakage({
      provenance: provenance('no-learning'),
      frozenFeatures: rows(false),
      preRegistration: PRE_REGISTRATION,
    });
    expect(frozen).toMatchObject({
      linearProbe: null,
      classification: 'pretrained-exempt',
      claimEligible: false,
    });
    expect(control).toMatchObject({
      linearProbe: null,
      classification: 'no-learning-control',
      claimEligible: false,
    });
  });

  it('rejects any confidence rule other than the pre-registered 95%', () => {
    expect(() =>
      evaluateSemanticLeakage({
        provenance: provenance('scratch-rl'),
        frozenFeatures: rows(false),
        preRegistration: {
          ...PRE_REGISTRATION,
          confidence: 0.9,
        } as unknown as typeof PRE_REGISTRATION,
      }),
    ).toThrow(/0\.95/u);
  });
});
