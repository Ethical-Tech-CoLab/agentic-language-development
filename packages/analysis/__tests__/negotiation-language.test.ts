import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  evaluateNegotiationLanguage,
  NEGOTIATION_LANGUAGE_ANALYSIS_VERSION,
  type NegotiationLanguageObservation,
} from '../src/index.js';

const states = ['low', 'high'];
const actions = ['accept', 'reject'];

function row(caseId: string, messageId: string, privateStateId: string,
  intendedActionId: string): NegotiationLanguageObservation {
  return { caseId, messageId, privateStateId, intendedActionId };
}

describe('paired negotiation-language analysis', () => {
  it('separates reduced private-state information from increased action ambiguity', () => {
    const aligned = [
      row('c1', 'low-message', 'low', 'reject'), row('c2', 'high-message', 'high', 'accept'),
      row('c3', 'low-message', 'low', 'reject'), row('c4', 'high-message', 'high', 'accept'),
    ];
    const conflicting = [
      row('c1', 'same-message', 'low', 'reject'), row('c2', 'same-message', 'high', 'accept'),
      row('c3', 'same-message', 'low', 'accept'), row('c4', 'same-message', 'high', 'reject'),
    ];
    const result = evaluateNegotiationLanguage({ aligned, conflicting,
      privateStateIds: states, actionIds: actions });
    expect(result.analysisVersion).toBe(NEGOTIATION_LANGUAGE_ANALYSIS_VERSION);
    expect(result.pairedCases).toBe(4);
    expect(result.informativenessChangeBits).toBeLessThan(0);
    expect(result.strategicAmbiguityChange).toBeGreaterThan(0);
    expect(result.aligned.normalizedStrategicAmbiguity).toBe(0);
    expect(result.conflicting.normalizedStrategicAmbiguity).toBe(1);
  });

  it('does not convert the directional metrics into a hypothesis verdict', () => {
    const observations = [row('c1', 'm', 'low', 'accept'), row('c2', 'm', 'high', 'reject')];
    const result = evaluateNegotiationLanguage({ aligned: observations,
      conflicting: observations, privateStateIds: states, actionIds: actions });
    expect(result.informativenessChangeBits).toBe(0);
    expect(result.strategicAmbiguityChange).toBe(0);
    expect(result).not.toHaveProperty('supported');
  });

  it('requires paired cases, fixed declared spaces, and unique case IDs', () => {
    const base = [row('c1', 'm', 'low', 'accept'), row('c2', 'n', 'high', 'reject')];
    expect(() => evaluateNegotiationLanguage({ aligned: base,
      conflicting: base.slice(0, 1), privateStateIds: states, actionIds: actions }))
      .toThrow(/identical case IDs/u);
    expect(() => evaluateNegotiationLanguage({ aligned: base,
      conflicting: base, privateStateIds: ['low'], actionIds: actions })).toThrow(AnalysisError);
    expect(() => evaluateNegotiationLanguage({ aligned: [...base, base[0]!],
      conflicting: [...base, base[0]!], privateStateIds: states, actionIds: actions }))
      .toThrow(/duplicate case ID/u);
    expect(() => evaluateNegotiationLanguage({ aligned: base,
      conflicting: base, privateStateIds: states, actionIds: ['accept', 'other'] }))
      .toThrow(/undeclared ID/u);
  });
});
