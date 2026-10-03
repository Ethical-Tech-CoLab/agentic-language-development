/**
 * LV01 ordinary wiring: collection-time provider built from a real
 * validation-window selection plus a folds-binding receipt.
 */
import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  LV01_ORDINARY_WIRING_FOLDS_DOMAIN,
  composeLv01OrdinaryProvidersFromParent,
  partitionLv01OrdinaryRowsBySchedule,
  wireLv01CollectionOrdinary,
} from '../../src/experiments/lv01-ordinary-wiring.js';
import type { Lv01OrdinaryRecord } from '@ald/analysis';
import type { Lv01BundleDocs } from '../../src/experiments/lv01-audit-loader.js';
import type { Lv01Schedule } from '../../src/experiments/lv01-schedule.js';

const inventory = fixedTokenInventory(32);

function record(caseId: string, action: number): Lv01OrdinaryRecord {
  return {
    caseId,
    receiverRole: 'baby-b',
    deliveredToken: inventory[action % inventory.length] as string,
    candidateTypeCodes: [1, 2, 3, 4],
    actualSelectedCandidateIndex: action % 4,
  };
}

function folds() {
  return {
    inventory: [...inventory],
    training: [record('train-0', 0), record('train-1', 1), record('train-2', 2), record('train-3', 3)],
    validationFit: [record('fit-0', 1), record('fit-1', 2)],
    validationSelection: [record('sel-0', 0), record('sel-1', 3)],
  };
}

