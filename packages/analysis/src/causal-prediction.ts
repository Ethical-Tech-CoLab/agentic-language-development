/**
 * E16 validation-only non-ledger comparator selection and prospective scoring.
 *
 * The five eligible comparators consume only the information sets frozen in
 * `protocols/causal-ledger-and-leakage.v1.json`. Model fitting and selection
 * happen on two disjoint validation folds. The selected comparator is then
 * refit on all validation rows, and its test predictions are hash-bound next
 * to agent-native ledger predictions before this module accepts any test
 * outcome. The oracle exists only after outcomes arrive and cannot enter the
 * selectable comparator type.
 */
import { hashCanonical, isSha256Hash } from '@ald/hashing';

import { AnalysisError } from './errors.js';

export const CAUSAL_PREDICTION_PIPELINE_VERSION =
  'e16-causal-prediction-pipeline/v1';

export const NON_LEDGER_COMPARATOR_IDS = [
  'uniform',
  'validation-majority',
  'transcript-only',
  'task-history',
  'policy-state',
] as const;

export type NonLedgerComparatorId =
  (typeof NON_LEDGER_COMPARATOR_IDS)[number];

export interface ComparatorInformation {
  readonly publicTranscriptHistoryHash: string;
  readonly publicTaskHistoryHash: string;
  readonly frozenPolicyHash: string;
  readonly permittedObservationHash: string;
  readonly deliveredMessageHash: string;
}

export interface PredictionCase {
  readonly caseId: string;
  readonly actionIds: readonly string[];
  readonly information: ComparatorInformation;
}

export interface LabeledPredictionCase extends PredictionCase {
  readonly targetActionId: string;
}

export interface ProbabilityPrediction {
  readonly caseId: string;
  readonly actionIds: readonly string[];
  readonly probabilities: readonly number[];
}

interface UniformParameters {
  readonly kind: 'uniform';
}

interface MarginalFrequencyParameters {
  readonly kind: 'marginal-frequency';
  readonly probabilities: readonly number[];
}

interface ConditionalParameters {
  readonly kind: 'conditional-frequency';
  readonly smoothing: 1;
  readonly fallbackProbabilities: readonly number[];
  readonly probabilitiesByFeature: Readonly<Record<string, readonly number[]>>;
}

export interface ComparatorModel {
  readonly pipelineVersion: string;
  readonly comparatorId: NonLedgerComparatorId;
  readonly actionIds: readonly string[];
  readonly fittedCaseIds: readonly string[];
  readonly trainingDataCommitment: string;
  readonly parameters:
    | UniformParameters
    | MarginalFrequencyParameters
    | ConditionalParameters;
}

export interface ComparatorValidationScore {
  readonly comparatorId: NonLedgerComparatorId;
  readonly modelHash: string;
  readonly meanBrierScore: number;
  readonly selectionCases: number;
}

export interface ComparatorSelection {
  readonly pipelineVersion: string;
  readonly selectionRule: 'minimum-validation-brier-then-fixed-order';
  readonly tieBreakOrder: readonly NonLedgerComparatorId[];
  readonly fitCaseIds: readonly string[];
  readonly selectionCaseIds: readonly string[];
  readonly candidateModels: readonly ComparatorModel[];
  readonly validationScores: readonly ComparatorValidationScore[];
  readonly selectedComparatorId: NonLedgerComparatorId;
  readonly lockedModel: ComparatorModel;
  readonly lockedModelHash: string;
  readonly selectionCommitmentHash: string;
}

export interface NativeLedgerPredictionSet {
  readonly source: 'agent-native-ledger';
  readonly predictionFunctionVersion: string;
  readonly sourceCommitment: string;
  readonly predictions: readonly ProbabilityPrediction[];
}

export interface ProspectivePredictionCommitment {
  readonly pipelineVersion: string;
  readonly chronology: 'predictions-committed-before-test-outcomes';
  readonly selectedComparatorId: NonLedgerComparatorId;
  readonly selectionCommitmentHash: string;
  readonly lockedModelHash: string;
  readonly testCaseCommitment: string;
  readonly baselinePredictions: readonly ProbabilityPrediction[];
  readonly nativeLedger: NativeLedgerPredictionSet;
  readonly commitmentHash: string;
}

export interface PredictionOutcome {
  readonly caseId: string;
  readonly targetActionId: string;
}

export interface ScoredPredictionCase {
  readonly caseId: string;
  readonly targetActionId: string;
  readonly baselineBrierScore: number;
  readonly nativeLedgerBrierScore: number;
  readonly improvement: number;
}

