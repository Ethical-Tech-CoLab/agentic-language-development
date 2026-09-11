import { hashCarrierMark } from '@ald/hashing';
import type { AgentActionProposal, RunConfig, Sha256Hash } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  CARRIER_LEAKAGE_ANALYSIS_VERSION,
  evaluateCarrierLeakage,
  type CarrierLeakageInput,
  type CarrierLeakageObservation,
} from '../src/index.js';

function observation(
  carrier: RunConfig['carrierMode'],
  artifact: AgentActionProposal['publicArtifact'],
  referentTypeCode: number,
): CarrierLeakageObservation {
  return {
    carrier,
    artifact,
    referentTypeCode,
    markHash: hashCarrierMark(carrier, artifact) as Sha256Hash,
  };
}

const glyphA = { glyphs: ['G01'] } as const;
const glyphB = { glyphs: ['G02'] } as const;

function baseInput(
  observations: readonly CarrierLeakageObservation[],
): CarrierLeakageInput {
  return {
    observations,
    probePlan: {
      recognizableGlyph: { enabled: true, maximumRecognizableRate: 0 },
      intendedCarrierFeatureUse: {
        enabled: true,
        minimumObservations: 4,
      },
    },
    recognizableGlyphOutcomes: {
      [hashCarrierMark('fixed-glyph', glyphA)]: 'not-recognizable',
      [hashCarrierMark('fixed-glyph', glyphB)]: 'not-recognizable',
    },
  };
}

describe('alternate-carrier leakage evaluator (ALD-032)', () => {
  it('reports versioned mark metrics and passes both registered probes', () => {
    const observations = [
      observation('fixed-glyph', glyphA, 0),
      observation('fixed-glyph', glyphB, 1),
      observation('fixed-glyph', glyphA, 1),
      observation('fixed-glyph', glyphB, 0),
    ];
    const result = evaluateCarrierLeakage(baseInput(observations));

    expect(result.analysisVersion).toBe(CARRIER_LEAKAGE_ANALYSIS_VERSION);
    expect(result.uniqueMarks).toBe(2);
    expect(result.reuseRate).toBe(0.5);
    expect(result.markMetrics).toHaveLength(2);
    expect(result.recognizableGlyphProbe.decision).toBe('pass');
    expect(result.intendedCarrierFeatureUseDiagnostic).toMatchObject({
      status: 'estimated',
      mutualInformationBits: 0,
    });
    expect(result.claimBoundary.ungroundedLanguageClaim).toBe('eligible');
  });

  it('blocks recognizable prior glyphs while reporting intended carrier feature use without treating it as leakage', () => {
    const narrow = {
      strokes: [{ startX: 0, startY: 0, endX: 15, endY: 0, width: 1 as const }],
    };
    const dense = {
      strokes: [
        { startX: 0, startY: 0, endX: 15, endY: 0, width: 3 as const },
        { startX: 0, startY: 1, endX: 15, endY: 1, width: 3 as const },
      ],
    };
    const observations = [
      observation('fixed-glyph', glyphA, 0),
      observation('fixed-glyph', glyphA, 0),
      observation('generative-canvas', narrow, 0),
      observation('generative-canvas', narrow, 0),
      observation('generative-canvas', dense, 1),
      observation('generative-canvas', dense, 1),
    ];
    const before = JSON.stringify(observations);
    const input = baseInput(observations);
    input.recognizableGlyphOutcomes = {
      [hashCarrierMark('fixed-glyph', glyphA)]: 'recognizable',
    };

    const result = evaluateCarrierLeakage(input);

    expect(JSON.stringify(observations)).toBe(before);
    expect(result.recognizableGlyphProbe.decision).toBe('fail');
    expect(result.intendedCarrierFeatureUseDiagnostic).toMatchObject({
      status: 'estimated',
      mutualInformationBits: 0.918295834054,
    });
    expect(result.decision).toBe('fail');
    expect(result.claimBoundary).toEqual({
      ungroundedLanguageClaim: 'blocked',
      runValidityImpact: 'none',
      evidenceUse: 'valid-negative-or-integrity-evidence',
    });
  });

  it('reports an under-sized form-use diagnostic without converting it into a leakage failure', () => {
    const result = evaluateCarrierLeakage(
      baseInput([observation('fixed-glyph', glyphA, 0)]),
    );

    expect(result.intendedCarrierFeatureUseDiagnostic.status).toBe(
      'insufficient-observations',
    );
    expect(result.decision).toBe('pass');
    expect(result.claimBoundary.ungroundedLanguageClaim).toBe('eligible');
  });

  it('extracts immutable structural features for all five carrier conditions', () => {
    const observations = [
      observation('fixed-token', { symbols: ['S01'] }, 0),
      observation('fixed-glyph', glyphA, 0),
      observation(
        'generative-bitmap',
        { bitmap: { bits: new Array<0 | 1>(256).fill(0) } },
        0,
      ),
      observation(
        'generative-canvas',
        { strokes: [{ startX: 0, startY: 0, endX: 1, endY: 1, width: 1 }] },
        0,
      ),
      observation(
        'generative-tone',
        { tones: { tones: [{ pitchBin: 0, durationBin: 1 }] } },
        0,
      ),
    ];
    const input = baseInput(observations);
    input.probePlan.intendedCarrierFeatureUse.minimumObservations = 5;
    const result = evaluateCarrierLeakage(input);

    expect(result.markMetrics.map((metric) => metric.carrier).sort()).toEqual([
      'fixed-glyph',
      'fixed-token',
      'generative-bitmap',
      'generative-canvas',
      'generative-tone',
    ]);
  });

  it('rejects a mark hash that does not bind the supplied artifact', () => {
    const item = observation('fixed-glyph', glyphA, 0);
    item.markHash = `sha256:${'f'.repeat(64)}`;
    expect(() => evaluateCarrierLeakage(baseInput([item]))).toThrow(
      /markHash does not match/u,
    );
  });
});
