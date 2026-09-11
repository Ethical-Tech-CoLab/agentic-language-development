import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  CAUSAL_PREDICTION_PIPELINE_VERSION,
  NON_LEDGER_COMPARATOR_IDS,
  commitProspectivePredictions,
  multiclassBrierScore,
  scoreCommittedPredictions,
  selectNonLedgerComparator,
  type LabeledPredictionCase,
  type PredictionCase,
  type ProbabilityPrediction,
} from '../src/index.js';

const actionIds = ['candidate-0', 'candidate-1', 'candidate-2', 'candidate-3'];
const digest = (label: string): string => hashCanonical('test-e16-prediction-v1', label);

function labeledCase(prefix: string, index: number): LabeledPredictionCase {
  const targetIndex = index % actionIds.length;
  return {
    caseId: `${prefix}-${String(index).padStart(2, '0')}`,
    actionIds,
    targetActionId: actionIds[targetIndex] as string,
    information: {
      publicTranscriptHistoryHash: digest(`transcript-${index % 2}`),
      publicTaskHistoryHash: digest(`task-${targetIndex}`),
      frozenPolicyHash: digest('policy'),
      permittedObservationHash: digest('observation'),
      deliveredMessageHash: digest('message'),
    },
  };
}

function unlabeled(row: LabeledPredictionCase): PredictionCase {
  return {
    caseId: row.caseId,
    actionIds: row.actionIds,
    information: row.information,
  };
}

function oneHot(row: PredictionCase, targetActionId: string): ProbabilityPrediction {
  return {
    caseId: row.caseId,
    actionIds: row.actionIds,
    probabilities: row.actionIds.map((action) => action === targetActionId ? 1 : 0),
  };
}

const fitCases = Array.from({ length: 40 }, (_, index) => labeledCase('fit', index));
const selectionCases = Array.from({ length: 20 }, (_, index) => labeledCase('select', index));

