import { AnalysisError, assertProbability } from './errors.js';

export const STABLE_CONVENTION_ANALYSIS_VERSION = 'stable-convention/v1';

export interface StableConventionObservation {
  /** Strictly increasing zero-based training turn. */
  readonly turn: number;
  /** Canonical delivered form identity (token sequence or normalized mark hash). */
  readonly formId: string;
  /** Researcher-only meaning identity; never learner input. */
  readonly meaningId: string;
  /** Paired target-action probability with this form minus its registered control. */
  readonly causalListeningDelta: number;
}

export interface StableConventionRule {
  readonly windowSize: number;
  readonly stepSize: number;
  readonly requiredConsecutiveWindows: number;
  readonly minimumFormConsistency: number;
  readonly minimumRepeatedUseShare: number;
  readonly minimumMeanCausalListening: number;
}

export interface StableConventionWindow {
  readonly index: number;
  readonly startTurn: number;
  readonly endTurn: number;
  readonly observations: number;
  /** Weighted form-to-meaning purity: sum_f max_m n(f,m) / N. */
  readonly formConsistency: number;
  /** Share of observations whose form occurs at least twice in this window. */
  readonly repeatedUseShare: number;
  readonly meanCausalListening: number;
  readonly qualifies: boolean;
}

export interface StableConventionResult {
  readonly analysisVersion: string;
  readonly rule: StableConventionRule;
  readonly windows: readonly StableConventionWindow[];
  readonly stable: boolean;
  /** End turn of the first qualifying consecutive-window sequence. */
  readonly firstStableTurn: number | null;
  readonly firstStableWindow: number | null;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new AnalysisError('domain', `${label} must be a positive integer`);
  }
}

function validate(input: readonly StableConventionObservation[], rule: StableConventionRule): void {
  if (input.length === 0) throw new AnalysisError('empty-sample', 'observations must not be empty');
  positiveInteger(rule.windowSize, 'windowSize');
  positiveInteger(rule.stepSize, 'stepSize');
  if (rule.stepSize > rule.windowSize) {
    throw new AnalysisError('domain', 'stepSize must not exceed windowSize');
  }
  positiveInteger(rule.requiredConsecutiveWindows, 'requiredConsecutiveWindows');
  assertProbability(rule.minimumFormConsistency, 'minimumFormConsistency');
  assertProbability(rule.minimumRepeatedUseShare, 'minimumRepeatedUseShare');
  if (!Number.isFinite(rule.minimumMeanCausalListening) ||
      rule.minimumMeanCausalListening < -1 || rule.minimumMeanCausalListening > 1) {
    throw new AnalysisError('domain', 'minimumMeanCausalListening must be within [-1, 1]');
  }
  input.forEach((observation, index) => {
    if (!Number.isInteger(observation.turn) || observation.turn < 0 ||
        (index > 0 && observation.turn <= input[index - 1]!.turn)) {
      throw new AnalysisError('domain', `observations[${index}].turn must be strictly increasing`);
    }
    if (observation.formId.length === 0 || observation.meaningId.length === 0) {
      throw new AnalysisError('domain', `observations[${index}] requires non-empty form and meaning IDs`);
    }
    if (!Number.isFinite(observation.causalListeningDelta) ||
        observation.causalListeningDelta < -1 || observation.causalListeningDelta > 1) {
      throw new AnalysisError('domain', `observations[${index}].causalListeningDelta must be within [-1, 1]`);
    }
  });
}

function summarizeWindow(
  observations: readonly StableConventionObservation[],
  index: number,
  rule: StableConventionRule,
): StableConventionWindow {
  const formCounts = new Map<string, number>();
  const meaningCounts = new Map<string, Map<string, number>>();
  let listening = 0;
  for (const observation of observations) {
    formCounts.set(observation.formId, (formCounts.get(observation.formId) ?? 0) + 1);
    const byMeaning = meaningCounts.get(observation.formId) ?? new Map<string, number>();
    byMeaning.set(observation.meaningId, (byMeaning.get(observation.meaningId) ?? 0) + 1);
    meaningCounts.set(observation.formId, byMeaning);
    listening += observation.causalListeningDelta;
  }
  const consistentUses = [...meaningCounts.values()].reduce((sum, byMeaning) =>
    sum + Math.max(...byMeaning.values()), 0);
  const repeatedUses = [...formCounts.values()].reduce((sum, count) =>
    sum + (count >= 2 ? count : 0), 0);
  const formConsistency = consistentUses / observations.length;
  const repeatedUseShare = repeatedUses / observations.length;
  const meanCausalListening = listening / observations.length;
  return {
    index,
    startTurn: observations[0]!.turn,
    endTurn: observations[observations.length - 1]!.turn,
    observations: observations.length,
    formConsistency,
    repeatedUseShare,
    meanCausalListening,
    qualifies: formConsistency >= rule.minimumFormConsistency &&
      repeatedUseShare >= rule.minimumRepeatedUseShare &&
      meanCausalListening >= rule.minimumMeanCausalListening,
  };
}

/**
 * Locate the first persistent rolling-window convention without using outcomes
 * outside the window. Partial trailing windows are excluded rather than silently
 * treated as comparable to a complete registered window.
 */
export function evaluateStableConvention(
  observations: readonly StableConventionObservation[],
  rule: StableConventionRule,
): StableConventionResult {
  validate(observations, rule);
  const windows: StableConventionWindow[] = [];
  for (let start = 0; start + rule.windowSize <= observations.length; start += rule.stepSize) {
    windows.push(summarizeWindow(
      observations.slice(start, start + rule.windowSize), windows.length, rule));
  }
  let consecutive = 0;
  let firstStableWindow: number | null = null;
  for (const window of windows) {
    consecutive = window.qualifies ? consecutive + 1 : 0;
    if (consecutive === rule.requiredConsecutiveWindows) {
      firstStableWindow = window.index - rule.requiredConsecutiveWindows + 1;
      break;
    }
  }
  const terminalWindow = firstStableWindow === null ? null :
    windows[firstStableWindow + rule.requiredConsecutiveWindows - 1]!;
  return {
    analysisVersion: STABLE_CONVENTION_ANALYSIS_VERSION,
    rule: { ...rule },
    windows,
    stable: terminalWindow !== null,
    firstStableTurn: terminalWindow?.endTurn ?? null,
    firstStableWindow,
  };
}
