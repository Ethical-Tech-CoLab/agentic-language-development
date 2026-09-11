#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  commitProspectivePredictions,
  multiclassBrierScore,
  scoreCommittedPredictions,
  selectNonLedgerComparator,
  type ComparatorInformation,
  type ComparatorSelection,
  type LabeledPredictionCase,
  type PredictionCase,
  type ProbabilityPrediction,
  type ProspectivePredictionCommitment,
} from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';

const protocolPath = 'protocols/causal-prediction-qualification.v1.json';
const receiptPath = 'reports/research/causal-prediction-qualification-receipt.json';
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface Protocol {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  candidate: { commit: string; version: string };
  sourceHashes: Record<string, string>;
  fixture: {
    actionCount: number;
    validationFitCases: number;
    validationSelectionCases: number;
    untouchedScoringCases: number;
    plantedSelectableSignal: string;
    nativePredictionRole: string;
  };
  expected: {
    comparatorIds: string[];
    selectedComparatorId: string;
    oracleEligibleForSelection: boolean;
    nativePositiveControlBrier: number;
    oracleDiagnosticBrier: number;
  };
  negativeControls: string[];
  exactValidation: Record<string, unknown>;
  rawEvidence: Record<string, unknown>;
  boundary: string;
}

function expectThrow(name: string, action: () => unknown): { id: string; passed: true } {
  try {
    action();
  } catch {
    return { id: name, passed: true };
  }
  throw new Error(`negative control did not fail: ${name}`);
}

const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
  const actual = hash(readFileSync(path));
  if (actual !== expected) throw new Error(`${path} differs from the exact qualified candidate`);
}

const actionIds = Array.from({ length: protocol.fixture.actionCount }, (_, index) => `candidate-${String(index)}`);
const digest = (label: string): string => hashCanonical('qualification-e16-prediction-v1', label);
function labeled(prefix: string, index: number): LabeledPredictionCase {
  const targetIndex = index % actionIds.length;
  return {
    caseId: `${prefix}-${String(index).padStart(2, '0')}`,
    actionIds,
    targetActionId: actionIds[targetIndex] as string,
    information: {
      publicTranscriptHistoryHash: digest(`transcript-${String(index % 2)}`),
      publicTaskHistoryHash: digest(`task-${String(targetIndex)}`),
      frozenPolicyHash: digest('policy'),
      permittedObservationHash: digest('observation'),
      deliveredMessageHash: digest('message'),
    },
  };
}
const unlabeled = (row: LabeledPredictionCase): PredictionCase => ({
  caseId: row.caseId,
  actionIds: row.actionIds,
  information: row.information,
});
const oneHot = (row: LabeledPredictionCase): ProbabilityPrediction => ({
  caseId: row.caseId,
  actionIds: row.actionIds,
  probabilities: row.actionIds.map((action) => action === row.targetActionId ? 1 : 0),
});

const fitCases = Array.from({ length: protocol.fixture.validationFitCases }, (_, index) => labeled('fit', index));
const selectionCases = Array.from({ length: protocol.fixture.validationSelectionCases }, (_, index) => labeled('selection', index));
const labeledTest = Array.from({ length: protocol.fixture.untouchedScoringCases }, (_, index) => labeled('test', index));
const testCases = labeledTest.map(unlabeled);
const selection = selectNonLedgerComparator({ fitCases, selectionCases });
const commitment = commitProspectivePredictions({
  selection,
  testCases,
  nativeLedger: {
    source: 'agent-native-ledger',
    predictionFunctionVersion: 'qualification-positive-control/v1',
    sourceCommitment: digest('synthetic-native-prediction-state'),
    predictions: labeledTest.map(oneHot),
  },
});
const outcomes = labeledTest.map((row) => ({ caseId: row.caseId, targetActionId: row.targetActionId }));
const score = scoreCommittedPredictions({ commitment, outcomes });

