/**
 * Shared fixtures for the LV01 stage collector suites.
 *
 * Split out of lv01-collector.test.ts (R8-W) so the pure-planning and live
 * suites run in parallel workers. Fixtures only — no tests, no mutable
 * shared state; every helper builds fresh values per call.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashCanonical, sha256Bytes } from '@ald/hashing';
import { indexLv01TrainingLedger } from '@ald/learners';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory, type LedgerEvent } from '@ald/types';

import { testConfig } from '../helpers.js';
import { buildLv01Schedule } from '../../src/experiments/lv01-schedule.js';
import {
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  type Lv01PairedPredictionProvider,
} from '../../src/experiments/lv01-paired-predictions.js';
import {
  lv01SlotSeeds,
} from '../../src/experiments/lv01-collector.js';

export const hash = (char: string): string => `sha256:${char.repeat(64)}`;
export const inventory = fixedTokenInventory(32);
export const ORDINARY: Lv01PairedPredictionProvider = {
  ordinaryId: 'uniform',
  ordinaryFit: { kind: 'uniform' },
};
export const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: hash('a'),
  analysisCommitmentHash: hash('b'),
  seedResourceCommitmentHash: hash('c'),
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

export function weightsZeroExcept(entries: Array<[number, number]>): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  for (const [index, value] of entries) array[index] = value;
  return array;
}

export function ledgerEvent(runId: string, partial: Partial<LedgerEvent> & { sequence: number }): LedgerEvent {
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

export function fixtureParent() {
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

export function fixtureIndex() {
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

export function fixtureSchedule(runSeed: string) {
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

export function fixtureSlotSeeds() {
  const seeds = lv01SlotSeeds(hash('a'), 1);
  return { scenario: seeds.scenario, babyA: seeds.babyA, babyB: seeds.babyB, gateway: seeds.gateway, analysis: seeds.analysis };
}

export function packetInput() {
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

export async function packetInputWithAllocation(dir: string) {
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