describe('E16 causal prediction pipeline', () => {
  it('fits every eligible non-ledger comparator and selects only on a disjoint validation fold', () => {
    const selection = selectNonLedgerComparator({ fitCases, selectionCases });

    expect(selection.pipelineVersion).toBe(CAUSAL_PREDICTION_PIPELINE_VERSION);
    expect(selection.candidateModels.map((model) => model.comparatorId)).toEqual(NON_LEDGER_COMPARATOR_IDS);
    expect(selection.validationScores.map((score) => score.comparatorId)).toEqual(NON_LEDGER_COMPARATOR_IDS);
    expect(selection.selectedComparatorId).toBe('task-history');
    expect(selection.lockedModel.comparatorId).toBe('task-history');
    expect(selection.lockedModel.fittedCaseIds).toHaveLength(60);
    expect(new Set(selection.fitCaseIds)).toEqual(new Set(fitCases.map((row) => row.caseId)));
    expect(selection.selectionCaseIds.some((caseId) => selection.fitCaseIds.includes(caseId))).toBe(false);
  });

  it('commits baseline and native predictions before accepting untouched outcomes', () => {
    const selection = selectNonLedgerComparator({ fitCases, selectionCases });
    const labeledTest = Array.from({ length: 12 }, (_, index) => labeledCase('test', index));
    const testCases = labeledTest.map(unlabeled);
    const commitment = commitProspectivePredictions({
      selection,
      testCases,
      nativeLedger: {
        source: 'agent-native-ledger',
        predictionFunctionVersion: 'fixture-native-ledger/v1',
        sourceCommitment: digest('native-ledger-state'),
        predictions: labeledTest.map((row) => oneHot(unlabeled(row), row.targetActionId)),
      },
    });

    expect(commitment.chronology).toBe('predictions-committed-before-test-outcomes');
    expect(commitment).not.toHaveProperty('outcomes');
    expect(commitment).not.toHaveProperty('targetActionId');

    const result = scoreCommittedPredictions({
      commitment,
      outcomes: labeledTest.map((row) => ({ caseId: row.caseId, targetActionId: row.targetActionId })),
    });
    expect(result.meanNativeLedgerBrierScore).toBe(0);
    expect(result.meanBaselineBrierScore).toBeGreaterThan(0);
    expect(result.meanImprovement).toBeGreaterThan(0);
    expect(result.oracleDiagnosticMeanBrierScore).toBe(0);
    expect(result.oracleEligibleForSelection).toBe(false);
  });

  it('computes the multiclass Brier score without reducing it to accuracy', () => {
    expect(multiclassBrierScore({
      caseId: 'brier',
      actionIds: ['a', 'b'],
      probabilities: [0.75, 0.25],
    }, 'a')).toBeCloseTo(0.125);
  });

  it('hashes only each comparator\'s declared training information set', () => {
    const original = selectNonLedgerComparator({ fitCases, selectionCases });
    const changedPolicyOnly = fitCases.map((row, index) => index === 0
      ? {
          ...row,
          information: {
            ...row.information,
            frozenPolicyHash: digest('different-policy'),
          },
        }
      : row);
    const changed = selectNonLedgerComparator({ fitCases: changedPolicyOnly, selectionCases });
    const commitments = (selection: typeof original) => Object.fromEntries(
      selection.candidateModels.map((model) => [model.comparatorId, model.trainingDataCommitment]),
    );

    const before = commitments(original);
    const after = commitments(changed);
    expect(after['uniform']).toBe(before['uniform']);
    expect(after['validation-majority']).toBe(before['validation-majority']);
    expect(after['transcript-only']).toBe(before['transcript-only']);
    expect(after['task-history']).toBe(before['task-history']);
    expect(after['policy-state']).not.toBe(before['policy-state']);
  });

  it('rejects target outcomes and undeclared fields in prospective test inputs', () => {
    const selection = selectNonLedgerComparator({ fitCases, selectionCases });
    const row = labeledCase('test-leak', 0);
    const leakedCase = { ...unlabeled(row), targetActionId: row.targetActionId } as unknown as PredictionCase;
    expect(() => commitProspectivePredictions({
      selection,
      testCases: [leakedCase],
      nativeLedger: {
        source: 'agent-native-ledger',
        predictionFunctionVersion: 'fixture-native-ledger/v1',
        sourceCommitment: digest('native-ledger-state'),
        predictions: [oneHot(unlabeled(row), row.targetActionId)],
      },
    })).toThrow(/keys must be exactly/);

    const forbiddenInformation = {
      ...row.information,
      nativeLedgerHash: digest('forbidden'),
    } as typeof row.information;
    expect(() => selectNonLedgerComparator({
      fitCases: [{ ...fitCases[0] as LabeledPredictionCase, information: forbiddenInformation }],
      selectionCases,
    })).toThrow(/keys must be exactly/);
  });

  it('rejects overlapping folds and post-commit tampering', () => {
    expect(() => selectNonLedgerComparator({
      fitCases,
      selectionCases: [fitCases[0] as LabeledPredictionCase],
    })).toThrow(/duplicate validation caseId/);

    const selection = selectNonLedgerComparator({ fitCases, selectionCases });
    const row = labeledCase('test-tamper', 0);
    const tampered = {
      ...selection,
      selectedComparatorId: 'uniform' as const,
    };
    expect(() => commitProspectivePredictions({
      selection: tampered,
      testCases: [unlabeled(row)],
      nativeLedger: {
        source: 'agent-native-ledger',
        predictionFunctionVersion: 'fixture-native-ledger/v1',
        sourceCommitment: digest('native-ledger-state'),
        predictions: [oneHot(unlabeled(row), row.targetActionId)],
      },
    })).toThrow(/selection commitment does not verify/);

    const commitment = commitProspectivePredictions({
      selection,
      testCases: [unlabeled(row)],
      nativeLedger: {
        source: 'agent-native-ledger',
        predictionFunctionVersion: 'fixture-native-ledger/v1',
        sourceCommitment: digest('native-ledger-state'),
        predictions: [oneHot(unlabeled(row), row.targetActionId)],
      },
    });
    const tamperedPrediction = {
      ...commitment,
      baselinePredictions: [{
        ...commitment.baselinePredictions[0] as ProbabilityPrediction,
        probabilities: [1, 0, 0, 0],
      }],
    };
    expect(() => scoreCommittedPredictions({
      commitment: tamperedPrediction,
      outcomes: [{ caseId: row.caseId, targetActionId: row.targetActionId }],
    })).toThrow(/prediction commitment does not verify/);
  });
});