const first = fitCases[0] as LabeledPredictionCase;
const negativeControls = [
  expectThrow('validation-fold-overlap', () => selectNonLedgerComparator({ fitCases, selectionCases: [first] })),
  expectThrow('test-outcome-in-prediction-input', () => commitProspectivePredictions({
    selection,
    testCases: [{ ...unlabeled(labeledTest[0] as LabeledPredictionCase), targetActionId: labeledTest[0]?.targetActionId } as unknown as PredictionCase],
    nativeLedger: { ...commitment.nativeLedger, predictions: [commitment.nativeLedger.predictions[0] as ProbabilityPrediction] },
  })),
  expectThrow('undeclared-information-field', () => selectNonLedgerComparator({
    fitCases: [{
      ...first,
      information: { ...first.information, nativeLedgerHash: digest('forbidden') } as ComparatorInformation,
    }],
    selectionCases,
  })),
  expectThrow('native-prediction-extra-field', () => commitProspectivePredictions({
    selection,
    testCases,
    nativeLedger: { ...commitment.nativeLedger, outcome: 'forbidden' } as unknown as typeof commitment.nativeLedger,
  })),
  expectThrow('selection-commitment-tamper', () => commitProspectivePredictions({
    selection: { ...selection, selectedComparatorId: 'uniform' } as ComparatorSelection,
    testCases,
    nativeLedger: commitment.nativeLedger,
  })),
  expectThrow('prediction-commitment-tamper', () => scoreCommittedPredictions({
    commitment: {
      ...commitment,
      baselinePredictions: [{
        ...commitment.baselinePredictions[0] as ProbabilityPrediction,
        probabilities: [1, 0, 0, 0],
      }, ...commitment.baselinePredictions.slice(1)],
    } as ProspectivePredictionCommitment,
    outcomes,
  })),
  expectThrow('invalid-probability-vector', () => multiclassBrierScore({
    caseId: 'invalid',
    actionIds,
    probabilities: [0.5, 0.5, 0.5, -0.5],
  }, actionIds[0] as string)),
];

if (negativeControls.map((entry) => entry.id).join('|') !== protocol.negativeControls.join('|')) throw new Error('negative-control order differs from protocol');
if (selection.candidateModels.map((model) => model.comparatorId).join('|') !== protocol.expected.comparatorIds.join('|')) throw new Error('eligible comparator set differs from protocol');
if (selection.selectedComparatorId !== protocol.expected.selectedComparatorId) throw new Error('planted selectable comparator was not recovered');
if (score.oracleEligibleForSelection !== protocol.expected.oracleEligibleForSelection || score.meanNativeLedgerBrierScore !== protocol.expected.nativePositiveControlBrier || score.oracleDiagnosticMeanBrierScore !== protocol.expected.oracleDiagnosticBrier) throw new Error('positive-control scoring differs from protocol');

const receipt = {
  schemaVersion: 1,
  classification: protocol.classification,
  researchFinding: false,
  capturedAt: '2026-09-11',
  protocolSha256: hash(protocolBytes),
  candidate: protocol.candidate,
  sourceHashes: protocol.sourceHashes,
  exactValidation: {
    ...protocol.exactValidation,
    detachedWorktree: true,
    worktreeCleanAfterValidation: true,
    frozenInstallExitCode: 0,
    focusedExitCode: 0,
    consolidatedExitCode: 0,
  },
  rawEvidence: protocol.rawEvidence,
  fixture: protocol.fixture,
  comparatorValidation: {
    fitCases: fitCases.length,
    selectionCases: selectionCases.length,
    candidateIds: selection.candidateModels.map((model) => model.comparatorId),
    scores: selection.validationScores,
    selectedComparatorId: selection.selectedComparatorId,
    lockedModelHash: selection.lockedModelHash,
    selectionCommitmentHash: selection.selectionCommitmentHash,
  },
  prospectiveScoring: {
    testCases: testCases.length,
    predictionCommitmentHash: commitment.commitmentHash,
    testCaseCommitmentHash: commitment.testCaseCommitment,
    chronology: commitment.chronology,
    selectedBaselineBrier: score.meanBaselineBrierScore,
    injectedNativePositiveControlBrier: score.meanNativeLedgerBrierScore,
    injectedPositiveControlImprovement: score.meanImprovement,
    oracleDiagnosticBrier: score.oracleDiagnosticMeanBrierScore,
    oracleEligibleForSelection: score.oracleEligibleForSelection,
  },
  negativeControls,
  preservedFailure: {
    candidateVersion: '0.1.67',
    focusedTestsPassed: 6,
    consolidatedExitCode: 1,
    cause: 'The consolidated command reached executable TypeScript audits before building workspace outputs in a clean checkout.',
    correction: 'Candidate 0.1.68 moves the existing build gate ahead of executable audits in both local and CI chains.',
  },
  blockerDisposition: {
    blocker: 'B10',
    status: 'open',
    completed: 'all five comparator implementations, disjoint validation selection, information-set enforcement, commitments, scoring, deterministic synthetic controls, exact clean validation',
    remains: 'integration into production intervention-chain evidence and prospectively registered execution on eligible runs',
  },
  boundary: protocol.boundary,
};
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(receiptPath, rendered);
  console.log(`wrote ${receiptPath}`);
} else if (readFileSync(receiptPath, 'utf8') !== rendered) {
  throw new Error('causal-prediction qualification receipt is stale; run pnpm run qualify:causal-prediction');
}
console.log(`causal-prediction qualification valid: ${String(selection.candidateModels.length)} comparators, ${String(negativeControls.length)} negative controls, selected=${selection.selectedComparatorId}`);
