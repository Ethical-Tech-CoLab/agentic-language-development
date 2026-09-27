/**
 * LV01 stage collector: pure planning, live branch execution, slot and
 * stage collection, and audit replay from raw bundles.
 *
 * Pure tests pin the peek against direct engine generation (the exact call
 * the runtime makes for a branch turn 0) and the plan rebuild against the
 * committed plan. Live tests train a tiny scratch-rl parent, export its
 * bundle, then collect and audit for real: no collector boolean reaches
 * the auditor.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportRunBundle, SqliteEvidenceWriter } from '@ald/evidence';
import { hashCanonical } from '@ald/hashing';
import { indexLv01TrainingLedger, loadLearnerContract } from '@ald/learners';
import { ReferentialScenarioEngine, readGroundTruth } from '@ald/scenario';
import { fixedTokenInventory, otherRole, type LedgerEvent } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, testConfig, type Harness } from '../helpers.js';
import { senderForTurn } from '../../src/nursery-runtime.js';
import { LV01_BRANCHES } from '../../src/experiments/ledger-value.js';
import {
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  type Lv01PairedPredictionProvider,
} from '../../src/experiments/lv01-paired-predictions.js';
import { verifyLv01TreatmentTargets } from '../../src/experiments/lv01-ledger-treatments.js';
import {
  bindLv01StagePacket,
  compileLv01StagePacket,
} from '../../src/experiments/lv01-stage-packets.js';
import {
  auditLv01Stage,
  buildLv01TreatmentCases,
  collectLv01Slot,
  collectLv01Stage,
  lv01ParentCheckpointHash,
  lv01SlotSeeds,
  lv01WorkloadForCollection,
  peekLv01BranchTarget,
  prepareLv01PairedCase,
  readLv01BundleDocs,
  rebuildLv01CasePlan,
} from '../../src/experiments/lv01-collector.js';

const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const inventory = fixedTokenInventory(32);
const ORDINARY: Lv01PairedPredictionProvider = {
  ordinaryId: 'uniform',
  ordinaryFit: { kind: 'uniform' },
};
const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: hash('a'),
  analysisCommitmentHash: hash('b'),
  seedResourceCommitmentHash: hash('c'),
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

function weightsZeroExcept(entries: Array<[number, number]>): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  for (const [index, value] of entries) array[index] = value;
  return array;
}

function ledgerEvent(runId: string, partial: Partial<LedgerEvent> & { sequence: number }): LedgerEvent {
  return {
    version: 1,
    runId,
    babyId: 'B',
    turn: 0,
    eventType: 'hypothesis.created',
    contentSchema: 'agent-native-ledger',
    subjectId: 'symbol:S01',
    content: { termRef: 'symbol:S01', associationOverTypeCodes: weightsZeroExcept([[1, 3], [4, 1]]) },
    blindingNonce: 'nonce',
    previousEntryHash: hash('0'),
    recordedAt: '2026-09-27T00:00:00.000Z',
    writerKeyId: 'test-key',
    entryHash: hashCanonical('collector-fixture-entry/v1', `${runId}:${partial.sequence}`),
    writerSignature: 'sig',
    ...partial,
  } as LedgerEvent;
}

function fixtureParent() {
  const rootSeed = hash('7');
  return testConfig({
    runId: 'lv01-collector-parent',
    experimentId: 'LV01',
    randomSeed: rootSeed,
    seedBindings: {
      version: 1,
      scenario: rootSeed,
      babyA: hash('1'),
      babyB: hash('2'),
      gateway: hash('3'),
      analysis: hash('4'),
    },
    babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 4,
    evaluationTurns: 1,
    ledgerValuePlan: LEDGER_VALUE_PLAN,
  });
}

function fixtureIndex() {
  const records = mapLv01LedgerAssociations(
    [
      ledgerEvent('collector-fixture', { sequence: 1, turn: 0 }),
      ledgerEvent('collector-fixture', {
        sequence: 2,
        turn: 1,
        eventType: 'hypothesis.revised',
        subjectId: 'symbol:S02',
        content: { termRef: 'symbol:S02', associationOverTypeCodes: weightsZeroExcept([[9, 2], [14, 2]]) },
      }),
    ],
    'baby-b',
    () => true,
  );
  const cutoff = deriveLv01LedgerCutoff(records);
  return { records, cutoff, index: indexLv01TrainingLedger(records, 'baby-b', cutoff) };
}

function packetInput() {
  return {
    stage: 'development' as const,
    version: 101,
    designVersion: 2 as const,
    designCommitmentHash: hash('a'),
    analysisCommitmentHash: hash('b'),
    seedResourceCommitmentHash: hash('c'),
    sourceCommit: 'd'.repeat(40),
    modelIdentity: {
      architecture: 'gru-actor-critic-v1' as const,
      track: 'scratch-rl' as const,
      parameterCountPerAgent: 4049 as const,
      inputSize: 50 as const,
      hiddenSize: 16 as const,
    },
    allocation: { path: 'protocols/lv01-development-resource-allocation.v101.json', sha256: hash('e') },
    qualifications: {
      designCheck: 'passed' as const,
      powerCheck: 'passed' as const,
      topology: { path: 'reports/research/lv01-topology-qualification.v101.json', sha256: hash('f'), passed: true as const },
    },
    slotPlan: { primaries: 1, reserves: 1 },
  };
}

describe('LV01 collector pure planning', () => {
  it('resolves only small-fixture workloads and fails closed otherwise', () => {
    const allocation = {
      allocation: {
        smallFixture: {
          trainingCases: 4,
          validationFitCases: 2,
          validationSelectionCases: 2,
          withinSupportTestCases: 2,
        },
      },
    };
    expect(lv01WorkloadForCollection('development', allocation)).toEqual({
      profile: 'small-fixture',
      trainingTurns: 4,
      validationFitCases: 2,
      validationSelectionCases: 2,
      withinSupportTestCases: 2,
    });
    expect(() => lv01WorkloadForCollection('development', { allocation: {} })).toThrow(/small-fixture/);
    expect(() => lv01WorkloadForCollection('development', null)).toThrow(/small-fixture/);
  });

  it('derives deterministic slot seeds with no fresh entropy', () => {
    const first = lv01SlotSeeds(hash('a'), 1);
    expect(lv01SlotSeeds(hash('a'), 1)).toEqual(first);
    expect(lv01SlotSeeds(hash('a'), 2)).not.toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(6);
  });

  it('peeks exactly the instance the runtime serves a branch turn 0', () => {
    const parent = fixtureParent();
    const peeked = peekLv01BranchTarget({
      randomSeed: parent.randomSeed,
      symbolInventorySize: 32,
      interactionMode: parent.interactionMode,
      heldOutTypeCodes: parent.interventionPlan?.heldOutTypeCodes ?? [],
      roleReversalPeriod: parent.roleReversalPeriod,
    });
    expect(peeked.receiver).toBe('baby-b');
    // The runtime's own service call, replicated argument for argument.
    const engine = new ReferentialScenarioEngine(
      {
        version: 1,
        symbolInventory: fixedTokenInventory(32),
        interactionMode: parent.interactionMode,
        heldOutTypeCodes: parent.interventionPlan?.heldOutTypeCodes ?? [],
      },
      parent.randomSeed,
    );
    const sender = senderForTurn(0, parent.roleReversalPeriod);
    const instance = engine.generate(0, 'evaluation', { sender, receiver: otherRole(sender) });
    const truth = readGroundTruth(instance.groundTruth);
    expect(peeked.targetTypeCode).toBe(truth.targetTypeCode);
    expect([...peeked.candidateTypeCodes]).toEqual([...truth.receiverOrder]);
    expect([...peeked.candidateRefs]).toEqual([...truth.candidateRefs]);
    expect(peeked.stateHash).toBe(instance.stateHash);
  });

  it('keys one treatment case per ledger branch on the peeked target', () => {
    const peeked = peekLv01BranchTarget({
      randomSeed: hash('7'),
      symbolInventorySize: 32,
      interactionMode: 'cooperative-signaling',
      heldOutTypeCodes: [],
      roleReversalPeriod: 1,
    });
    const [consistent, shuffled] = buildLv01TreatmentCases(peeked, 'lv01-x');
    expect(consistent?.caseId).toBe('lv01-x-ledger-consistent:turn:0');
    expect(shuffled?.caseId).toBe('lv01-x-ledger-shuffled:turn:0');
    expect(consistent?.receiverRole).toBe('baby-b');
    expect(consistent?.targetTypeCode).toBe(peeked.targetTypeCode);
    expect(consistent?.targetTypeCode).toBe(shuffled?.targetTypeCode);
  });

  it('commits the batch before planning slices onto ledger branches only', () => {
    const parent = fixtureParent();
    const { index } = fixtureIndex();
    const peeked = peekLv01BranchTarget({
      randomSeed: parent.randomSeed,
      symbolInventorySize: 32,
      interactionMode: parent.interactionMode,
      heldOutTypeCodes: parent.interventionPlan?.heldOutTypeCodes ?? [],
      roleReversalPeriod: parent.roleReversalPeriod,
    });
    const prefix = 'lv01-collector-case';
    const { plan, batch } = prepareLv01PairedCase({
      parent,
      parentCheckpointHash: hash('c'),
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: prefix,
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
      treatmentCases: [...buildLv01TreatmentCases(peeked, prefix)],
      nativeIndex: index,
      symbolInventory: [...inventory],
      derangementSeed: hash('d'),
    });
    expect(plan.branches).toHaveLength(7);
    expect(plan.branches.map((entry) => entry.branch)).toEqual([...LV01_BRANCHES]);
    for (const entry of plan.branches) {
      expect(entry.config.runId).toBe(`${prefix}-${entry.branch}`);
      const slice = entry.config.lv01PairedCase?.ledgerTreatment;
      if (entry.branch === 'ledger-consistent' || entry.branch === 'ledger-shuffled') {
        expect(slice?.batchCommitment).toBe(batch.batchCommitment);
      } else {
        expect(slice).toBeUndefined();
      }
    }
    verifyLv01TreatmentTargets(
      batch,
      batch.cases.map((entry) => ({ caseId: entry.caseId, targetTypeCode: entry.targetTypeCode })),
    );
    expect(() =>
      verifyLv01TreatmentTargets(batch, [{ caseId: 'foreign', targetTypeCode: 1 }]),
    ).toThrow(/never served/);
    expect(() =>
      verifyLv01TreatmentTargets(
        batch,
        batch.cases.map((entry) => ({ caseId: entry.caseId, targetTypeCode: entry.targetTypeCode + 1 })),
      ),
    ).toThrow(/wrong case/);
  });

  it('rebuilds the registered plan from branch run-configs alone', () => {
    const parent = fixtureParent();
    const { index } = fixtureIndex();
    const peeked = peekLv01BranchTarget({
      randomSeed: parent.randomSeed,
      symbolInventorySize: 32,
      interactionMode: parent.interactionMode,
      heldOutTypeCodes: parent.interventionPlan?.heldOutTypeCodes ?? [],
      roleReversalPeriod: parent.roleReversalPeriod,
    });
    const prefix = 'lv01-collector-rebuild';
    const { plan } = prepareLv01PairedCase({
      parent,
      parentCheckpointHash: hash('c'),
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: prefix,
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0002', partition: 'dev' },
      treatmentCases: [...buildLv01TreatmentCases(peeked, prefix)],
      nativeIndex: index,
      symbolInventory: [...inventory],
      derangementSeed: hash('d'),
    });
    const docsFor = (runConfig: unknown) => ({
      runManifest: {},
      runConfig,
      interventions: [],
      turns: [],
      ledgerA: [],
      ledgerB: [],
      policies: {},
      checkpoints: [],
    });
    const rebuilt = rebuildLv01CasePlan({
      parentDocs: docsFor(parent),
      branchDocs: plan.branches.map((entry) => docsFor(entry.config)),
    });
    expect(rebuilt.preStateCommitment).toBe(plan.preStateCommitment);
    expect(rebuilt.branches.map((entry) => entry.config.runId)).toEqual(
      plan.branches.map((entry) => entry.config.runId),
    );
    // Hyphenated branch names must not corrupt the prefix recovery.
    expect(rebuilt.branches[6]?.config.runId.endsWith('-ledger-shuffled')).toBe(true);
  });
});

describe('LV01 collector live collection', () => {
  let harness: Harness | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  async function trainedParentBundle(): Promise<{ parentRunId: string; bundleDir: string }> {
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined ? undefined : { ...ORDINARY },
    });
    if (harness === undefined) throw new Error('harness unavailable');
    const parent = fixtureParent();
    await harness.runtime.createRun(parent);
    await harness.runtime.runToCompletion(parent.runId);
    expect(harness.runtime.turnRecords(parent.runId)).toHaveLength(5);

    const policiesDir = join(harness.root, 'runs', parent.runId, 'policies');
    const policyFiles: Record<string, unknown> = {};
    for (const name of ['baby-a-latest.json', 'baby-b-latest.json']) {
      policyFiles[name] = JSON.parse(await readFile(join(policiesDir, name), 'utf8')) as unknown;
    }
    scratch = await mkdtemp(join(tmpdir(), 'ald-lv01-collect-'));
    const bundleDir = join(scratch, 'parent-bundle');
    const writer = new SqliteEvidenceWriter({
      database: harness.database,
      signers: harness.signerProvider(parent.runId),
    });
    await exportRunBundle(writer, parent.runId, bundleDir, {
      softwareCommit: 'git:lv01-collector-test',
      learnerContracts: ['scratch-rl'].map((track) => {
        const contract = loadLearnerContract(track as 'scratch-rl');
        return { track, version: contract.version, text: contract.text };
      }),
      policyFiles,
    });
    const docs = await readLv01BundleDocs(bundleDir);
    expect(lv01ParentCheckpointHash(docs)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    return { parentRunId: parent.runId, bundleDir };
  }

  it('collects one slot end to end with a self-audited case', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    // The collector opens the same store file; close the setup handle first.
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(packetInput());
    const stageDir = join(scratch, 'stage');
    const collected = await collectLv01Slot({
      packet,
      slot: 1,
      kind: 'primary',
      parentBundleDir: bundleDir,
      stageDir,
      softwareCommit: 'git:lv01-collector-test',
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
    });
    expect(collected.caseCommitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(collected.executions).toHaveLength(7);
    expect(collected.executions.map((entry) => entry.branch)).toEqual([...LV01_BRANCHES]);
    expect(Object.keys(collected.outcomes)).toHaveLength(7);
    for (const value of Object.values(collected.resources)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    const batch = JSON.parse(await readFile(join(collected.caseDir, 'treatment-batch.json'), 'utf8')) as {
      cases: unknown[];
    };
    expect(batch.cases).toHaveLength(2);
  }, 120_000);

  it('collects a stage and audits it to a verified receipt', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(packetInput());
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), hash('e'));
    const evidenceDir = join(scratch, 'evidence');
    const collection = await collectLv01Stage({
      packet,
      binding,
      parentBundleDir: bundleDir,
      evidenceDir,
      softwareCommit: 'git:lv01-collector-test',
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    });
    expect(collection.journal.terminal).toBe('completed');
    expect(collection.cases).toHaveLength(1);
    expect(collection.slots).toHaveLength(1);

    const stageDir = join(evidenceDir, 'lv01', `${packet.stage}-v${packet.version}`);
    const { receipt, reportPath } = await auditLv01Stage({ packet, parentBundleDir: bundleDir, stageDir });
    expect(receipt.status).toBe('verified');
    expect(receipt.auditedCases).toHaveLength(1);
    expect(reportPath).toBe(join(stageDir, 'audit-receipt.json'));
  }, 180_000);
});
