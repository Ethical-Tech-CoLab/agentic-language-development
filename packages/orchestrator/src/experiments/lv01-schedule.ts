/**
 * LV01 scientific case schedule (A3).
 *
 * Materializes the frozen design's evaluation cases through the dedicated
 * `generateLv01Case` generator — never the generic evaluation or held-out
 * splits — with per-partition per-role counts, round-robin target balance,
 * and cross-partition identity uniqueness, all committed under one schedule
 * commitment. Executed cases are verified as a subset of the committed
 * schedule; the executor's migration from the prohibited split to scheduled
 * lookup is tracked separately and must land before any collection.
 */
import { hashCanonical } from '@ald/hashing';
import {
  LV01_ELIGIBLE_TYPE_CODES,
  LV01_PARTITION_CASES,
  readGroundTruth,
  type ReferentialScenarioEngine,
} from '@ald/scenario';
import type { BabyRole, Lv01Partition } from '@ald/types';

function fail(message: string): never {
  throw new Error(`lv01 schedule: ${message}`);
}

export const LV01_SCHEDULE_PARTITIONS: readonly Lv01Partition[] = [
  'training',
  'validation-fit',
  'validation-selection',
  'within-support-test',
];

export type Lv01ScheduleCounts = Readonly<Record<Lv01Partition, number>>;

export interface Lv01ScheduledCase {
  readonly caseId: string;
  readonly partition: Lv01Partition;
  readonly caseIndex: number;
  readonly receiverRole: BabyRole;
  readonly targetTypeCode: number;
  readonly candidateTypeCodes: readonly number[];
  readonly candidateRefs: readonly string[];
  readonly stateHash: string;
}

export interface Lv01Schedule {
  readonly counts: Lv01ScheduleCounts;
  readonly receiverRoles: readonly BabyRole[];
  readonly cases: Readonly<Record<Lv01Partition, readonly Lv01ScheduledCase[]>>;
  readonly totalCases: number;
  readonly commitment: string;
}

export function scheduleCaseId(partition: Lv01Partition, receiverRole: BabyRole, caseIndex: number): string {
  return `${partition}:${receiverRole}:${String(caseIndex).padStart(4, '0')}`;
}

function caseCommitment(entry: Lv01ScheduledCase): string {
  return hashCanonical('lv01-scheduled-case/v1', {
    caseId: entry.caseId,
    stateHash: entry.stateHash,
    targetTypeCode: entry.targetTypeCode,
    candidateTypeCodes: [...entry.candidateTypeCodes],
  });
}

