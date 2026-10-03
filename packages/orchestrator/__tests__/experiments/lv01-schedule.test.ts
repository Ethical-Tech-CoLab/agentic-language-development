import { describe, expect, it } from 'vitest';

import { LV01_PARTITION_CASES, ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

import {
  buildLv01Schedule,
  scheduleCaseId,
  scheduledCaseFor,
  verifyLv01ScheduleCoverage,
} from '../../src/experiments/lv01-schedule.js';

function fixtureEngine(runSeed: string): ReferentialScenarioEngine {
  return new ReferentialScenarioEngine(
    {
      version: 1,
      symbolInventory: fixedTokenInventory(32),
      interactionMode: 'cooperative-signaling',
      heldOutTypeCodes: [0, 5, 10, 15],
    },
    runSeed,
  );
}

const FULL = { ...LV01_PARTITION_CASES };
const SMALL = { training: 64, 'validation-fit': 24, 'validation-selection': 24, 'within-support-test': 24 } as const;

describe('LV01 scientific case schedule', () => {
  it('materializes frozen per-partition per-role counts', () => {
    const schedule = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: FULL });
    expect(schedule.totalCases).toBe((1500 + 120 + 120 + 120) * 2);
    expect(schedule.cases.training).toHaveLength(3000);
    expect(schedule.cases['within-support-test']).toHaveLength(240);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(schedule.cases.training.filter((entry) => entry.receiverRole === role)).toHaveLength(1500);
      expect(schedule.cases['validation-fit'].filter((entry) => entry.receiverRole === role)).toHaveLength(120);
    }
    expect(schedule.commitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('balances round-robin targets exactly on complete rounds', () => {
    const schedule = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: FULL });
    for (const partition of ['training', 'validation-fit', 'validation-selection', 'within-support-test'] as const) {
      for (const role of ['baby-a', 'baby-b'] as const) {
        const targets = schedule.cases[partition]
          .filter((entry) => entry.receiverRole === role)
          .map((entry) => entry.targetTypeCode);
        const expected = targets.length / 12;
        for (let type = 0; type < 16; type += 1) {
          const seen = targets.filter((code) => code === type).length;
          if ([0, 5, 10, 15].includes(type)) expect(seen).toBe(0);
          else expect(seen).toBe(expected);
        }
      }
    }
  });

  it('keeps partial rounds within one of balanced with unique identities', () => {
    const schedule = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: { ...SMALL } });
    expect(schedule.totalCases).toBe((64 + 24 + 24 + 24) * 2);
    const states = new Set(schedule.cases.training.map((entry) => entry.stateHash));
    expect(states.size).toBe(schedule.cases.training.length);
    const ids = new Set(
      (['training', 'validation-fit', 'validation-selection', 'within-support-test'] as const).flatMap(
        (partition) => schedule.cases[partition].map((entry) => entry.caseId),
      ),
    );
    expect(ids.size).toBe(schedule.totalCases);
  });

  it('keeps scenario hashes disjoint across all partitions and roles (C2 join anchor)', () => {
    const schedule = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: { ...SMALL } });
    const partitions = ['training', 'validation-fit', 'validation-selection', 'within-support-test'] as const;
    const states = new Set(
      partitions.flatMap((partition) => schedule.cases[partition].map((entry) => entry.stateHash)),
    );
    expect(states.size).toBe(schedule.totalCases);
    const ordinary = new Set(
      (['training', 'validation-fit', 'validation-selection'] as const).flatMap(
        (partition) => schedule.cases[partition].map((entry) => entry.stateHash),
      ),
    );
    for (const entry of schedule.cases['within-support-test']) {
      expect(ordinary.has(entry.stateHash)).toBe(false);
    }
  });

  it('commits deterministically and separates run seeds', () => {
    const first = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: { ...SMALL } });
    const rebuilt = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: { ...SMALL } });
    expect(rebuilt.commitment).toBe(first.commitment);
    const other = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-other'), counts: { ...SMALL } });
    expect(other.commitment).not.toBe(first.commitment);
  });

  it('looks up scheduled cases and verifies executed coverage', () => {
    const schedule = buildLv01Schedule({ engine: fixtureEngine('lv01-schedule-fixture'), counts: { ...SMALL } });
    const entry = scheduledCaseFor(schedule, 'within-support-test', 'baby-b', 0);
    expect(entry.caseId).toBe(scheduleCaseId('within-support-test', 'baby-b', 0));
    expect(entry.targetTypeCode).toBe(1);
    expect(() => scheduledCaseFor(schedule, 'within-support-test', 'baby-b', 24)).toThrow(/no scheduled case/u);
    expect(verifyLv01ScheduleCoverage(schedule, [entry.caseId])).toBe(schedule.commitment);
    expect(verifyLv01ScheduleCoverage(schedule, [])).toBe(schedule.commitment);
    expect(() => verifyLv01ScheduleCoverage(schedule, ['within-support-test:baby-b:9999'])).toThrow(/outside the committed schedule/u);
  });

  it('rejects out-of-range counts and empty roles', () => {
    const engine = fixtureEngine('lv01-schedule-fixture');
    expect(() => buildLv01Schedule({ engine, counts: { ...FULL, training: 1501 } })).toThrow(/exceeds the frozen/u);
    expect(() => buildLv01Schedule({ engine, counts: { ...FULL, 'validation-fit': -1 } })).toThrow(/non-negative integer/u);
    expect(() => buildLv01Schedule({ engine, counts: { ...FULL, 'within-support-test': 1.5 } })).toThrow(/non-negative integer/u);
    expect(() => buildLv01Schedule({ engine, counts: { ...FULL }, receiverRoles: [] })).toThrow(/at least one receiver role/u);
  });
});
