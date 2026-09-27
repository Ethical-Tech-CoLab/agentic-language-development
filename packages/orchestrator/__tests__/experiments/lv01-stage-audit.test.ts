/** LV01 stage-collection audit: journal, cases, and reserve disposition. */
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  assessLv01Admission,
  createLv01StageJournal,
  finalizeLv01Stage,
  transitionLv01Slot,
} from '../../src/experiments/ledger-value.js';
import { auditLv01StageCollection } from '../../src/experiments/lv01-stage-audit.js';

const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const packet = {
  schemaVersion: 1 as const,
  studyId: 'LV01' as const,
  stage: 'pilot' as const,
  version: 2,
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
  allocation: { path: 'protocols/lv01-pilot-resource-allocation.v2.json', sha256: hash('e') },
  qualifications: {
    designCheck: 'passed' as const,
    powerCheck: 'passed' as const,
    topology: { path: 'reports/research/lv01-topology-qualification.v2.json', sha256: hash('f'), passed: true as const },
  },
  slotPlan: { primaries: 2, reserves: 1 },
  researchFinding: false as const,
  claimBoundary: 'fixture',
  packetCommitment: hash('1'),
};

function journalEvents(journal: ReturnType<typeof finalizeLv01Stage> | ReturnType<typeof createLv01StageJournal>): readonly unknown[] {
  return [
    { schemaVersion: 1, sequence: 1, recordedAt: '2026-09-27T00:00:00.000Z', journal, journalHash: hashCanonical('lv01-stage-journal/v1', journal) },
  ];
}

function settle(
  journal: ReturnType<typeof createLv01StageJournal>,
  index: number,
  status: 'valid' | 'invalid' | 'aborted',
  reason?: string,
): ReturnType<typeof createLv01StageJournal> {
  return transitionLv01Slot(transitionLv01Slot(journal, index, 'running'), index, status, reason);
}

describe('LV01 stage-collection audit', () => {
  it('requires a bound registration on every stage', () => {
    for (const stage of ['development', 'qualification', 'pilot'] as const) {
      const verdict = assessLv01Admission({
        designVerified: true,
        numericalQualificationVerified: true,
        topologyQualificationVerified: true,
        sourceClean: true,
        registrationBound: false,
        resourcesSufficient: true,
        stage,
      });
      expect(verdict).toMatchObject({ status: 'blocked', reasons: ['registration-binding-missing'] });
    }
  });

  it('verifies a terminal journal with cased slots and ordered reserves', () => {
    let journal = createLv01StageJournal('pilot', 2, 2, 1);
    journal = settle(journal, 1, 'valid');
    journal = settle(journal, 2, 'invalid', 'execution abort: worker lost');
    journal = settle(journal, 3, 'valid');
    journal = finalizeLv01Stage(journal);
    const receipt = auditLv01StageCollection({
      packet,
      journalEvents: journalEvents(journal),
      cases: [
        { slot: 1, caseCommitment: hash('2') },
        { slot: 3, caseCommitment: hash('3') },
      ],
    });
    expect(receipt.status).toBe('verified');
    expect(receipt.reasons).toEqual([]);
    expect(receipt.auditedCases).toHaveLength(2);
    expect(receipt.unusedReserves).toEqual([]);
  });

  it('blocks an open journal and accounts unused reserves', () => {
    let journal = createLv01StageJournal('pilot', 2, 1, 1);
    journal = settle(journal, 1, 'valid');
    const receipt = auditLv01StageCollection({
      packet: { ...packet, slotPlan: { primaries: 1, reserves: 1 } },
      journalEvents: journalEvents(journal),
      cases: [{ slot: 1, caseCommitment: hash('2') }],
    });
    expect(receipt.status).toBe('blocked');
    expect(receipt.reasons).toEqual(['stage journal is not terminal']);
    expect(receipt.unusedReserves).toEqual([2]);
  });

  it('throws on contradictions instead of writing a receipt', () => {
    let journal = createLv01StageJournal('pilot', 2, 1, 2);
    journal = settle(journal, 1, 'valid');
    journal = settle(journal, 3, 'valid');
    journal = finalizeLv01Stage(journal);
    // Skipped reserve 2 while consuming reserve 3.
    expect(() => auditLv01StageCollection({
      packet,
      journalEvents: journalEvents(journal),
      cases: [{ slot: 1, caseCommitment: hash('2') }, { slot: 3, caseCommitment: hash('3') }],
    })).toThrow(/registered order/u);
    // Valid slot without a case.
    const unfilled = settle(createLv01StageJournal('pilot', 2, 1, 0), 1, 'valid');
    expect(() => auditLv01StageCollection({ packet, journalEvents: journalEvents(unfilled), cases: [] }))
      .toThrow(/no audited case/u);
    // Case without a valid slot.
    const invalid = finalizeLv01Stage(settle(createLv01StageJournal('pilot', 2, 1, 0), 1, 'invalid', 'r'));
    expect(() => auditLv01StageCollection({
      packet,
      journalEvents: journalEvents(invalid),
      cases: [{ slot: 1, caseCommitment: hash('2') }],
    })).toThrow(/non-valid slot/u);
    // Tampered journal hash.
    const events = journalEvents(journal).map((entry) => ({ ...(entry as Record<string, unknown>), journalHash: hash('9') }));
    expect(() => auditLv01StageCollection({ packet, journalEvents: events, cases: [] })).toThrow(/tampered/u);
  });
});
