import { AnalysisError } from './errors.js';
import { millerMadowMutualInformationBits, shannonEntropyBits } from './information.js';

export const NEGOTIATION_LANGUAGE_ANALYSIS_VERSION = 'negotiation-language/v1';

export interface NegotiationLanguageObservation {
  readonly caseId: string;
  readonly messageId: string;
  readonly privateStateId: string;
  readonly intendedActionId: string;
}

export interface NegotiationLanguageConditionResult {
  readonly observations: number;
  /** Miller-Madow I(message; registered private state), in bits. */
  readonly informativenessBits: number;
  /** H(intended action | message) divided by log2 of the fixed action-space size. */
  readonly normalizedStrategicAmbiguity: number;
}

export interface NegotiationLanguageResult {
  readonly analysisVersion: string;
  readonly aligned: NegotiationLanguageConditionResult;
  readonly conflicting: NegotiationLanguageConditionResult;
  /** Conflicting minus aligned; H8 predicts a negative value. */
  readonly informativenessChangeBits: number;
  /** Conflicting minus aligned; H8 predicts a positive value. */
  readonly strategicAmbiguityChange: number;
  readonly pairedCases: number;
}

export interface NegotiationLanguageInput {
  readonly aligned: readonly NegotiationLanguageObservation[];
  readonly conflicting: readonly NegotiationLanguageObservation[];
  readonly privateStateIds: readonly string[];
  readonly actionIds: readonly string[];
}

function index(values: readonly string[], label: string): Map<string, number> {
  if (values.length < 2 || new Set(values).size !== values.length ||
      values.some((value) => value.length === 0)) {
    throw new AnalysisError('domain', `${label} must contain at least two unique non-empty IDs`);
  }
  return new Map(values.map((value, position) => [value, position]));
}

function condition(
  observations: readonly NegotiationLanguageObservation[],
  privateStates: Map<string, number>,
  actions: Map<string, number>,
  label: string,
): NegotiationLanguageConditionResult {
  if (observations.length === 0) throw new AnalysisError('empty-sample', `${label} must not be empty`);
  const messages = [...new Set(observations.map((row) => row.messageId))].sort();
  if (messages.some((value) => value.length === 0)) {
    throw new AnalysisError('domain', `${label} contains an empty message ID`);
  }
  const messageIndex = new Map(messages.map((value, position) => [value, position]));
  const stateJoint = Array.from({ length: messages.length }, () =>
    new Array<number>(privateStates.size).fill(0));
  const actionJoint = Array.from({ length: messages.length }, () =>
    new Array<number>(actions.size).fill(0));
  const caseIds = new Set<string>();
  observations.forEach((row, rowIndex) => {
    if (row.caseId.length === 0 || caseIds.has(row.caseId)) {
      throw new AnalysisError('domain', `${label}[${rowIndex}] has an empty or duplicate case ID`);
    }
    caseIds.add(row.caseId);
    const message = messageIndex.get(row.messageId);
    const state = privateStates.get(row.privateStateId);
    const action = actions.get(row.intendedActionId);
    if (message === undefined || state === undefined || action === undefined) {
      throw new AnalysisError('domain', `${label}[${rowIndex}] uses an undeclared ID`);
    }
    stateJoint[message]![state] = stateJoint[message]![state]! + 1;
    actionJoint[message]![action] = actionJoint[message]![action]! + 1;
  });
  const messageCounts = actionJoint.map((row) => row.reduce((sum, value) => sum + value, 0));
  const flatActionCounts = actionJoint.flat();
  const conditionalActionEntropy = shannonEntropyBits(flatActionCounts) -
    shannonEntropyBits(messageCounts);
  return {
    observations: observations.length,
    informativenessBits: millerMadowMutualInformationBits(stateJoint),
    normalizedStrategicAmbiguity: Math.max(0, conditionalActionEntropy) /
      Math.log2(actions.size),
  };
}

/** Per-seed paired H8 readout; inferential aggregation remains a separate registered step. */
export function evaluateNegotiationLanguage(input: NegotiationLanguageInput): NegotiationLanguageResult {
  const privateStates = index(input.privateStateIds, 'privateStateIds');
  const actions = index(input.actionIds, 'actionIds');
  const alignedCases = input.aligned.map((row) => row.caseId).sort();
  const conflictingCases = input.conflicting.map((row) => row.caseId).sort();
  if (alignedCases.length !== conflictingCases.length ||
      alignedCases.some((value, position) => value !== conflictingCases[position])) {
    throw new AnalysisError('length-mismatch', 'aligned and conflicting conditions require identical case IDs');
  }
  const aligned = condition(input.aligned, privateStates, actions, 'aligned');
  const conflicting = condition(input.conflicting, privateStates, actions, 'conflicting');
  return {
    analysisVersion: NEGOTIATION_LANGUAGE_ANALYSIS_VERSION,
    aligned,
    conflicting,
    informativenessChangeBits: conflicting.informativenessBits - aligned.informativenessBits,
    strategicAmbiguityChange: conflicting.normalizedStrategicAmbiguity -
      aligned.normalizedStrategicAmbiguity,
    pairedCases: alignedCases.length,
  };
}