export interface CausalPredictionScore {
  readonly pipelineVersion: string;
  readonly selectedComparatorId: NonLedgerComparatorId;
  readonly cases: readonly ScoredPredictionCase[];
  readonly meanBaselineBrierScore: number;
  readonly meanNativeLedgerBrierScore: number;
  /** Positive values favor the native-ledger predictor. */
  readonly meanImprovement: number;
  /** Detector-positive diagnostic, formed only after outcomes are supplied. */
  readonly oracleDiagnosticMeanBrierScore: number;
  readonly oracleEligibleForSelection: false;
  readonly claimBoundary: 'software-qualification-or-registered-analysis-only';
}

const INFORMATION_KEYS = [
  'deliveredMessageHash',
  'frozenPolicyHash',
  'permittedObservationHash',
  'publicTaskHistoryHash',
  'publicTranscriptHistoryHash',
] as const;

function fail(message: string): never {
  throw new AnalysisError('domain', message);
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be non-empty`);
}

function assertInformation(
  information: ComparatorInformation,
  label: string,
): void {
  if (typeof information !== 'object' || information === null) fail(`${label} must be an object`);
  assertExactKeys(information, INFORMATION_KEYS, label);
  for (const key of INFORMATION_KEYS) {
    if (!isSha256Hash(information[key])) fail(`${label}.${key} must be a SHA-256 hash`);
  }
}

function assertPredictionCase(
  row: PredictionCase,
  expectedActionIds?: readonly string[],
): void {
  if (typeof row !== 'object' || row === null) fail('prediction case must be an object');
  assertExactKeys(row, ['actionIds', 'caseId', 'information'], `case ${String(row.caseId)}`);
  assertNonEmpty(row.caseId, 'caseId');
  if (!Array.isArray(row.actionIds) || row.actionIds.length < 2) fail(`${row.caseId}.actionIds must contain at least two actions`);
  const unique = new Set(row.actionIds);
  if (unique.size !== row.actionIds.length) fail(`${row.caseId}.actionIds must be unique`);
  row.actionIds.forEach((action, index) => assertNonEmpty(action, `${row.caseId}.actionIds[${String(index)}]`));
  if (expectedActionIds !== undefined && (row.actionIds.length !== expectedActionIds.length || row.actionIds.some((action, index) => action !== expectedActionIds[index]))) {
    fail(`${row.caseId}.actionIds must match the registered action order`);
  }
  assertInformation(row.information, `${row.caseId}.information`);
}

function assertLabeledCase(
  row: LabeledPredictionCase,
  expectedActionIds?: readonly string[],
): void {
  if (typeof row !== 'object' || row === null) fail('labeled case must be an object');
  assertExactKeys(row, ['actionIds', 'caseId', 'information', 'targetActionId'], `labeled case ${String(row.caseId)}`);
  const unlabeled: PredictionCase = {
    caseId: row.caseId,
    actionIds: row.actionIds,
    information: row.information,
  };
  assertPredictionCase(unlabeled, expectedActionIds);
  if (!row.actionIds.includes(row.targetActionId)) fail(`${row.caseId}.targetActionId is outside actionIds`);
}

function assertDisjointUnique(
  fit: readonly LabeledPredictionCase[],
  selection: readonly LabeledPredictionCase[],
): void {
  if (fit.length === 0 || selection.length === 0) fail('both validation folds must be non-empty');
  const seen = new Set<string>();
  for (const row of [...fit, ...selection]) {
    if (seen.has(row.caseId)) fail(`duplicate validation caseId ${row.caseId}`);
    seen.add(row.caseId);
  }
}

function featureKey(
  comparatorId: Exclude<NonLedgerComparatorId, 'uniform' | 'validation-majority'>,
  row: PredictionCase,
): string {
  switch (comparatorId) {
    case 'transcript-only':
      return row.information.publicTranscriptHistoryHash;
    case 'task-history':
      return row.information.publicTaskHistoryHash;
    case 'policy-state':
      return [
        row.information.frozenPolicyHash,
        row.information.permittedObservationHash,
        row.information.deliveredMessageHash,
      ].join('|');
  }
}

function normalizeCounts(counts: readonly number[]): number[] {
  const denominator = counts.reduce((sum, value) => sum + value, 0);
  return counts.map((value) => value / denominator);
}

function comparatorTrainingView(
  comparatorId: NonLedgerComparatorId,
  rows: readonly LabeledPredictionCase[],
  actionIds: readonly string[],
): object {
  const common = (row: LabeledPredictionCase) => ({
    caseId: row.caseId,
    actionIds: row.actionIds,
    targetActionId: row.targetActionId,
  });
  switch (comparatorId) {
    case 'uniform':
      return { actionIds };
    case 'validation-majority':
      return rows.map(common);
    case 'transcript-only':
      return rows.map((row) => ({
        ...common(row),
        publicTranscriptHistoryHash: row.information.publicTranscriptHistoryHash,
      }));
    case 'task-history':
      return rows.map((row) => ({
        ...common(row),
        publicTaskHistoryHash: row.information.publicTaskHistoryHash,
      }));
    case 'policy-state':
      return rows.map((row) => ({
        ...common(row),
        frozenPolicyHash: row.information.frozenPolicyHash,
        permittedObservationHash: row.information.permittedObservationHash,
        deliveredMessageHash: row.information.deliveredMessageHash,
      }));
  }
}

function fitComparator(
  comparatorId: NonLedgerComparatorId,
  rows: readonly LabeledPredictionCase[],
  actionIds: readonly string[],
): ComparatorModel {
  const base = {
    pipelineVersion: CAUSAL_PREDICTION_PIPELINE_VERSION,
    comparatorId,
    actionIds: [...actionIds],
    fittedCaseIds: comparatorId === 'uniform' ? [] : rows.map((row) => row.caseId).sort(),
    trainingDataCommitment: hashCanonical(
      'dtsf-e16-validation-data-v1',
      comparatorTrainingView(comparatorId, rows, actionIds),
    ),
  };
  if (comparatorId === 'uniform') return { ...base, parameters: { kind: 'uniform' } };

  const marginal = actionIds.map((action) => rows.filter((row) => row.targetActionId === action).length);
  if (comparatorId === 'validation-majority') {
    return {
      ...base,
      parameters: {
        kind: 'marginal-frequency',
        probabilities: normalizeCounts(marginal.map((count) => count + 1)),
      },
    };
  }

  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = featureKey(comparatorId, row);
    const counts = grouped.get(key) ?? actionIds.map(() => 1);
    const targetIndex = actionIds.indexOf(row.targetActionId);
    counts[targetIndex] = (counts[targetIndex] ?? 0) + 1;
    grouped.set(key, counts);
  }
  const probabilitiesByFeature = Object.fromEntries(
    [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, counts]) => [key, normalizeCounts(counts)]),
  );
  return {
    ...base,
    parameters: {
      kind: 'conditional-frequency',
      smoothing: 1,
      fallbackProbabilities: normalizeCounts(marginal.map((count) => count + 1)),
      probabilitiesByFeature,
    },
  };
}

function modelHash(model: ComparatorModel): string {
  return hashCanonical('dtsf-e16-comparator-model-v1', model);
}

function predict(model: ComparatorModel, row: PredictionCase): ProbabilityPrediction {
  assertPredictionCase(row, model.actionIds);
  const parameters = model.parameters;
  let probabilities: readonly number[];
  switch (parameters.kind) {
    case 'uniform':
      probabilities = model.actionIds.map(() => 1 / model.actionIds.length);
      break;
    case 'marginal-frequency':
      probabilities = parameters.probabilities;
      break;
    case 'conditional-frequency': {
      const comparatorId = model.comparatorId;
      if (comparatorId === 'uniform' || comparatorId === 'validation-majority') fail('conditional model has an incompatible comparator ID');
      probabilities = parameters.probabilitiesByFeature[featureKey(comparatorId, row)] ?? parameters.fallbackProbabilities;
      break;
    }
  }
  return { caseId: row.caseId, actionIds: [...row.actionIds], probabilities: [...probabilities] };
}

export function multiclassBrierScore(
  prediction: ProbabilityPrediction,
  targetActionId: string,
): number {
  if (prediction.actionIds.length !== prediction.probabilities.length || prediction.actionIds.length < 2) fail('prediction action/probability lengths must match');
  const targetIndex = prediction.actionIds.indexOf(targetActionId);
  if (targetIndex < 0) fail(`target ${targetActionId} is outside prediction actionIds`);
  let sum = 0;
  let probabilitySum = 0;
  prediction.probabilities.forEach((probability, index) => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) fail('prediction probabilities must be finite and within [0, 1]');
    probabilitySum += probability;
    const observed = index === targetIndex ? 1 : 0;
    sum += (probability - observed) ** 2;
  });
  if (Math.abs(probabilitySum - 1) > 1e-10) fail('prediction probabilities must sum to one');
  return sum;
}

function meanBrier(
  model: ComparatorModel,
  rows: readonly LabeledPredictionCase[],
): number {
  return rows.reduce((sum, row) => sum + multiclassBrierScore(predict(model, {
    caseId: row.caseId,
    actionIds: row.actionIds,
    information: row.information,
  }), row.targetActionId), 0) / rows.length;
}

function selectionPayload(selection: Omit<ComparatorSelection, 'selectionCommitmentHash'>): object {
  return selection;
}

export function selectNonLedgerComparator(input: {
  readonly fitCases: readonly LabeledPredictionCase[];
  readonly selectionCases: readonly LabeledPredictionCase[];
}): ComparatorSelection {
  assertDisjointUnique(input.fitCases, input.selectionCases);
  const actionIds = input.fitCases[0]?.actionIds;
  if (actionIds === undefined) fail('fitCases must be non-empty');
  input.fitCases.forEach((row) => assertLabeledCase(row, actionIds));
  input.selectionCases.forEach((row) => assertLabeledCase(row, actionIds));

  const candidateModels = NON_LEDGER_COMPARATOR_IDS.map((id) => fitComparator(id, input.fitCases, actionIds));
  const validationScores = candidateModels.map((model) => ({
    comparatorId: model.comparatorId,
    modelHash: modelHash(model),
    meanBrierScore: meanBrier(model, input.selectionCases),
    selectionCases: input.selectionCases.length,
  }));
  const selectedComparatorId = [...validationScores].sort((left, right) => {
    const difference = left.meanBrierScore - right.meanBrierScore;
    return difference === 0
      ? NON_LEDGER_COMPARATOR_IDS.indexOf(left.comparatorId) - NON_LEDGER_COMPARATOR_IDS.indexOf(right.comparatorId)
      : difference;
  })[0]?.comparatorId;
  if (selectedComparatorId === undefined) fail('no comparator was selected');
  const lockedModel = fitComparator(selectedComparatorId, [...input.fitCases, ...input.selectionCases], actionIds);
  const withoutHash = {
    pipelineVersion: CAUSAL_PREDICTION_PIPELINE_VERSION,
    selectionRule: 'minimum-validation-brier-then-fixed-order' as const,
    tieBreakOrder: NON_LEDGER_COMPARATOR_IDS,
    fitCaseIds: input.fitCases.map((row) => row.caseId).sort(),
    selectionCaseIds: input.selectionCases.map((row) => row.caseId).sort(),
    candidateModels,
    validationScores,
    selectedComparatorId,
    lockedModel,
    lockedModelHash: modelHash(lockedModel),
  };
  return {
    ...withoutHash,
    selectionCommitmentHash: hashCanonical('dtsf-e16-comparator-selection-v1', selectionPayload(withoutHash)),
  };
}

function assertPrediction(
  prediction: ProbabilityPrediction,
  expectedCase: PredictionCase,
): void {
  assertExactKeys(prediction, ['actionIds', 'caseId', 'probabilities'], `prediction ${String(prediction.caseId)}`);
  if (prediction.caseId !== expectedCase.caseId) fail(`prediction case mismatch for ${expectedCase.caseId}`);
  multiclassBrierScore(prediction, expectedCase.actionIds[0] as string);
  if (prediction.actionIds.some((action, index) => action !== expectedCase.actionIds[index])) fail(`prediction action order mismatch for ${expectedCase.caseId}`);
}

export function commitProspectivePredictions(input: {
  readonly selection: ComparatorSelection;
  readonly testCases: readonly PredictionCase[];
  readonly nativeLedger: NativeLedgerPredictionSet;
}): ProspectivePredictionCommitment {
  if (input.testCases.length === 0) fail('testCases must be non-empty');
  const expectedSelectionHash = hashCanonical('dtsf-e16-comparator-selection-v1', selectionPayload({
    pipelineVersion: input.selection.pipelineVersion,
    selectionRule: input.selection.selectionRule,
    tieBreakOrder: input.selection.tieBreakOrder,
    fitCaseIds: input.selection.fitCaseIds,
    selectionCaseIds: input.selection.selectionCaseIds,
    candidateModels: input.selection.candidateModels,
    validationScores: input.selection.validationScores,
    selectedComparatorId: input.selection.selectedComparatorId,
    lockedModel: input.selection.lockedModel,
    lockedModelHash: input.selection.lockedModelHash,
  }));
  if (expectedSelectionHash !== input.selection.selectionCommitmentHash) fail('comparator selection commitment does not verify');
  if (modelHash(input.selection.lockedModel) !== input.selection.lockedModelHash) fail('locked comparator model hash does not verify');
  assertExactKeys(
    input.nativeLedger,
    ['predictionFunctionVersion', 'predictions', 'source', 'sourceCommitment'],
    'nativeLedger',
  );
  if (input.nativeLedger.source !== 'agent-native-ledger') fail('native ledger source must be agent-native-ledger');
  assertNonEmpty(input.nativeLedger.predictionFunctionVersion, 'predictionFunctionVersion');
  if (!isSha256Hash(input.nativeLedger.sourceCommitment)) fail('native ledger sourceCommitment must be a SHA-256 hash');

  const actionIds = input.selection.lockedModel.actionIds;
  const seen = new Set<string>();
  input.testCases.forEach((row) => {
    assertPredictionCase(row, actionIds);
    if (seen.has(row.caseId)) fail(`duplicate test caseId ${row.caseId}`);
    seen.add(row.caseId);
  });
  if (input.nativeLedger.predictions.length !== input.testCases.length) fail('native-ledger prediction count must match test cases');
  input.nativeLedger.predictions.forEach((prediction, index) => assertPrediction(prediction, input.testCases[index] as PredictionCase));
  const baselinePredictions = input.testCases.map((row) => predict(input.selection.lockedModel, row));
  const withoutHash = {
    pipelineVersion: CAUSAL_PREDICTION_PIPELINE_VERSION,
    chronology: 'predictions-committed-before-test-outcomes' as const,
    selectedComparatorId: input.selection.selectedComparatorId,
    selectionCommitmentHash: input.selection.selectionCommitmentHash,
    lockedModelHash: input.selection.lockedModelHash,
    testCaseCommitment: hashCanonical('dtsf-e16-test-cases-v1', input.testCases),
    baselinePredictions,
    nativeLedger: input.nativeLedger,
  };
  return {
    ...withoutHash,
    commitmentHash: hashCanonical('dtsf-e16-prediction-commitment-v1', withoutHash),
  };
}

export function scoreCommittedPredictions(input: {
  readonly commitment: ProspectivePredictionCommitment;
  readonly outcomes: readonly PredictionOutcome[];
}): CausalPredictionScore {
  const { commitmentHash, ...withoutHash } = input.commitment;
  if (hashCanonical('dtsf-e16-prediction-commitment-v1', withoutHash) !== commitmentHash) fail('prediction commitment does not verify');
  if (input.outcomes.length !== input.commitment.baselinePredictions.length || input.outcomes.length !== input.commitment.nativeLedger.predictions.length) fail('outcome count must match committed predictions');
  const cases = input.outcomes.map((outcome, index) => {
    assertExactKeys(outcome, ['caseId', 'targetActionId'], `outcome ${String(outcome.caseId)}`);
    const baseline = input.commitment.baselinePredictions[index] as ProbabilityPrediction;
    const native = input.commitment.nativeLedger.predictions[index] as ProbabilityPrediction;
    if (outcome.caseId !== baseline.caseId || outcome.caseId !== native.caseId) fail(`outcome order does not match commitment at ${outcome.caseId}`);
    const baselineBrierScore = multiclassBrierScore(baseline, outcome.targetActionId);
    const nativeLedgerBrierScore = multiclassBrierScore(native, outcome.targetActionId);
    return {
      caseId: outcome.caseId,
      targetActionId: outcome.targetActionId,
      baselineBrierScore,
      nativeLedgerBrierScore,
      improvement: baselineBrierScore - nativeLedgerBrierScore,
    };
  });
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    pipelineVersion: CAUSAL_PREDICTION_PIPELINE_VERSION,
    selectedComparatorId: input.commitment.selectedComparatorId,
    cases,
    meanBaselineBrierScore: mean(cases.map((row) => row.baselineBrierScore)),
    meanNativeLedgerBrierScore: mean(cases.map((row) => row.nativeLedgerBrierScore)),
    meanImprovement: mean(cases.map((row) => row.improvement)),
    oracleDiagnosticMeanBrierScore: 0,
    oracleEligibleForSelection: false,
    claimBoundary: 'software-qualification-or-registered-analysis-only',
  };
}
