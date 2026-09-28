/**
 * LV01 audit loader: bundle documents onto auditor inputs.
 *
 * Fixtures are captured from a live parent plus one branch run, so every
 * parsed record is runtime-shaped; negatives mutate the captured docs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHarness, testConfig } from '../helpers.js';
import type { NurseryRuntimeImpl } from '../../src/nursery-runtime.js';
import {
  loadLv01AuditShared,
  loadLv01AuditedBranch,
  parseBundleFiles,
  resolveLv01FrozenModel,
  type Lv01BundleDocs,
} from '../../src/experiments/lv01-audit-loader.js';
import { createLv01PairedCasePlan } from '../../src/experiments/ledger-value.js';
import {
  buildLedgerTreatmentBatch,
  type Lv01LedgerTreatmentBatch,
} from '../../src/experiments/lv01-ledger-treatments.js';
import { indexLv01TrainingLedger } from '@ald/learners';
import {
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
} from '../../src/experiments/lv01-paired-predictions.js';

const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: `sha256:${'a'.repeat(64)}`,
  analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
  seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

interface Captured {
  branchDocs: Lv01BundleDocs;
  parentDocs: Lv01BundleDocs;
  batch: Lv01LedgerTreatmentBatch;
  receiverPolicyHash: string;
}

async function capture(
  runtime: NurseryRuntimeImpl,
  root: string,
  signersFor: (runId: string) => { publicKeys: () => readonly unknown[] },
): Promise<Captured> {
  const rootSeed = `sha256:${'7'.repeat(64)}`;
  const parent = testConfig({
    runId: 'lv01-loader-parent',
    experimentId: 'LV01',
    randomSeed: rootSeed,
    seedBindings: {
      version: 1,
      scenario: rootSeed,
      babyA: `sha256:${'1'.repeat(64)}`,
      babyB: `sha256:${'2'.repeat(64)}`,
      gateway: `sha256:${'3'.repeat(64)}`,
      analysis: `sha256:${'4'.repeat(64)}`,
    },
    babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 3,
    evaluationTurns: 1,
    ledgerValuePlan: LEDGER_VALUE_PLAN,
  });
  await runtime.createRun(parent);
  await runtime.runToCompletion(parent.runId);
  const checkpoint = runtime.checkpoints(parent.runId).at(-1)?.checkpointHash as string;
  const ledgerEvents = runtime.ledgers(parent.runId);
  const records = mapLv01LedgerAssociations(ledgerEvents.babyB, 'baby-b', () => true);
  const cutoff = deriveLv01LedgerCutoff(records);
  const recordsA = mapLv01LedgerAssociations(ledgerEvents.babyA, 'baby-a', () => true);
  const cutoffA = deriveLv01LedgerCutoff(recordsA);
  const batch = buildLedgerTreatmentBatch({
    cases: [
      { caseId: 'lv01-loader-child-normal:turn:0', receiverRole: 'baby-b', targetTypeCode: 1, candidateTypeCodes: [1, 4, 9, 14] },
      { caseId: 'lv01-loader-child-ledger-consistent:turn:0', receiverRole: 'baby-b', targetTypeCode: 4, candidateTypeCodes: [1, 4, 9, 14] },
    ],
    nativeIndexes: {
      babyA: indexLv01TrainingLedger(recordsA, 'baby-a', cutoffA),
      babyB: indexLv01TrainingLedger(records, 'baby-b', cutoff),
    },
    symbolInventory: Array.from({ length: 32 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`),
    derangementSeed: 'loader-fixture',
  });
  const plan = createLv01PairedCasePlan({
    parent,
    parentCheckpointHash: checkpoint,
    babyAInitialPolicyRef: 'policies/baby-a-latest.json',
    babyBInitialPolicyRef: 'policies/baby-b-latest.json',
    childRunIdPrefix: 'lv01-loader-child',
    actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
    slotSeeds: {
      scenario: `sha256:${'6'.repeat(64)}`,
      babyA: `sha256:${'1'.repeat(64)}`,
      babyB: `sha256:${'2'.repeat(64)}`,
      gateway: `sha256:${'3'.repeat(64)}`,
      analysis: `sha256:${'4'.repeat(64)}`,
    },
    scheduledCase: { partition: 'within-support-test', caseIndex: 0, receiverRole: 'baby-b' },
    ledgerTreatments: {
      'ledger-consistent': { selectedToken: 'S01', deliveredToken: 'S01', batchCommitment: batch.batchCommitment, sourceCaseId: 'loader' },
      'ledger-shuffled': { selectedToken: 'S01', deliveredToken: 'S01', batchCommitment: batch.batchCommitment, sourceCaseId: 'loader' },
    },
  });
  const child = plan.branches.find((entry) => entry.branch === 'normal')!.config;
  await runtime.createRun(child);
  await runtime.step(child.runId);
  const lines = (value: readonly unknown[]): string => value.map((entry) => JSON.stringify(entry)).join('\n');
  const branchDocs = parseBundleFiles({
    'run-manifest.json': JSON.stringify({ signers: signersFor(child.runId).publicKeys() }),
    'run-config.json': JSON.stringify(child),
    'intervention-log.jsonl': lines(runtime.auditLog(child.runId) as readonly unknown[]),
    'turn-records.jsonl': lines(runtime.turnRecords(child.runId) as readonly unknown[]),
    'baby-a-ledger.jsonl': lines(runtime.ledgers(child.runId).babyA as readonly unknown[]),
    'baby-b-ledger.jsonl': lines(runtime.ledgers(child.runId).babyB as readonly unknown[]),
  });
  const policies: Record<string, string> = {
    'policies/baby-b-latest.json': readFileSync(join(root, 'runs', parent.runId, 'policies', 'baby-b-latest.json'), 'utf8'),
  };
  const parentDocs = parseBundleFiles({
    'run-manifest.json': JSON.stringify({ signers: signersFor(parent.runId).publicKeys() }),
    'run-config.json': JSON.stringify(parent),
    'intervention-log.jsonl': lines(runtime.auditLog(parent.runId) as readonly unknown[]),
    'turn-records.jsonl': lines(runtime.turnRecords(parent.runId) as readonly unknown[]),
    'baby-a-ledger.jsonl': lines(ledgerEvents.babyA as readonly unknown[]),
    'baby-b-ledger.jsonl': lines(ledgerEvents.babyB as readonly unknown[]),
    'checkpoints.json': JSON.stringify({ checkpointHashes: runtime.checkpoints(parent.runId).map((entry) => entry.checkpointHash) }),
    ...policies,
  });
  const payload = (runtime.auditLog(child.runId).find(
    (entry) => (entry as { reasonCode?: string }).reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed',
  ) as { details: { predictionPayload: { state: { receiverPolicyHash: string } } } }).details.predictionPayload;
  return { branchDocs, parentDocs, batch, receiverPolicyHash: payload.state.receiverPolicyHash };
}

describe('LV01 audit loader', () => {
  it('loads one branch and the shared input from live bundles', async () => {
    const harness = await createHarness({
      lv01PredictionFor: (config) => config.lv01PairedCase === undefined ? undefined : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
    });
    try {
      const { branchDocs, parentDocs, batch } = await capture(harness.runtime, harness.root, harness.signerProvider);
      const branch = loadLv01AuditedBranch(branchDocs);
      expect(branch.branch).toBe('normal');
      expect(branch.transcript.map((entry) => entry.eventType)).toEqual([
        'learner-initialization',
        'prediction-commitment',
        'action-draw-commitment',
        'receiver-action-recorded',
        'action-draw-disclosed',
      ]);
      for (let index = 1; index < branch.transcript.length; index += 1) {
        expect(branch.transcript[index]!.previousEntryHash).toBe(branch.transcript[index - 1]!.entryHash);
      }
      const shared = loadLv01AuditShared({ parentDocs, branchDocs, firstBranch: branch, treatmentBatch: batch });
      expect(shared.parent.parentCheckpointHash.length).toBeGreaterThan(0);
      expect(shared.parentLedgerEvents.babyB.length).toBeGreaterThan(0);
      expect(shared.authenticate(shared.parentLedgerEvents.babyB[0]!)).toBe(true);
      expect((shared.frozenModel as { parameterCount: number }).parameterCount).toBe(4049);
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects forged, missing, and misordered evidence', async () => {
    const harness = await createHarness({
      lv01PredictionFor: (config) => config.lv01PairedCase === undefined ? undefined : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
    });
    try {
      const { branchDocs, parentDocs, batch } = await capture(harness.runtime, harness.root, harness.signerProvider);
      const branch = loadLv01AuditedBranch(branchDocs);
      // Missing disclosure fails closed (forfeit is not evidence).
      const noDisclosure: Lv01BundleDocs = {
        ...branchDocs,
        interventions: branchDocs.interventions.filter(
          (entry) => (entry as Record<string, unknown>)['reasonCode'] !== 'lv01-shared-action-draw-disclosed',
        ),
      };
      expect(() => loadLv01AuditedBranch(noDisclosure)).toThrow(/exactly one/u);
      // Reordered intervention stream fails instead of re-sorting.
      const swapped = branchDocs.interventions.map((entry) => ({ ...(entry as Record<string, unknown>) }));
      const drawIndex = swapped.findIndex((entry) => entry['reasonCode'] === 'lv01-shared-action-draw-committed');
      const predictionIndex = swapped.findIndex(
        (entry) => entry['reasonCode'] === 'lv01-paired-pre-receiver-action-prediction-committed',
      );
      const heldAt = swapped[drawIndex]!['recordedAt'];
      swapped[drawIndex]!['recordedAt'] = swapped[predictionIndex]!['recordedAt'];
      swapped[predictionIndex]!['recordedAt'] = heldAt;
      expect(() => loadLv01AuditedBranch({ ...branchDocs, interventions: swapped })).toThrow(/causal order/u);
      // A second turn-0 intention record is ambiguous evidence.
      const events = branchDocs.ledgerB as Record<string, unknown>[];
      const intention = events.find((entry) => entry['eventType'] === 'intention.recorded')!;
      const doubled: Lv01BundleDocs = { ...branchDocs, ledgerB: [...events, { ...intention }] };
      expect(() => loadLv01AuditedBranch(doubled)).toThrow(/exactly one/u);
      // A turn outcome that disagrees with the intention selection fails.
      const turns = (branchDocs.turns as Record<string, unknown>[]).map((entry) => ({
        ...entry,
        outcome: { ...(entry['outcome'] as Record<string, unknown>), details: { selectedRef: 'o: forged' } },
      }));
      expect(() => loadLv01AuditedBranch({ ...branchDocs, turns })).toThrow(/disagrees with the intention selection/u);
      // A missing retained export fails instead of substituting another model.
      expect(() => resolveLv01FrozenModel({}, 'policies/baby-b-latest.json')).toThrow(/is missing/u);
      // A derivation checkpoint outside the retained set fails.
      const foreign: Lv01BundleDocs = { ...parentDocs, checkpoints: [`sha256:${'8'.repeat(64)}`] };
      expect(() => loadLv01AuditShared({ parentDocs: foreign, branchDocs, firstBranch: branch, treatmentBatch: batch }))
        .toThrow(/not a retained parent checkpoint/u);
    } finally {
      await harness.cleanup();
    }
  });
});
