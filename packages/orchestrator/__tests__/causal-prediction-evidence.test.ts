/** Production-runtime chronology and evidence binding for E16 predictions. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  selectNonLedgerComparator,
  type LabeledPredictionCase,
  type PredictionCase,
} from '@ald/analysis';
import { hashCanonical, parseCanonicalJson } from '@ald/hashing';
import { TurnRecordSchema } from '@ald/types';

import type { CausalPredictionProviderInput } from '../src/index.js';
import { createHarness, testConfig, type Harness } from './helpers.js';

const actionIds = ['candidate-0', 'candidate-1', 'candidate-2', 'candidate-3'];
const digest = (label: string): string => hashCanonical('causal-runtime-test-v1', label);
const labeled = (prefix: string, index: number): LabeledPredictionCase => ({
  caseId: `${prefix}-${String(index)}`,
  actionIds,
  targetActionId: actionIds[index % actionIds.length] as string,
  information: {
    publicTranscriptHistoryHash: digest(`transcript-${String(index % 2)}`),
    publicTaskHistoryHash: digest(`task-${String(index % 4)}`),
    frozenPolicyHash: digest('policy'),
    permittedObservationHash: digest('observation'),
    deliveredMessageHash: digest('message'),
  },
});
const selection = selectNonLedgerComparator({
  fitCases: Array.from({ length: 16 }, (_, index) => labeled('fit', index)),
  selectionCases: Array.from({ length: 8 }, (_, index) => labeled('select', index)),
});
const predictionFunctionVersion = 'runtime-qualification-native/v1';
const causalPredictionPlan = {
  version: 1 as const,
  selectionCommitmentHash: selection.selectionCommitmentHash,
  predictionFunctionVersion,
  eligibleTurns: 'accepted-evaluation-deliveries' as const,
};

const provider = () => ({
  selection,
  predictionFunctionVersion,
  predictNative(input: CausalPredictionProviderInput) {
    return {
      source: 'agent-native-ledger' as const,
      predictionFunctionVersion,
      sourceCommitment: hashCanonical(
        'runtime-qualification-ledger-source-v1',
        input.ledgers,
      ),
      predictions: [{
        caseId: input.testCase.caseId,
        actionIds: input.testCase.actionIds,
        probabilities: [0.25, 0.25, 0.25, 0.25],
      }],
    };
  },
});

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('E16 causal prediction production evidence', () => {
  it('commits after delivery and before receiver action, then binds post-outcome scores', async () => {
    const providerInputs: Array<{ turn: number; testCase: PredictionCase }> = [];
    harness = await createHarness({
      causalPredictionFor: (config) => config.experimentId === 'E16'
        ? {
            selection,
            predictionFunctionVersion,
            predictNative(input) {
              providerInputs.push({ turn: input.turn, testCase: input.testCase });
              expect(Object.keys(input).sort()).toEqual([
                'ledgers', 'receiver', 'runId', 'testCase', 'turn',
              ]);
              expect(JSON.stringify(input)).not.toContain('targetActionId');
              return {
                source: 'agent-native-ledger',
                predictionFunctionVersion,
                sourceCommitment: hashCanonical(
                  'runtime-qualification-ledger-source-v1',
                  input.ledgers,
                ),
                predictions: [{
                  caseId: input.testCase.caseId,
                  actionIds: input.testCase.actionIds,
                  probabilities: [0.25, 0.25, 0.25, 0.25],
                }],
              };
            },
          }
        : undefined,
    });
    const config = testConfig({
      runId: 'runtime-causal-prediction-evidence',
      experimentId: 'E16',
      randomSeed: 'runtime-causal-prediction-evidence-seed',
      maxTurnsPerRun: 4,
      evaluationTurns: 3,
      causalPredictionPlan,
    });
    await harness.runtime.createRun(config);
    for (let turn = 0; turn < config.maxTurnsPerRun + (config.evaluationTurns ?? 0); turn += 1) {
      await harness.runtime.step(config.runId);
    }
    expect(harness.runtime.getRun(config.runId)?.state).toBe('sealing');
    expect(providerInputs).toHaveLength(3);
    expect(providerInputs.map((input) => input.testCase.caseId)).toEqual([
      `${config.runId}:turn:4`,
      `${config.runId}:turn:5`,
      `${config.runId}:turn:6`,
    ]);

    const commitments = harness.runtime.auditLog(config.runId)
      .filter((event) => event.eventType === 'prediction-commitment');
    const records = harness.runtime.writerFor(config.runId)
      .readEvents(config.runId, 'turns')
      .map((event) => TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)))
      .filter((record) => record.phase === 'evaluating');
    expect(commitments).toHaveLength(3);
    expect(records).toHaveLength(3);
    commitments.forEach((event, index) => {
      expect(event.reasonCode).toBe('pre-receiver-action-predictions-committed');
      expect(event.recordedAt < (records[index]?.recordedAt ?? '')).toBe(true);
      expect(event.details['commitment']).toMatchObject({
        chronology: 'predictions-committed-before-test-outcomes',
      });
    });

    const attachments = harness.runtime.writerFor(config.runId)
      .readAnalysisAttachments(config.runId);
    expect(attachments).toHaveLength(3);
    attachments.forEach((attachment, index) => {
      expect(attachment.descriptor.path).toBe(
        `analysis/e16-causal-prediction-turn-${String(index + 4).padStart(6, '0')}.json`,
      );
      expect(attachment.descriptor.boundBy?.stream).toBe('intervention');
      expect(attachment.descriptor.kind).toBe('causal-prediction');
      expect(parseCanonicalJson(attachment.canonicalJson)).toMatchObject({
        status: 'scored',
        chronology: 'predictions-committed-before-test-outcomes',
        turnRecordRef: records[index]?.entryHash,
        score: { oracleEligibleForSelection: false },
      });
    });

    await harness.runtime.seal(config.runId);
    const index = JSON.parse(await readFile(
      join(harness.root, 'runs', config.runId, 'analysis', 'index.json'),
      'utf8',
    )) as { attachments: unknown[] };
    expect(index.attachments).toHaveLength(3);
    const experimentRecord = JSON.parse(await readFile(
      join(harness.root, 'runs', config.runId, 'experiment-record.json'),
      'utf8',
    )) as { current: { analysisAttachmentRefs?: string[] } };
    expect(experimentRecord.current.analysisAttachmentRefs).toHaveLength(3);
  });

  it('rejects a prediction provider without a bound plan before creating run state', async () => {
    harness = await createHarness({
      causalPredictionFor: () => ({
        selection,
        predictionFunctionVersion,
        predictNative() {
          throw new Error('must not be invoked');
        },
      }),
    });
    const config = testConfig({
      runId: 'invalid-causal-provider',
      experimentId: 'E16',
      randomSeed: 'invalid-causal-provider-seed',
    });
    await expect(harness.runtime.createRun(config)).rejects.toThrow(/requires a causalPredictionPlan/u);
    expect(harness.runtime.getRun(config.runId)).toBeUndefined();
  });

  it('fails closed when a configured prediction provider is missing at creation or recovery', async () => {
    harness = await createHarness({ causalPredictionFor: () => provider() });
    const config = testConfig({
      runId: 'causal-provider-recovery',
      experimentId: 'E16',
      randomSeed: 'causal-provider-recovery-seed',
      maxTurnsPerRun: 1,
      evaluationTurns: 2,
      causalPredictionPlan,
    });
    await harness.runtime.createRun(config);
    await harness.runtime.step(config.runId);

    const restarted = harness.restart({ causalPredictionFor: undefined });
    harness = restarted;
    await expect(restarted.runtime.recover(config.runId)).rejects.toThrow(
      /requires the bound prediction provider/u,
    );

    const missing = testConfig({
      runId: 'causal-provider-missing-at-create',
      experimentId: 'E16',
      randomSeed: 'causal-provider-missing-at-create-seed',
      causalPredictionPlan,
    });
    await expect(restarted.runtime.createRun(missing)).rejects.toThrow(
      /requires the bound prediction provider/u,
    );
  });

  it('rejects provider identity mismatches and changed native output versions', async () => {
    harness = await createHarness({
      causalPredictionFor: () => ({
        ...provider(),
        predictionFunctionVersion: 'different-native/v1',
      }),
    });
    const config = testConfig({
      runId: 'causal-provider-identity-mismatch',
      experimentId: 'E16',
      randomSeed: 'causal-provider-identity-mismatch-seed',
      causalPredictionPlan,
    });
    await expect(harness.runtime.createRun(config)).rejects.toThrow(
      /does not match the configured function version/u,
    );

    await harness.cleanup();
    harness = await createHarness({
      causalPredictionFor: () => ({
        ...provider(),
        selection: {
          ...selection,
          selectionCommitmentHash: digest('different-selection'),
        },
      }),
    });
    await expect(harness.runtime.createRun(config)).rejects.toThrow(
      /does not match the configured comparator selection/u,
    );

    await harness.cleanup();
    harness = await createHarness({
      causalPredictionFor: () => ({
        ...provider(),
        predictNative(input) {
          return {
            ...provider().predictNative(input),
            predictionFunctionVersion: 'changed-after-run-creation/v1',
          };
        },
      }),
    });
    const outputMismatch = testConfig({
      runId: 'causal-provider-output-mismatch',
      experimentId: 'E16',
      randomSeed: 'causal-provider-output-mismatch-seed',
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
      causalPredictionPlan,
    });
    await harness.runtime.createRun(outputMismatch);
    await harness.runtime.step(outputMismatch.runId);
    await expect(harness.runtime.step(outputMismatch.runId)).rejects.toThrow(
      /output does not match the configured function version/u,
    );
  });

  it('rejects a causal prediction plan outside E16 at schema validation', () => {
    expect(() => testConfig({
      runId: 'causal-plan-wrong-experiment',
      experimentId: 'E15',
      randomSeed: 'causal-plan-wrong-experiment-seed',
      causalPredictionPlan,
    })).toThrow(/restricted to E16/u);
  });
});
