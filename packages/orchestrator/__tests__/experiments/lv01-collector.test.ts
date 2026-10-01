/**
 * LV01 stage collector: pure planning, live branch execution, slot and
 * stage collection, and audit replay from raw bundles.
 *
 * Pure tests pin the scheduled lookup against direct engine generation (the
 * exact call the runtime makes for a branch turn 0) and the plan rebuild
 * against the committed plan. Live tests train a tiny scratch-rl parent,
 * export its bundle, then collect and audit for real: no collector boolean
 * reaches the auditor.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportRunBundle, SqliteEvidenceWriter } from '@ald/evidence';
import { hashCanonical, sha256Bytes } from '@ald/hashing';
import { indexLv01TrainingLedger, loadLearnerContract } from '@ald/learners';
import { ReferentialScenarioEngine, readGroundTruth } from '@ald/scenario';
import { fixedTokenInventory, type LedgerEvent } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, testConfig, type Harness } from '../helpers.js';
import { LV01_BRANCHES, LV01_RESOURCE_COUNTERS } from '../../src/experiments/ledger-value.js';
import { buildLv01Schedule } from '../../src/experiments/lv01-schedule.js';
import {
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  type Lv01PairedPredictionProvider,
} from '../../src/experiments/lv01-paired-predictions.js';
import { verifyLv01TreatmentTargets } from '../../src/experiments/lv01-ledger-treatments.js';
import {
  wireLv01CollectionOrdinary,
} from '../../src/experiments/lv01-ordinary-wiring.js';
import {
  bindLv01StagePacket,
  compileLv01StagePacket,
} from '../../src/experiments/lv01-stage-packets.js';
import {
  LV01_PARTITION_CASE_BINDING,
  assertLv01SlotBranchCensus,
  assertLv01SlotSingleServedCase,
  auditLv01Stage,
  buildLv01TreatmentCases,
  collectLv01Slot,
  collectLv01Stage,
  lv01ParentCheckpointHash,
  lv01SlotSeeds,
  lv01WorkloadForCollection,
  prepareLv01PairedCase,
  readLv01BundleDocs,
  rebuildLv01CasePlan,
  scheduledLv01BranchTarget,
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
  const events = [
    ledgerEvent('collector-fixture', { sequence: 1, turn: 0 }),
    ledgerEvent('collector-fixture', {
      sequence: 2,
      turn: 1,
      eventType: 'hypothesis.revised',
      subjectId: 'symbol:S02',
      content: { termRef: 'symbol:S02', associationOverTypeCodes: weightsZeroExcept([[9, 2], [14, 2]]) },
    }),
  ];
  const forRole = (role: 'baby-a' | 'baby-b') => {
    const records = mapLv01LedgerAssociations(events, role, () => true);
    const cutoff = deriveLv01LedgerCutoff(records);
    return indexLv01TrainingLedger(records, role, cutoff);
  };
  return { indexA: forRole('baby-a'), indexB: forRole('baby-b') };
}

function fixtureSchedule(runSeed: string) {
  const engine = new ReferentialScenarioEngine(
    {
      version: 1,
      symbolInventory: fixedTokenInventory(32),
      interactionMode: 'cooperative-signaling',
      heldOutTypeCodes: [0, 5, 10, 15],
    },
    runSeed,
  );
  const schedule = buildLv01Schedule({
    engine,
    counts: { training: 0, 'validation-fit': 1, 'validation-selection': 1, 'within-support-test': 1 },
    receiverRoles: ['baby-a', 'baby-b'],
  });
  return { engine, schedule };
}

function fixtureSlotSeeds() {
  const seeds = lv01SlotSeeds(hash('a'), 1);
  return { scenario: seeds.scenario, babyA: seeds.babyA, babyB: seeds.babyB, gateway: seeds.gateway, analysis: seeds.analysis };
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

async function packetInputWithAllocation(dir: string) {
  const allocation = {
    schemaVersion: 1,
    studyId: 'LV01',
    status: 'design-locked-not-executed',
    allocation: {
      smallFixture: { trainingCases: 4, validationFitCases: 2, validationSelectionCases: 2, withinSupportTestCases: 2 },
    },
  };
  const path = join(dir, 'allocation.fixture.json');
  const raw = `${JSON.stringify(allocation)}\n`;
  await writeFile(path, raw, 'utf8');
  return { ...packetInput(), allocation: { path, sha256: `sha256:${sha256Bytes(Buffer.from(raw, 'utf8')).toString('hex')}` } };
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

  it('looks up exactly the scheduled case the runtime serves a branch turn 0', () => {
    const parent = fixtureParent();
    const seeds = lv01SlotSeeds(hash('a'), 1);
    const engine = new ReferentialScenarioEngine(
      {
        version: 1,
        symbolInventory: fixedTokenInventory(32),
        interactionMode: parent.interactionMode,
        heldOutTypeCodes: [0, 5, 10, 15],
      },
      seeds.scenario,
    );
    const schedule = buildLv01Schedule({
      engine,
      counts: { training: 0, 'validation-fit': 2, 'validation-selection': 2, 'within-support-test': 2 },
      receiverRoles: ['baby-a', 'baby-b'],
    });
    const scheduled = scheduledLv01BranchTarget({ schedule, partition: 'within-support-test', caseIndex: 0, receiver: 'baby-b' });
    expect(scheduled.receiver).toBe('baby-b');
    expect(scheduled.scheduledCaseId).toBe('within-support-test:baby-b:0000');
    // The runtime's own service call, replicated argument for argument.
    const cased = engine.generateLv01Case(0, 'within-support-test', { sender: 'baby-a', receiver: 'baby-b' });
    const truth = readGroundTruth(cased.scenario.groundTruth);
    expect(scheduled.targetTypeCode).toBe(truth.targetTypeCode);
    expect([...scheduled.candidateTypeCodes]).toEqual([...truth.receiverOrder]);
    expect([...scheduled.candidateRefs]).toEqual([...truth.candidateRefs]);
    expect(scheduled.stateHash).toBe(cased.scenario.stateHash);
  });

  it('keys one treatment case per ledger branch on the scheduled target', () => {
    const { schedule } = fixtureSchedule(hash('7'));
    const scheduled = scheduledLv01BranchTarget({ schedule, partition: 'within-support-test', caseIndex: 0, receiver: 'baby-b' });
    const [consistent, shuffled] = buildLv01TreatmentCases(scheduled, 'lv01-x');
    expect(consistent?.caseId).toBe('lv01-x-ledger-consistent:turn:0');
    expect(shuffled?.caseId).toBe('lv01-x-ledger-shuffled:turn:0');
    expect(consistent?.receiverRole).toBe('baby-b');
    expect(consistent?.targetTypeCode).toBe(scheduled.targetTypeCode);
    expect(consistent?.targetTypeCode).toBe(shuffled?.targetTypeCode);
  });

  it('commits the batch before planning slices onto ledger branches only', () => {
    const parent = fixtureParent();
    const { indexA, indexB } = fixtureIndex();
    const { schedule } = fixtureSchedule(hash('s'));
    const scheduled = scheduledLv01BranchTarget({ schedule, partition: 'within-support-test', caseIndex: 0, receiver: 'baby-b' });
    const prefix = 'lv01-collector-case';
    const { plan, batch } = prepareLv01PairedCase({
      parent,
      parentCheckpointHash: hash('c'),
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: prefix,
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
      treatmentCases: [...buildLv01TreatmentCases(scheduled, prefix)],
      nativeIndexes: { babyA: indexA, babyB: indexB },
      symbolInventory: [...inventory],
      derangementSeed: hash('d'),
      slotSeeds: fixtureSlotSeeds(),
      scheduledCase: { partition: 'within-support-test', caseIndex: 0, receiverRole: 'baby-b' },
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
    const { indexA, indexB } = fixtureIndex();
    const { schedule } = fixtureSchedule(hash('s'));
    const scheduled = scheduledLv01BranchTarget({ schedule, partition: 'within-support-test', caseIndex: 0, receiver: 'baby-b' });
    const prefix = 'lv01-collector-rebuild';
    const { plan } = prepareLv01PairedCase({
      parent,
      parentCheckpointHash: hash('c'),
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: prefix,
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0002', partition: 'dev' },
      treatmentCases: [...buildLv01TreatmentCases(scheduled, prefix)],
      nativeIndexes: { babyA: indexA, babyB: indexB },
      symbolInventory: [...inventory],
      derangementSeed: hash('d'),
      slotSeeds: fixtureSlotSeeds(),
      scheduledCase: { partition: 'within-support-test', caseIndex: 0, receiverRole: 'baby-b' },
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

  it('census accepts exactly the seven contracted branch entries in any order', () => {
    const expected = [...LV01_BRANCHES].map((branch) => `lv01-development-v101-s0001-${branch}`);
    expect(() => assertLv01SlotBranchCensus(1, [...expected].reverse(), expected)).not.toThrow();
  });

  it('census rejects an extra branch entry beyond the contract', () => {
    const expected = [...LV01_BRANCHES].map((branch) => `lv01-development-v101-s0001-${branch}`);
    expect(() => assertLv01SlotBranchCensus(1, [...expected, 'lv01-development-v101-s0001-evil'], expected)).toThrow(
      /branch census disagrees with the seven-branch contract/u,
    );
  });

  it('census rejects a missing branch entry', () => {
    const expected = [...LV01_BRANCHES].map((branch) => `lv01-development-v101-s0001-${branch}`);
    expect(() => assertLv01SlotBranchCensus(1, expected.slice(1), expected)).toThrow(
      /branch census disagrees with the seven-branch contract/u,
    );
  });

  it('singleton accepts one served case across all branches', () => {
    expect(() => assertLv01SlotSingleServedCase(1, Array.from({ length: 7 }, () => 'state-hash'))).not.toThrow();
  });

  it('singleton rejects branches serving distinct cases', () => {
    expect(() => assertLv01SlotSingleServedCase(1, ['hash-a', 'hash-b'])).toThrow(
      /served 2 distinct cases, expected exactly one/u,
    );
  });

  it('singleton rejects an empty served set', () => {
    expect(() => assertLv01SlotSingleServedCase(1, [])).toThrow(
      /served 0 distinct cases, expected exactly one/u,
    );
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

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
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
    const scheduleRecord = JSON.parse(await readFile(join(collected.caseDir, 'schedule.json'), 'utf8')) as {
      commitment: string;
      executedCaseId: string;
    };
    expect(scheduleRecord.commitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(scheduleRecord.executedCaseId).toBe('within-support-test:baby-b:0000');
    expect(collected.caseCommitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(collected.executions).toHaveLength(7);
    expect(collected.executions.map((entry) => entry.branch)).toEqual([...LV01_BRANCHES]);
    expect(Object.keys(collected.outcomes)).toHaveLength(7);
    for (const counter of LV01_RESOURCE_COUNTERS) {
      const value = collected.resources[counter];
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(collected.resources.unresolved).toEqual([]);
    const batch = JSON.parse(await readFile(join(collected.caseDir, 'treatment-batch.json'), 'utf8')) as {
      cases: unknown[];
    };
    expect(batch.cases).toHaveLength(2);
  }, 120_000);

  it('collects one slot with a wired fitted ordinary provider', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const babyB = (caseId: string, action: number) => ({
      caseId,
      receiverRole: 'baby-b' as const,
      deliveredToken: inventory[action % inventory.length] as string,
      candidateTypeCodes: [1, 2, 3, 4],
      actualSelectedCandidateIndex: action % 4,
    });
    const { provider, receipt } = wireLv01CollectionOrdinary({
      inventory: [...inventory],
      training: [babyB('wire-train-0', 0), babyB('wire-train-1', 1), babyB('wire-train-2', 2), babyB('wire-train-3', 3)],
      validationFit: [babyB('wire-fit-0', 1), babyB('wire-fit-1', 2)],
      validationSelection: [babyB('wire-sel-0', 0), babyB('wire-sel-1', 3)],
    });
    expect(receipt.receiverRole).toBe('baby-b');

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
    const stageDir = join(scratch, 'stage');
    const collected = await collectLv01Slot({
      packet,
      slot: 1,
      kind: 'primary',
      parentBundleDir: bundleDir,
      stageDir,
      softwareCommit: 'git:lv01-collector-test',
      partition: 'dev',
      ordinary: { ...provider },
      store,
    });
    expect(collected.caseCommitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(collected.executions).toHaveLength(7);
    expect(Object.keys(collected.outcomes)).toHaveLength(7);
  }, 120_000);

  it('collects a stage and audits it to a verified receipt', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), packet.allocation.sha256);
    const evidenceDir = join(scratch, 'evidence');
    const collection = await collectLv01Stage({
      packet,
      binding,
      parentBundleDir: bundleDir,
      evidenceDir,
      softwareCommit: '1'.repeat(40),
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    });
    expect(collection.journal.terminal).toBe('completed');
    expect(collection.cases).toHaveLength(1);
    expect(collection.slots).toHaveLength(1);

    const stageDir = join(evidenceDir, 'lv01', `${packet.stage}-v${packet.version}`);
    const { receipt, reportPath } = await auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir });
    expect(receipt.status).toBe('verified');
    expect(receipt.auditedCases).toHaveLength(1);
    expect(reportPath).toBe(join(stageDir, 'audit-receipt.json'));
  }, 180_000);

  it('binds every CLI draw-scope partition to the within-support-test case partition', () => {
    expect(LV01_PARTITION_CASE_BINDING).toEqual({
      dev: 'within-support-test',
      'within-support': 'within-support-test',
      'novel-composition': 'within-support-test',
    });
  });

  it('rejects a collect whose software commit differs from the bound source', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), packet.allocation.sha256);
    await expect(collectLv01Stage({
      packet,
      binding,
      parentBundleDir: bundleDir,
      evidenceDir: join(scratch, 'evidence'),
      softwareCommit: '2'.repeat(40),
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    })).rejects.toThrow('does not match bound source');
  });

  it('rejects a collect under the reserved novel-composition label', async () => {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), packet.allocation.sha256);
    await expect(collectLv01Stage({
      packet,
      binding,
      parentBundleDir: bundleDir,
      evidenceDir: join(scratch, 'evidence'),
      softwareCommit: '1'.repeat(40),
      partition: 'novel-composition',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    })).rejects.toThrow('is reserved: no protocol case counterpart exists');
  });

  async function collectedStage() {
    const { bundleDir } = await trainedParentBundle();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const store = { root: harness.root, databasePath: harness.databasePath };
    harness.close();

    const packet = compileLv01StagePacket(await packetInputWithAllocation(scratch));
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), packet.allocation.sha256);
    const evidenceDir = join(scratch, 'evidence');
    const collection = await collectLv01Stage({
      packet,
      binding,
      parentBundleDir: bundleDir,
      evidenceDir,
      softwareCommit: '1'.repeat(40),
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    });
    // Tamper tests require a valid collection: auditing a failed terminal
    // skips every slot and would resolve instead of engaging the checks.
    expect(collection.journal.terminal).toBe('completed');
    expect(collection.cases).toHaveLength(1);
    expect(collection.slots).toHaveLength(1);
    const stageDir = join(evidenceDir, 'lv01', `${packet.stage}-v${packet.version}`);
    return { packet, binding, bundleDir, stageDir, caseDir: join(stageDir, 'slot-0001') };
  }

  async function scheduleRecord(caseDir: string) {
    return JSON.parse(await readFile(join(caseDir, 'schedule.json'), 'utf8')) as {
      commitment: string;
      executedCaseId: string;
    };
  }

  it('audit rejects a binding that does not match the packet (F1-BIND)', async () => {
    const { packet, binding, bundleDir, stageDir } = await collectedStage();
    const forged = { ...binding, packetCommitment: hash('9') };
    await expect(
      auditLv01Stage({ packet, binding: forged, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/binding does not match the registered packet/u);
  }, 180_000);

  it('audit rejects a missing allocation file (F1-ALLOC-MISSING)', async () => {
    const { packet, binding, bundleDir, stageDir } = await collectedStage();
    await rm(packet.allocation.path, { force: true });
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/allocation file .* is missing/u);
  }, 180_000);

  it('audit rejects a changed allocation file (F1-ALLOC-CHANGED)', async () => {
    const { packet, binding, bundleDir, stageDir } = await collectedStage();
    const raw = await readFile(packet.allocation.path, 'utf8');
    await writeFile(packet.allocation.path, `${raw} `, 'utf8');
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/allocation bytes differ from the registered packet allocation/u);
  }, 180_000);

  it('audit rejects a changed schedule commitment (F1-COMM-CHANGED)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    const record = await scheduleRecord(caseDir);
    await writeFile(join(caseDir, 'schedule.json'), JSON.stringify({ ...record, commitment: hash('9') }), 'utf8');
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/schedule commitment disagrees with the rebuilt schedule/u);
  }, 180_000);

  it('audit rejects a missing schedule record (F1-COMM-MALFORMED)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    await rm(join(caseDir, 'schedule.json'), { force: true });
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/schedule record is malformed/u);
  }, 180_000);

  it('audit rejects a corrupt schedule record (F1-COMM-MALFORMED)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    await writeFile(join(caseDir, 'schedule.json'), '{not valid json', 'utf8');
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/schedule record is malformed/u);
  }, 180_000);

  it('audit rejects a wrong-shape schedule record (F1-COMM-MALFORMED)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    await writeFile(join(caseDir, 'schedule.json'), JSON.stringify({ commitment: 42 }), 'utf8');
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/schedule record is malformed/u);
  }, 180_000);

  it('audit rejects an executed case from another scheduled slot (F1-CASE-WRONG)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    const record = await scheduleRecord(caseDir);
    await writeFile(
      join(caseDir, 'schedule.json'),
      JSON.stringify({ ...record, executedCaseId: 'within-support-test:baby-a:0000' }),
      'utf8',
    );
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/is not the scheduled slot case/u);
  }, 180_000);

  it('audit rejects an executed case outside the schedule (F1-CASE-OUTSIDE)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    const record = await scheduleRecord(caseDir);
    await writeFile(
      join(caseDir, 'schedule.json'),
      JSON.stringify({ ...record, executedCaseId: 'within-support-test:baby-b:9999' }),
      'utf8',
    );
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/is outside the committed schedule/u);
  }, 180_000);

  it('audit rejects an extra branch directory beyond the seven-branch contract (CENSUS-EXTRA)', async () => {
    const { packet, binding, bundleDir, stageDir, caseDir } = await collectedStage();
    await mkdir(join(caseDir, 'branches', `lv01-${packet.stage}-v${packet.version}-s0001-evil`), { recursive: true });
    await expect(
      auditLv01Stage({ packet, binding, parentBundleDir: bundleDir, stageDir }),
    ).rejects.toThrow(/branch census disagrees with the seven-branch contract/u);
  }, 180_000);
});