describe('LV01 ordinary wiring', () => {
  it('builds a provider from the refit predictor with a folds-binding receipt', () => {
    const { provider, receipt } = wireLv01CollectionOrdinary(folds());
    expect(provider.ordinaryId).toBe(receipt.selectedPredictorId);
    expect(receipt.receiverRole).toBe('baby-b');
    expect(receipt.trainingCases).toBe(4);
    expect(receipt.validationFitCases).toBe(2);
    expect(receipt.validationSelectionCases).toBe(2);
    expect(receipt.foldsDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.keys(receipt.validationBrierByPredictor).sort()).toEqual([
      'ordinary-record-softmax', 'task-history', 'transcript-only', 'uniform', 'validation-majority',
    ]);
    for (const value of Object.values(receipt.validationBrierByPredictor)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(LV01_ORDINARY_WIRING_FOLDS_DOMAIN).toBe('lv01-ordinary-wiring-folds/v1');
  });

  it('binds folds by content, not input order', () => {
    const base = folds();
    const reordered = {
      ...base,
      training: [...base.training].reverse(),
      validationSelection: [...base.validationSelection].reverse(),
    };
    expect(wireLv01CollectionOrdinary(reordered).receipt.foldsDigest)
      .toBe(wireLv01CollectionOrdinary(base).receipt.foldsDigest);
    const moved = { ...base, validationFit: [...base.validationFit, record('sel-0', 0)] };
    expect(() => wireLv01CollectionOrdinary(moved)).toThrow(/folds must be disjoint/u);
  });

  it('fails closed on empty or mixed-role folds', () => {
    const base = folds();
    expect(() => wireLv01CollectionOrdinary({ ...base, validationSelection: [] })).toThrow(/must not be empty/u);
    const mixed = { ...base, validationFit: [{ ...record('fit-x', 0), receiverRole: 'baby-a' as const }] };
    expect(() => wireLv01CollectionOrdinary(mixed)).toThrow(/per receiver role/u);
  });

  it('partitions rows into folds by schedule membership and rejects test rows', () => {
    const scheduled = (partition: 'training' | 'validation-fit' | 'validation-selection' | 'within-support-test', caseId: string) => ({
      caseId,
      partition,
      caseIndex: 0,
      receiverRole: 'baby-b' as const,
      targetTypeCode: 1,
      candidateTypeCodes: [1, 2, 3, 4],
      candidateRefs: ['a', 'b', 'c', 'd'],
      stateHash: `sha256:${'0'.repeat(64)}`,
    });
    const schedule: Lv01Schedule = {
      counts: { training: 2, 'validation-fit': 1, 'validation-selection': 1, 'within-support-test': 1 },
      receiverRoles: ['baby-b'],
      cases: {
        training: [scheduled('training', 'train-0'), scheduled('training', 'train-1')],
        'validation-fit': [scheduled('validation-fit', 'fit-0')],
        'validation-selection': [scheduled('validation-selection', 'sel-0')],
        'within-support-test': [scheduled('within-support-test', 'test-0')],
      },
      totalCases: 5,
      commitment: `sha256:${'1'.repeat(64)}`,
    };
    const assigned = partitionLv01OrdinaryRowsBySchedule(
      [record('train-1', 1), record('sel-0', 0), record('fit-0', 2), record('train-0', 0)],
      schedule,
    );
    expect(assigned.training.map((row) => row.caseId).sort()).toEqual(['train-0', 'train-1']);
    expect(assigned.validationFit.map((row) => row.caseId)).toEqual(['fit-0']);
    expect(assigned.validationSelection.map((row) => row.caseId)).toEqual(['sel-0']);
    expect(() => partitionLv01OrdinaryRowsBySchedule([record('test-0', 0)], schedule))
      .toThrow(/outside the training\/validation schedule/u);
    expect(() => partitionLv01OrdinaryRowsBySchedule([record('train-0', 0), record('train-0', 1)], schedule))
      .toThrow(/rows list case train-0 twice/u);
    expect(() => partitionLv01OrdinaryRowsBySchedule([record('ghost-0', 0)], schedule))
      .toThrow(/outside the training\/validation schedule/u);
  });
});

const CHASH = (char: string): string => `sha256:${char.repeat(64)}`;
const CAT = '2026-10-01T00:00:00.000Z';

function cturn(seq: number, turnNo: number, state: string, receiver: 'baby-a' | 'baby-b', selectedRef: string): Record<string, unknown> {
  return {
    version: 1,
    runId: 'lv01-compose-parent',
    sequence: seq,
    turn: turnNo,
    phase: 'running',
    roles: { sender: receiver === 'baby-a' ? 'baby-b' : 'baby-a', receiver },
    communicationCondition: 'normal',
    scenarioRef: `scenario-${turnNo}`,
    scenarioStateHash: state,
    observationHashes: { babyA: CHASH('b'), babyB: CHASH('c') },
    babyProposalHash: null,
    deliveredArtifactHash: CHASH('d'),
    channelEventHash: null,
    actionHash: CHASH('e'),
    outcomeHash: CHASH('f'),
    outcome: { details: { selectedRef } },
    previousEntryHash: CHASH('0'),
    recordedAt: CAT,
    writerKeyId: 'writer-1',
    entryHash: CHASH('1'),
    writerSignature: 'ed25519:QUJDREVGR0g=',
  };
}

function cintention(seq: number, turnNo: number, babyId: 'A' | 'B', token: string, selection: string): Record<string, unknown> {
  return {
    version: 1,
    runId: 'lv01-compose-parent',
    babyId,
    sequence: seq,
    turn: turnNo,
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: `subject-${turnNo}`,
    content: { symbols: [token], selection },
    blindingNonce: `nonce-${turnNo}`,
    previousEntryHash: CHASH('0'),
    recordedAt: CAT,
    writerKeyId: 'writer-1',
    entryHash: CHASH('2'),
    writerSignature: 'writer-signature-0001',
  };
}

type Fold = 'training' | 'validation-fit' | 'validation-selection';

function cschedule(cases: readonly { partition: Fold; role: 'baby-a' | 'baby-b'; state: string }[]): Lv01Schedule {
  const empty = { training: [] as unknown[], 'validation-fit': [] as unknown[], 'validation-selection': [] as unknown[], 'within-support-test': [] as unknown[] };
  const built = {
    training: [...empty.training],
    'validation-fit': [...empty['validation-fit']],
    'validation-selection': [...empty['validation-selection']],
    'within-support-test': [...empty['within-support-test']],
  };
  for (const entry of cases) {
    built[entry.partition].push({
      caseId: `${entry.partition}:${entry.role}:${entry.state.slice(-4)}`,
      partition: entry.partition,
      caseIndex: built[entry.partition].length,
      receiverRole: entry.role,
      targetTypeCode: 1,
      candidateTypeCodes: [1, 2, 3, 4],
      candidateRefs: ['ref-a', 'ref-b', 'ref-c', 'ref-d'],
      stateHash: entry.state,
    });
  }
  return {
    counts: { training: 9, 'validation-fit': 9, 'validation-selection': 9, 'within-support-test': 0 },
    receiverRoles: ['baby-a', 'baby-b'],
    cases: built as Lv01Schedule['cases'],
    totalCases: cases.length,
    commitment: CHASH('c'),
  };
}

function cdocs(turns: readonly Record<string, unknown>[], ledgerA: readonly Record<string, unknown>[], ledgerB: readonly Record<string, unknown>[]): Lv01BundleDocs {
  return { runManifest: {}, runConfig: {}, interventions: [], turns, ledgerA, ledgerB, policies: {}, checkpoints: [] };
}

function episode(role: 'baby-a' | 'baby-b', turnNo: number, state: string, token: string, selection: string) {
  const babyId = role === 'baby-a' ? 'A' as const : 'B' as const;
  return {
    turn: cturn(turnNo + 1, turnNo, state, role, selection),
    intention: cintention(turnNo + 1, turnNo, babyId, token, selection),
  };
}

describe('LV01 ordinary parent composition', () => {
  it('composes one provider per role from parent evidence', () => {
    const folds: Fold[] = ['training', 'validation-fit', 'validation-selection'];
    const states = ['a', 'b', 'c', 'd', 'e', 'f'].map((char) => `${char}0`.padEnd(64, '0')).map((hex) => `sha256:${hex}`);
    const tokens = [inventory[0] as string, inventory[1] as string, inventory[2] as string];
    const selections = ['ref-a', 'ref-b', 'ref-c'];
    const turns: Record<string, unknown>[] = [];
    const ledgerA: Record<string, unknown>[] = [];
    const ledgerB: Record<string, unknown>[] = [];
    const cases: { partition: Fold; role: 'baby-a' | 'baby-b'; state: string }[] = [];
    let turnNo = 0;
    for (const role of ['baby-a', 'baby-b'] as const) {
      folds.forEach((partition, index) => {
        const state = states[(role === 'baby-a' ? 0 : 3) + index] as string;
        const built = episode(role, turnNo, state, tokens[index] as string, selections[index] as string);
        turns.push(built.turn);
        (role === 'baby-a' ? ledgerA : ledgerB).push(built.intention);
        cases.push({ partition, role, state });
        turnNo += 1;
      });
    }
    const composed = composeLv01OrdinaryProvidersFromParent({
      parentDocs: cdocs(turns, ledgerA, ledgerB),
      schedule: cschedule(cases),
      inventory: [...inventory],
    });
    expect(composed.extractedCases).toBe(6);
    for (const role of ['baby-a', 'baby-b'] as const) {
      const entry = composed.byRole[role];
      expect(entry).toBeDefined();
      expect(entry!.receipt.receiverRole).toBe(role);
      expect(entry!.receipt.trainingCases).toBe(1);
      expect(entry!.receipt.validationFitCases).toBe(1);
      expect(entry!.receipt.validationSelectionCases).toBe(1);
      expect(entry!.provider.ordinaryId).toBe(entry!.receipt.selectedPredictorId);
      expect(entry!.receipt.foldsDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it('omits roles with no extracted rows', () => {
    const folds: Fold[] = ['training', 'validation-fit', 'validation-selection'];
    const turns: Record<string, unknown>[] = [];
    const intentions: Record<string, unknown>[] = [];
    const cases: { partition: Fold; role: 'baby-a' | 'baby-b'; state: string }[] = [];
    folds.forEach((partition, index) => {
      const state = `sha256:${`${index}a`.padEnd(64, '0')}`;
      const built = episode('baby-b', index, state, inventory[index] as string, 'ref-a');
      turns.push(built.turn);
      intentions.push(built.intention);
      cases.push({ partition, role: 'baby-b', state });
    });
    const composed = composeLv01OrdinaryProvidersFromParent({
      parentDocs: cdocs(turns, [], intentions),
      schedule: cschedule(cases),
      inventory: [...inventory],
    });
    expect(composed.extractedCases).toBe(3);
    expect(composed.byRole['baby-a']).toBeUndefined();
    expect(composed.byRole['baby-b']!.receipt.receiverRole).toBe('baby-b');
  });

  it('propagates fail-closed when a role leaves a fold empty', () => {
    const stateA = `sha256:${'a0'.padEnd(64, '0')}`;
    const stateB = `sha256:${'b0'.padEnd(64, '0')}`;
    const first = episode('baby-b', 0, stateA, inventory[0] as string, 'ref-a');
    const second = episode('baby-b', 1, stateB, inventory[1] as string, 'ref-b');
    expect(() => composeLv01OrdinaryProvidersFromParent({
      parentDocs: cdocs([first.turn, second.turn], [], [first.intention, second.intention]),
      schedule: cschedule([
        { partition: 'training', role: 'baby-b', state: stateA },
        { partition: 'validation-fit', role: 'baby-b', state: stateB },
      ]),
      inventory: [...inventory],
    })).toThrow(/must not be empty/u);
  });
});
