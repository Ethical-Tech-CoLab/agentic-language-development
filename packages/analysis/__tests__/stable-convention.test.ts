import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  evaluateStableConvention,
  STABLE_CONVENTION_ANALYSIS_VERSION,
  type StableConventionObservation,
} from '../src/index.js';

const rule = {
  windowSize: 4,
  stepSize: 2,
  requiredConsecutiveWindows: 2,
  minimumFormConsistency: 0.75,
  minimumRepeatedUseShare: 0.75,
  minimumMeanCausalListening: 0.1,
};

function observation(turn: number, formId: string, meaningId: string,
  causalListeningDelta = 0.2): StableConventionObservation {
  return { turn, formId, meaningId, causalListeningDelta };
}

describe('stable convention analysis', () => {
  it('finds the first persistent qualifying rolling-window sequence', () => {
    const result = evaluateStableConvention([
      observation(0, 'x', 'a', -0.2), observation(1, 'x', 'b', -0.2),
      observation(2, 'x', 'a'), observation(3, 'x', 'a'),
      observation(4, 'x', 'a'), observation(5, 'x', 'a'),
      observation(6, 'x', 'a'), observation(7, 'x', 'a'),
    ], rule);
    expect(result.analysisVersion).toBe(STABLE_CONVENTION_ANALYSIS_VERSION);
    expect(result.windows).toHaveLength(3);
    expect(result.windows.map((window) => window.qualifies)).toEqual([false, true, true]);
    expect(result.stable).toBe(true);
    expect(result.firstStableWindow).toBe(1);
    expect(result.firstStableTurn).toBe(7);
  });

  it('requires repeated forms and causal listening, not purity alone', () => {
    const unique = [0, 1, 2, 3].map((turn) => observation(turn, `f${turn}`, `m${turn}`, 0.5));
    const noListening = [0, 1, 2, 3].map((turn) => observation(turn, 'x', 'a', 0));
    expect(evaluateStableConvention(unique, { ...rule, requiredConsecutiveWindows: 1 })
      .windows[0]).toMatchObject({ formConsistency: 1, repeatedUseShare: 0, qualifies: false });
    expect(evaluateStableConvention(noListening, { ...rule, requiredConsecutiveWindows: 1 })
      .windows[0]).toMatchObject({ formConsistency: 1, repeatedUseShare: 1, qualifies: false });
  });

  it('reports no stable convention and excludes a trailing partial window', () => {
    const result = evaluateStableConvention([
      observation(0, 'x', 'a', 0), observation(1, 'x', 'b', 0),
      observation(2, 'y', 'a', 0), observation(3, 'y', 'b', 0),
      observation(4, 'z', 'a', 0),
    ], rule);
    expect(result.windows).toHaveLength(1);
    expect(result.stable).toBe(false);
    expect(result.firstStableTurn).toBeNull();
    expect(result.firstStableWindow).toBeNull();
  });

  it('rejects malformed rules, unordered observations, and out-of-range deltas', () => {
    const valid = [observation(0, 'x', 'a'), observation(1, 'x', 'a')];
    expect(() => evaluateStableConvention(valid, { ...rule, windowSize: 0 })).toThrow(AnalysisError);
    expect(() => evaluateStableConvention(
      valid, { ...rule, stepSize: 5 },
    )).toThrow(/must not exceed/u);
    expect(() => evaluateStableConvention([...valid].reverse(), rule)).toThrow(/strictly increasing/u);
    expect(() => evaluateStableConvention([
      observation(0, 'x', 'a', 2),
    ], rule)).toThrow(/within \[-1, 1\]/u);
    expect(() => evaluateStableConvention([], rule)).toThrow(AnalysisError);
  });
});
