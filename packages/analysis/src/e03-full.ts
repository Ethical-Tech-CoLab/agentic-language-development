import { E03_COMMUNICATION_CONDITIONS } from './e03-design.js';
import type { E03RegisteredRun } from './e03-registration.js';
import { AnalysisError } from './errors.js';

type Condition = (typeof E03_COMMUNICATION_CONDITIONS)[number];
export type E03FullInvalidReason = 'verifier-failure' | 'configuration-mismatch' |
  'gateway-control-mismatch' | 'infrastructure-failure';

export interface E03FullAttemptedRun {
  readonly runId: string;
  readonly slot: number;
  readonly use: 'primary' | 'reserve';
  readonly condition: Condition;
  readonly valid: boolean;
  readonly invalidReason?: E03FullInvalidReason;
  readonly bundleVerified?: boolean;
  readonly agreements?: number;
  readonly scenarioStateHashes?: readonly string[];
}

export interface E03FullIncludedPair {
  readonly primarySlot: number;
  readonly sourceSlot: number;
  readonly use: 'primary' | 'reserve';
  readonly scenarioStateHashes: readonly string[];
  readonly runIds: Readonly<Record<Condition, string>>;
  readonly rates: Readonly<Record<Condition, number>>;
}

export interface E03FullPairedReconciliation {
  readonly status: 'complete' | 'incomplete';
  readonly plannedRuns: 168;
  readonly attemptedRuns: number;
  readonly primaryAttempts: 150;
  readonly reserveAttempts: number;
  readonly includedPairs: readonly E03FullIncludedPair[];
  readonly invalidPrimarySlots: readonly number[];
  readonly invalidReserveSlots: readonly number[];
  readonly replacements: readonly { primarySlot: number; reserveSlot: number }[];
  readonly validButExcludedRunIds: readonly string[];
  readonly unattemptedReserveRunIds: readonly string[];
}

const fail = (message: string): never => { throw new AnalysisError('domain', message); };
const validReasons = new Set<E03FullInvalidReason>([
  'verifier-failure', 'configuration-mismatch',
  'gateway-control-mismatch', 'infrastructure-failure',
]);

