/**
 * LV01 ordinary loader: parent evidence joined to the schedule per HANDYM's
 * row-extraction mapping v1 (Q1-Q5), fail-closed throughout.
 */
import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import type { Lv01BundleDocs } from '../../src/experiments/lv01-audit-loader.js';
import { extractLv01OrdinaryRecords } from '../../src/experiments/lv01-ordinary-loader.js';
import { partitionLv01OrdinaryRowsBySchedule } from '../../src/experiments/lv01-ordinary-wiring.js';
import type { Lv01Schedule } from '../../src/experiments/lv01-schedule.js';

const inventory = fixedTokenInventory(32);
const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const AT = '2026-10-01T00:00:00.000Z';

function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: 'lv01-loader-parent',
    sequence: 1,
    turn: 0,
    phase: 'running',
    roles: { sender: 'baby-a', receiver: 'baby-b' },
    communicationCondition: 'normal',
    scenarioRef: 'scenario-0',
    scenarioStateHash: hash('a'),
    observationHashes: { babyA: hash('b'), babyB: hash('c') },
    babyProposalHash: null,
    deliveredArtifactHash: hash('d'),
    channelEventHash: null,
    actionHash: hash('e'),
    outcomeHash: hash('f'),
    outcome: { details: { selectedRef: 'ref-b' } },
    previousEntryHash: hash('0'),
    recordedAt: AT,
    writerKeyId: 'writer-1',
    entryHash: hash('1'),
    writerSignature: 'ed25519:QUJDREVGR0g=',
    ...overrides,
  };
}

function intention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: 'lv01-loader-parent',
    babyId: 'B',
    sequence: 1,
    turn: 0,
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: 'subject-0',
    content: { symbols: [inventory[3]], selection: 'ref-b' },
    blindingNonce: 'nonce-0',
    previousEntryHash: hash('0'),
    recordedAt: AT,
    writerKeyId: 'writer-1',
    entryHash: hash('2'),
    writerSignature: 'writer-signature-0001',
    ...overrides,
  };
}

function scheduledCase(partition: 'training' | 'validation-fit', caseId: string, state: string, role: 'baby-a' | 'baby-b') {
  return {
    caseId,
    partition,
    caseIndex: 0,
    receiverRole: role,
    targetTypeCode: 1,
    candidateTypeCodes: [1, 2, 3, 4],
    candidateRefs: ['ref-a', 'ref-b', 'ref-c', 'ref-d'],
    stateHash: state,
  };
}

function schedule(): Lv01Schedule {
  return {
    counts: { training: 1, 'validation-fit': 1, 'validation-selection': 0, 'within-support-test': 0 },
    receiverRoles: ['baby-a', 'baby-b'],
    cases: {
      training: [scheduledCase('training', 'training:baby-b:0000', hash('a'), 'baby-b')],
      'validation-fit': [scheduledCase('validation-fit', 'validation-fit:baby-a:0000', hash('9'), 'baby-a')],
      'validation-selection': [],
      'within-support-test': [],
    },
    totalCases: 2,
    commitment: hash('c'),
  };
}

function docs(overrides: Partial<Lv01BundleDocs> = {}): Lv01BundleDocs {
  return {
    runManifest: {},
    runConfig: {},
    interventions: [],
    turns: [
      turn({ sequence: 1, turn: 0, scenarioStateHash: hash('a') }),
      turn({ sequence: 2, turn: 1, scenarioStateHash: hash('9'), roles: { sender: 'baby-b', receiver: 'baby-a' } }),
    ],
    ledgerA: [intention({ babyId: 'A', sequence: 1, turn: 1, content: { symbols: [], selection: 'ref-c' } })],
    ledgerB: [intention({ sequence: 2, turn: 0 })],
    policies: {},
    checkpoints: [],
    ...overrides,
  };
}

function withOutcomeSelection(selection: string): Lv01BundleDocs {
  const base = docs();
  return {
    ...base,
    turns: [
      turn({ sequence: 1, turn: 0, scenarioStateHash: hash('a'), outcome: { details: { selectedRef: selection } } }),
      turn({ sequence: 2, turn: 1, scenarioStateHash: hash('9'), roles: { sender: 'baby-b', receiver: 'baby-a' }, outcome: { details: { selectedRef: 'ref-c' } } }),
    ],
  };
}

