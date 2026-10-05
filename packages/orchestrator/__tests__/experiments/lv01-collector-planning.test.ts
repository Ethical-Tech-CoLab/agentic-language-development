/**
 * LV01 stage collector: pure planning.
 *
 * Pure tests pin the scheduled lookup against direct engine generation (the
 * exact call the runtime makes for a branch turn 0) and the plan rebuild
 * against the committed plan. Split from lv01-collector.test.ts (R8-W) so
 * planning and live suites run in parallel workers; shared fixtures live in
 * ./lv01-collector-fixtures.js.
 */
import { ReferentialScenarioEngine, readGroundTruth } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  fixtureIndex,
  fixtureParent,
  fixtureSchedule,
  fixtureSlotSeeds,
  hash,
  inventory,
} from './lv01-collector-fixtures.js';
import { LV01_BRANCHES } from '../../src/experiments/ledger-value.js';
import { buildLv01Schedule } from '../../src/experiments/lv01-schedule.js';
import { verifyLv01TreatmentTargets } from '../../src/experiments/lv01-ledger-treatments.js';
import {
  assertLv01SlotBranchCensus,
  assertLv01SlotSingleServedCase,
  buildLv01TreatmentCases,
  lv01SlotSeeds,
  lv01WorkloadForCollection,
  prepareLv01PairedCase,
  rebuildLv01CasePlan,
  scheduledLv01BranchTarget,
} from '../../src/experiments/lv01-collector.js';

describe('LV01 collector pure planning', () => {
  it('resolves small-fixture and pinned prototype workloads and fails closed otherwise', () => {
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
    expect(lv01WorkloadForCollection('development', {
      allocation: {
        prototype: {
          trainingCases: 3000,
          validationFitCases: 240,
          validationSelectionCases: 240,
          withinSupportTestCases: 240,
        },
      },
    })).toEqual({
      profile: 'prototype',
      trainingTurns: 3000,
      validationFitCases: 240,
      validationSelectionCases: 240,
      withinSupportTestCases: 240,
    });
    expect(() => lv01WorkloadForCollection('development', {
      allocation: {
        prototype: {
          trainingCases: 2999,
          validationFitCases: 240,
          validationSelectionCases: 240,
          withinSupportTestCases: 240,
        },
      },
    })).toThrow(/must match the pinned full workload/u);
    expect(() => lv01WorkloadForCollection('development', {
      allocation: {
        smallFixture: { trainingCases: 4, validationFitCases: 2, validationSelectionCases: 2, withinSupportTestCases: 2 },
        prototype: { trainingCases: 3000, validationFitCases: 240, validationSelectionCases: 240, withinSupportTestCases: 240 },
      },
    })).toThrow(/both smallFixture and prototype/u);
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