export function reconcileE03FullPairedRuns(
  registered: readonly E03RegisteredRun[], attempted: readonly E03FullAttemptedRun[],
): E03FullPairedReconciliation {
  if (registered.length !== 168) fail('E03 full packet must register 168 potential runs');
  const byId = new Map(registered.map((run) => [run.config.runId, run]));
  if (byId.size !== 168) fail('E03 full packet repeats a run ID');
  const bySlot = new Map<number, E03RegisteredRun[]>();
  for (const run of registered) {
    if (!Number.isInteger(run.slot) || run.slot < 1 || run.slot > 28 ||
        run.use !== (run.slot <= 25 ? 'primary' : 'reserve')) {
      fail('E03 full packet has an invalid primary/reserve slot');
    }
    const group = bySlot.get(run.slot) ?? [];
    group.push(run);
    bySlot.set(run.slot, group);
  }
  const scenarioSeeds = new Set<string>();
  for (let slot = 1; slot <= 28; slot += 1) {
    const group = bySlot.get(slot) ?? [];
    if (group.length !== 6 || new Set(group.map((run) => run.condition)).size !== 6 ||
        E03_COMMUNICATION_CONDITIONS.some((condition) =>
          !group.some((run) => run.condition === condition))) {
      fail(`E03 full slot ${slot} does not register all six conditions`);
    }
    const seeds = new Set(group.map((run) => run.config.randomSeed));
    if (seeds.size !== 1 || scenarioSeeds.has(group[0]!.config.randomSeed)) {
      fail(`E03 full slot ${slot} does not have a fresh shared scenario seed`);
    }
    scenarioSeeds.add(group[0]!.config.randomSeed);
  }
  const observed = new Map<string, E03FullAttemptedRun>();
  for (const run of attempted) {
    const binding = byId.get(run.runId);
    if (!binding || observed.has(run.runId) || run.slot !== binding.slot ||
        run.use !== binding.use || run.condition !== binding.condition) {
      fail(`${run.runId}: unregistered, duplicate, or misbound full attempt`);
    }
    if (run.valid) {
      if (run.invalidReason !== undefined || run.bundleVerified !== true ||
          !Number.isInteger(run.agreements) ||
          run.agreements! < 0 || run.agreements! > 200 ||
          run.scenarioStateHashes?.length !== 200 ||
          run.scenarioStateHashes.some((hash) => !/^sha256:[0-9a-f]{64}$/u.test(hash))) {
        fail(`${run.runId}: valid full attempt lacks verified 200-episode original data`);
      }
    } else if (!run.invalidReason || !validReasons.has(run.invalidReason)) {
      fail(`${run.runId}: invalid full attempt lacks a registered invalidity reason`);
    }
    observed.set(run.runId, run);
  }
  const primaryAttempts = registered.filter((run) => run.use === 'primary')
    .filter((run) => observed.has(run.config.runId)).length;
  if (primaryAttempts !== 150) fail('E03 full primary collection is incomplete; no scientific decision');

  const paired = (slot: number): E03FullIncludedPair | null => {
    const group = bySlot.get(slot)!;
    const rows = group.map((run) => observed.get(run.config.runId)!);
    if (rows.some((row) => !row.valid)) return null;
    const reference = rows[0]!.scenarioStateHashes!;
    for (const row of rows.slice(1)) {
      if (row.scenarioStateHashes!.some((hash, index) => hash !== reference[index])) {
        fail(`E03 full slot ${slot} diverges across paired original scenarios`);
      }
    }
    const runIds = Object.fromEntries(group.map((run) =>
      [run.condition, run.config.runId])) as Record<Condition, string>;
    const rates = Object.fromEntries(group.map((run, index) =>
      [run.condition, rows[index]!.agreements! / 200])) as Record<Condition, number>;
    return { primarySlot: slot, sourceSlot: slot,
      use: slot <= 25 ? 'primary' : 'reserve',
      scenarioStateHashes: reference, runIds, rates };
  };
  const validButExcludedRunIds: string[] = [];
  const invalidPrimarySlots: number[] = [];
  const validPrimary = new Map<number, E03FullIncludedPair>();
  for (let slot = 1; slot <= 25; slot += 1) {
    const pair = paired(slot);
    if (pair) validPrimary.set(slot, pair);
    else {
      invalidPrimarySlots.push(slot);
      for (const run of bySlot.get(slot)!) {
        if (observed.get(run.config.runId)!.valid) validButExcludedRunIds.push(run.config.runId);
      }
    }
  }
  const invalidReserveSlots: number[] = [];
  const validReserve: E03FullIncludedPair[] = [];
  const unattemptedReserveRunIds: string[] = [];
  let reserveGap = false;
  for (let slot = 26; slot <= 28; slot += 1) {
    const group = bySlot.get(slot)!;
    const count = group.filter((run) => observed.has(run.config.runId)).length;
    if (count === 0) {
      reserveGap = true;
      unattemptedReserveRunIds.push(...group.map((run) => run.config.runId));
      continue;
    }
    if (count !== 6 || reserveGap || validReserve.length >= invalidPrimarySlots.length) {
      fail(`E03 full reserve slot ${slot} was partial, out of order, or unneeded`);
    }
    const pair = paired(slot);
    if (pair) validReserve.push(pair);
    else {
      invalidReserveSlots.push(slot);
      for (const run of group) {
        if (observed.get(run.config.runId)!.valid) validButExcludedRunIds.push(run.config.runId);
      }
    }
  }
  if (validReserve.length > invalidPrimarySlots.length) {
    fail('E03 full collection attempted more successful reserves than invalid primary pairs');
  }
  const replacements = validReserve.map((pair, index) => ({
    primarySlot: invalidPrimarySlots[index]!, reserveSlot: pair.sourceSlot,
  }));
  const replacementByPrimary = new Map(replacements.map((entry, index) =>
    [entry.primarySlot, validReserve[index]!]));
  const includedPairs: E03FullIncludedPair[] = [];
  for (let slot = 1; slot <= 25; slot += 1) {
    const primary = validPrimary.get(slot);
    if (primary) includedPairs.push(primary);
    else {
      const reserve = replacementByPrimary.get(slot);
      if (reserve) includedPairs.push({ ...reserve, primarySlot: slot });
    }
  }
  return {
    status: includedPairs.length === 25 ? 'complete' : 'incomplete',
    plannedRuns: 168, attemptedRuns: observed.size, primaryAttempts: 150,
    reserveAttempts: observed.size - 150, includedPairs, invalidPrimarySlots,
    invalidReserveSlots, replacements, validButExcludedRunIds,
    unattemptedReserveRunIds,
  };
}