export function buildLv01Schedule(input: {
  readonly engine: ReferentialScenarioEngine;
  readonly counts: Lv01ScheduleCounts;
  readonly receiverRoles?: readonly BabyRole[];
}): Lv01Schedule {
  const roles = input.receiverRoles ?? (['baby-a', 'baby-b'] as const);
  if (roles.length === 0) fail('schedule requires at least one receiver role');
  for (const partition of LV01_SCHEDULE_PARTITIONS) {
    const count = input.counts[partition];
    if (!Number.isInteger(count) || count < 0) fail(`${partition} count must be a non-negative integer`);
    if (count > LV01_PARTITION_CASES[partition]) {
      fail(`${partition} count ${count} exceeds the frozen ${LV01_PARTITION_CASES[partition]}`);
    }
  }

  const cases = {} as Record<Lv01Partition, Lv01ScheduledCase[]>;
  for (const partition of LV01_SCHEDULE_PARTITIONS) {
    cases[partition] = [];
    for (const receiver of roles) {
      const sender: BabyRole = receiver === 'baby-a' ? 'baby-b' : 'baby-a';
      const seenTargets = new Map<number, number>();
      for (let caseIndex = 0; caseIndex < input.counts[partition]; caseIndex += 1) {
        const generated = input.engine.generateLv01Case(caseIndex, partition, { sender, receiver });
        const truth = readGroundTruth(generated.scenario.groundTruth);
        const expectedTarget = LV01_ELIGIBLE_TYPE_CODES[caseIndex % LV01_ELIGIBLE_TYPE_CODES.length];
        if (truth.targetTypeCode !== expectedTarget) {
          fail(`${partition} case ${caseIndex} target ${truth.targetTypeCode} breaks round-robin (expected ${expectedTarget})`);
        }
        if (truth.candidateTypeCodes.length !== 4 || !truth.candidateTypeCodes.includes(truth.targetTypeCode)) {
          fail(`${partition} case ${caseIndex} has malformed candidates`);
        }
        for (const code of truth.candidateTypeCodes) {
          if (!LV01_ELIGIBLE_TYPE_CODES.includes(code)) fail(`${partition} case ${caseIndex} uses ineligible type ${code}`);
        }
        cases[partition].push({
          caseId: scheduleCaseId(partition, receiver, caseIndex),
          partition,
          caseIndex,
          receiverRole: receiver,
          targetTypeCode: truth.targetTypeCode,
          candidateTypeCodes: [...truth.candidateTypeCodes],
          candidateRefs: [...truth.candidateRefs],
          stateHash: generated.scenario.stateHash,
        });
        seenTargets.set(truth.targetTypeCode, (seenTargets.get(truth.targetTypeCode) ?? 0) + 1);
      }
      // Round-robin balance per (partition, role): every eligible type sees
      // the target equally often up to the remainder of an incomplete round.
      const frequencies = LV01_ELIGIBLE_TYPE_CODES.map((code) => seenTargets.get(code) ?? 0);
      const spread = Math.max(...frequencies) - Math.min(...frequencies);
      if (spread > 1) fail(`${partition} ${receiver} targets are unbalanced (spread ${spread})`);
      if (input.counts[partition] % LV01_ELIGIBLE_TYPE_CODES.length === 0 && spread !== 0) {
        fail(`${partition} ${receiver} complete rounds must balance exactly`);
      }
    }
  }

  const all = LV01_SCHEDULE_PARTITIONS.flatMap((partition) => cases[partition]);
  const states = new Set(all.map((entry) => entry.stateHash));
  if (states.size !== all.length) fail('scheduled case identities collide across partitions and roles');
  const ids = new Set(all.map((entry) => entry.caseId));
  if (ids.size !== all.length) fail('scheduled case ids collide');

  const commitment = hashCanonical('lv01-schedule/v1', {
    counts: { ...input.counts },
    roles: [...roles],
    cases: [...all]
      .sort((left, right) => (left.caseId < right.caseId ? -1 : 1))
      .map((entry) => caseCommitment(entry)),
  });
  return {
    counts: { ...input.counts },
    receiverRoles: [...roles],
    cases,
    totalCases: all.length,
    commitment,
  };
}

export function scheduledCaseFor(
  schedule: Lv01Schedule,
  partition: Lv01Partition,
  receiverRole: BabyRole,
  caseIndex: number,
): Lv01ScheduledCase {
  const found = schedule.cases[partition].find(
    (entry) => entry.receiverRole === receiverRole && entry.caseIndex === caseIndex,
  );
  if (found === undefined) fail(`no scheduled case ${scheduleCaseId(partition, receiverRole, caseIndex)}`);
  return found;
}

/**
 * Verify an executed case set against the committed schedule. Returns the
 * schedule commitment the caller binds into its audit record; any executed
 * case outside the schedule fails closed.
 */
export function verifyLv01ScheduleCoverage(schedule: Lv01Schedule, executedCaseIds: readonly string[]): string {
  const scheduled = new Set(
    LV01_SCHEDULE_PARTITIONS.flatMap((partition) => schedule.cases[partition].map((entry) => entry.caseId)),
  );
  for (const caseId of executedCaseIds) {
    if (!scheduled.has(caseId)) fail(`executed case ${caseId} is outside the committed schedule`);
  }
  return schedule.commitment;
}
