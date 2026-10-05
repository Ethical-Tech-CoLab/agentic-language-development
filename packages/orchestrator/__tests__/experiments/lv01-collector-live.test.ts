/**
 * LV01 stage collector: live collection.
 *
 * Live tests train a tiny scratch-rl parent, export its bundle, then collect
 * and audit for real: no collector boolean reaches the auditor. Split from
 * lv01-collector.test.ts (R8-W) so planning and live suites run in parallel
 * workers; shared fixtures live in ./lv01-collector-fixtures.js.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportRunBundle, SqliteEvidenceWriter } from '@ald/evidence';
import { hashCanonical } from '@ald/hashing';
import { loadLearnerContract } from '@ald/learners';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from '../helpers.js';
import { LV01_BRANCHES, LV01_RESOURCE_COUNTERS } from '../../src/experiments/ledger-value.js';
import {
  wireLv01CollectionOrdinary,
} from '../../src/experiments/lv01-ordinary-wiring.js';
import {
  trainLv01SlotParent,
} from '../../src/experiments/lv01-parent-training.js';
import {
  bindLv01StagePacket,
  compileLv01StagePacket,
} from '../../src/experiments/lv01-stage-packets.js';
import {
  LV01_PARTITION_CASE_BINDING,
  auditLv01Stage,
  collectLv01Slot,
  collectLv01Stage,
  lv01ParentCheckpointHash,
  lv01SlotSeeds,
  readLv01BundleDocs,
} from '../../src/experiments/lv01-collector.js';
import {
  LEDGER_VALUE_PLAN,
  ORDINARY,
  fixtureParent,
  hash,
  inventory,
  packetInputWithAllocation,
} from './lv01-collector-fixtures.js';

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

  async function collectedPerSlotStage() {
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined ? undefined : { ...ORDINARY },
    });
    if (harness === undefined) throw new Error('harness unavailable');
    const active: Harness = harness;
    scratch = await mkdtemp(join(tmpdir(), 'ald-lv01-perslot-'));
    const packet = compileLv01StagePacket({
      ...(await packetInputWithAllocation(scratch)),
      slotPlan: { primaries: 2, reserves: 1 },
    });
    const binding = bindLv01StagePacket(packet, '1'.repeat(40), packet.allocation.sha256);
    const evidenceDir = join(scratch, 'evidence');
    const stageDir = join(evidenceDir, 'lv01', `${packet.stage}-v${packet.version}`);
    await mkdir(join(stageDir, 'parents'), { recursive: true });
    const seedsFor = (slot: number) => {
      const derived = lv01SlotSeeds(packet.packetCommitment, slot);
      return {
        scenario: derived.scenario,
        babyA: derived.babyA,
        babyB: derived.babyB,
        gateway: derived.gateway,
        analysis: derived.analysis,
      };
    };
    for (const slot of [1, 2]) {
      await trainLv01SlotParent({
        runtime: active.runtime,
        database: active.database,
        signerProvider: (runId: string) => active.signerProvider(runId),
        runId: `lv01-perslot-parent-${slot}`,
        seeds: seedsFor(slot),
        training: {
          track: 'scratch-rl',
          modelRef: 'gru-actor-critic-v1',
          learningSignal: 'extrinsic-task',
          maxTurnsPerRun: 4,
          evaluationTurns: 1,
        },
        ledgerValuePlan: LEDGER_VALUE_PLAN,
        runsRoot: active.root,
        bundleDir: join(stageDir, 'parents', `slot-${String(slot).padStart(4, '0')}`),
        softwareCommit: '1'.repeat(40),
        deploymentMode: 'prototype',
        protocolGitCommit: 'git:test-protocol',
      });
    }
    const store = { root: active.root, databasePath: active.databasePath };
    active.close();
    const collection = await collectLv01Stage({
      packet,
      binding,
      parentBundleDirFor: (slot: number) => join(stageDir, 'parents', `slot-${String(slot).padStart(4, '0')}`),
      evidenceDir,
      softwareCommit: '1'.repeat(40),
      partition: 'dev',
      ordinary: { ...ORDINARY },
      store,
      owner: 'lv01-collector-test',
    });
    expect(collection.journal.terminal).toBe('completed');
    expect(collection.cases).toHaveLength(2);
    return { packet, binding, stageDir, collection };
  }

  it('collects a stage with per-slot trained parents and audits it green', async () => {
    const { packet, binding, stageDir, collection } = await collectedPerSlotStage();
    expect(collection.journal.slots.filter((slot) => slot.status === 'valid').map((slot) => slot.parentBundleRef).sort())
      .toEqual(['parents/slot-0001', 'parents/slot-0002']);
    const { receipt } = await auditLv01Stage({ packet, binding, stageDir });
    expect(receipt.status).toBe('verified');
    expect(receipt.auditedCases).toHaveLength(2);
  }, 300_000);

  it('audit rejects a forged parent ref escaping the stage directory', async () => {
    const { packet, binding, stageDir } = await collectedPerSlotStage();
    const journalPath = join(stageDir, 'journal.jsonl');
    const lines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      journal: { slots: { status: string; parentBundleRef?: string }[] };
    } & Record<string, unknown>;
    const forged = {
      ...(last.journal as object),
      slots: last.journal.slots.map((slot) => slot.status === 'valid' ? { ...slot, parentBundleRef: '../escape' } : slot),
    };
    lines[lines.length - 1] = JSON.stringify({ ...last, journal: forged, journalHash: hashCanonical('lv01-stage-journal/v1', forged) });
    await writeFile(journalPath, `${lines.join('\n')}\n`, 'utf8');
    await expect(
      auditLv01Stage({ packet, binding, stageDir }),
    ).rejects.toThrow(/escapes the stage directory/u);
  }, 300_000);

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