describe('LV01 ordinary loader', () => {
  it('extracts one record per executed scheduled case with joined schedule fields', () => {
    const records = extractLv01OrdinaryRecords({ parentDocs: withOutcomeSelection('ref-b'), schedule: schedule(), inventory: [...inventory] });
    expect(records).toEqual([
      {
        caseId: 'training:baby-b:0000',
        receiverRole: 'baby-b',
        deliveredToken: inventory[3],
        candidateTypeCodes: [1, 2, 3, 4],
        actualSelectedCandidateIndex: 1,
      },
      {
        caseId: 'validation-fit:baby-a:0000',
        receiverRole: 'baby-a',
        deliveredToken: null,
        candidateTypeCodes: [1, 2, 3, 4],
        actualSelectedCandidateIndex: 2,
      },
    ]);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([
        'actualSelectedCandidateIndex', 'candidateTypeCodes', 'caseId', 'deliveredToken', 'receiverRole',
      ]);
    }
  });

  it('partitions extracted rows into schedule folds for composition', () => {
    const records = extractLv01OrdinaryRecords({ parentDocs: withOutcomeSelection('ref-b'), schedule: schedule(), inventory: [...inventory] });
    const folds = partitionLv01OrdinaryRowsBySchedule(records, schedule());
    expect(folds.training.map((row) => row.caseId)).toEqual(['training:baby-b:0000']);
    expect(folds.validationFit.map((row) => row.caseId)).toEqual(['validation-fit:baby-a:0000']);
    expect(folds.validationSelection).toEqual([]);
  });

  it('fails closed when the outcome disagrees with the intention selection', () => {
    expect(() => extractLv01OrdinaryRecords({ parentDocs: withOutcomeSelection('ref-d'), schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/training:baby-b:0000 turn outcome disagrees with the intention selection/u);
  });

  it('fails closed on test-partition, unlisted, and twice-served episodes', () => {
    const test = docs({ turns: [turn({ scenarioStateHash: hash('e') })] });
    expect(() => extractLv01OrdinaryRecords({ parentDocs: test, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/outside the training\/validation schedule/u);
    const twice = docs({ turns: [turn({ sequence: 1, turn: 0 }), turn({ sequence: 2, turn: 1 })] });
    expect(() => extractLv01OrdinaryRecords({ parentDocs: twice, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/serves case training:baby-b:0000 twice/u);
  });

  it('fails closed on missing, duplicated, or delivery-less intention records', () => {
    const base = docs({ turns: [turn({})] });
    expect(() => extractLv01OrdinaryRecords({ parentDocs: { ...base, ledgerB: [] }, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/has 0 intention records, expected exactly one/u);
    const dupe = intention({ sequence: 9 });
    expect(() => extractLv01OrdinaryRecords({ parentDocs: { ...base, ledgerB: [intention({}), dupe] }, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/has 2 intention records, expected exactly one/u);
    const noSymbols = { ...base, ledgerB: [intention({ content: { selection: 'ref-b' } })] };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: noSymbols, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/carries no symbol delivery/u);
    const noSelection = { ...base, ledgerB: [intention({ content: { symbols: [inventory[0]] } })] };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: noSelection, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/carries no selection/u);
  });

  it('fails closed on out-of-inventory tokens and unjoinable schedule fields', () => {
    const base = docs({ turns: [turn({})] });
    const rogue = { ...base, ledgerB: [intention({ content: { symbols: ['rogue-token'], selection: 'ref-b' } })] };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: rogue, schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/outside the frozen inventory/u);
    const badCodes = schedule();
    const broken = {
      ...badCodes,
      cases: {
        ...badCodes.cases,
        training: [{ ...badCodes.cases.training[0]!, candidateTypeCodes: [1, 2, 3] }],
      },
    };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: base, schedule: broken, inventory: [...inventory] }))
      .toThrow(/scheduled candidate types are invalid/u);
    const badRefs = schedule();
    const stray = {
      ...badRefs,
      cases: {
        ...badRefs.cases,
        training: [{ ...badRefs.cases.training[0]!, candidateRefs: ['x', 'y', 'z', 'w'] }],
      },
    };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: base, schedule: stray, inventory: [...inventory] }))
      .toThrow(/agreed selection is absent from the scheduled candidates/u);
  });

  it('fails closed on empty bundles and non-frozen inventories', () => {
    expect(() => extractLv01OrdinaryRecords({ parentDocs: docs({ turns: [] }), schedule: schedule(), inventory: [...inventory] }))
      .toThrow(/carries no turn records/u);
    expect(() => extractLv01OrdinaryRecords({ parentDocs: docs(), schedule: schedule(), inventory: [...inventory, 'extra'] }))
      .toThrow(/requires 32 distinct inventory tokens/u);
    expect(() => extractLv01OrdinaryRecords({ parentDocs: withOutcomeSelection('ref-b'), schedule: schedule(), inventory: [...inventory.slice(1), inventory[0]] }))
      .not.toThrow();
  });

  it('fails closed when the schedule double-lists a scenario', () => {
    const doubled = schedule();
    const clash = {
      ...doubled,
      cases: {
        ...doubled.cases,
        'validation-fit': [{ ...doubled.cases['validation-fit'][0]!, stateHash: hash('a') }],
      },
    };
    expect(() => extractLv01OrdinaryRecords({ parentDocs: docs(), schedule: clash, inventory: [...inventory] }))
      .toThrow(/schedule lists scenario .* twice/u);
  });
});
