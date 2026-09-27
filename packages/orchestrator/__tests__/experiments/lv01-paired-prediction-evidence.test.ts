/** LV01 paired-case runtime evidence: pre-action vectors committed before the turn record. */
import { afterEach, describe, expect, it } from 'vitest';

import { fixedTokenInventory } from '@ald/types';

import { createLv01PairedCasePlan } from '../../src/experiments/ledger-value.js';
import { createHarness, testConfig, type Harness } from '../helpers.js';

const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: `sha256:${'a'.repeat(64)}`,
  analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
  seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('LV01 paired prediction production evidence', () => {
  it('commits native, ordinary, and replay vectors before the receiver acts', async () => {
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined
          ? undefined
          : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
    });

    const parent = testConfig({
      runId: 'lv01-paired-prediction-parent',
      experimentId: 'LV01',
      randomSeed: 'lv01-paired-prediction-parent-seed',
      babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
      learningSignal: 'extrinsic-task',
      maxTurnsPerRun: 4,
      evaluationTurns: 1,
      ledgerValuePlan: LEDGER_VALUE_PLAN,
    });
    await harness.runtime.createRun(parent);
    await harness.runtime.runToCompletion(parent.runId);
    // Prototype mode skips anchoring, so the sealed terminal state is
    // `aborted-sealed` (same as the E11 scratch-rl precedent).
    expect(harness.runtime.getRun(parent.runId)?.state).toBe('aborted-sealed');
    expect(harness.runtime.turnRecords(parent.runId)).toHaveLength(5);

    const checkpoint = harness.runtime.checkpoints(parent.runId).at(-1);
    expect(checkpoint?.checkpointHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const ledgerSlice = {
      selectedToken: 'S01',
      deliveredToken: 'S01',
      batchCommitment: `sha256:${'e'.repeat(64)}`,
      sourceCaseId: `${parent.runId}:turn:0`,
    };
    const plan = createLv01PairedCasePlan({
      parent,
      parentCheckpointHash: checkpoint?.checkpointHash ?? '',
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: 'lv01-paired-prediction-child',
      ledgerTreatments: {
        'ledger-consistent': { ...ledgerSlice },
        'ledger-shuffled': { ...ledgerSlice },
      },
    });
    const child = plan.branches.find((entry) => entry.branch === 'normal')?.config;
    expect(child).toBeDefined();
    if (child === undefined) {
      throw new Error('normal branch missing from paired-case plan');
    }
    expect(child.experimentId).toBe('LV01');
    expect(child.ledgerValuePlan).toBeDefined();
    expect(child.evaluationOnly).toBe(true);
    expect(child.evaluationTurns).toBe(1);
    expect(child.parentRunId).toBe(parent.runId);

    await harness.runtime.createRun(child);
    const seedToken = fixedTokenInventory(32)[2] as string;
    await harness.runtime.writerFor(child.runId).appendLedgerEvent({
      runId: child.runId,
      babyId: 'B',
      turn: 0,
      draft: {
        eventType: 'hypothesis.created',
        contentSchema: 'agent-native-ledger',
        subjectId: `symbol:${seedToken}`,
        content: {
          hypothesisRef: `hyp:${seedToken}:1`,
          termRef: `symbol:${seedToken}`,
          associationOverTypeCodes: Array.from({ length: 16 }, () => 0),
        },
        blindingNonce: 'test-nonce',
      },
    });
    await harness.runtime.step(child.runId);

    const commitments = harness.runtime
      .auditLog(child.runId)
      .filter(
        (event) =>
          event.eventType === 'prediction-commitment' &&
          event.reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed',
      );
    expect(commitments).toHaveLength(1);
    const details = commitments[0]?.details as Record<string, unknown>;
    const payload = details['predictionPayload'] as {
      native: { distribution: readonly number[] };
      ordinary: { distribution: readonly number[] };
      replay: { distribution: readonly number[] } | null;
    };
    expect(payload.native.distribution).toHaveLength(4);
    expect(payload.ordinary.distribution).toHaveLength(4);
    expect(payload.replay).not.toBeNull();
    expect(payload.replay?.distribution).toHaveLength(4);
    expect(details['predictionCommitmentV2']).toMatch(/^sha256:/u);

    const records = harness.runtime.turnRecords(child.runId);
    expect(records).toHaveLength(1);
    expect(
      (commitments[0]?.recordedAt ?? '') < (records[0]?.recordedAt ?? ''),
    ).toBe(true);
  });
});
