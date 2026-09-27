/** LV01 ledger-intervention batches: selection, fixed derangement, slices. */
import { indexLv01TrainingLedger } from '@ald/learners';
import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  buildLedgerTreatmentBatch,
  deriveLv01DerangementSeed,
  ledgerShuffledDerangement,
  sliceLedgerTreatment,
  verifyLedgerTreatmentSlice,
} from '../../src/experiments/lv01-ledger-treatments.js';

const inventory = fixedTokenInventory(32);
const candidates = [1, 4, 9, 14];

function weightsFor(type: number, strength: number): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  array[type] = strength;
  return array;
}

function record(sequence: number, token: string, weights: readonly number[], role: 'baby-a' | 'baby-b' = 'baby-a') {
  return {
    receiverRole: role,
    eventType: 'hypothesis.created' as const,
    sequence,
    turn: sequence,
    eventHash: `sha256:${'a'.repeat(63)}${sequence}`,
    policyContextHash: `sha256:${'b'.repeat(63)}${sequence}`,
    authenticated: true,
    token,
    associationOverTypeCodes: weights,
  };
}

const tokenA = inventory[3] as string;
const tokenB = inventory[11] as string;
const indexA = indexLv01TrainingLedger(
  [record(1, tokenA, weightsFor(1, 9)), record(2, tokenB, weightsFor(4, 9))],
  'baby-a',
  { sequence: 2, turn: 2 },
);
// Deliberately swapped strengths: proves each role scores on its own index.
const indexB = indexLv01TrainingLedger(
  [record(1, tokenA, weightsFor(4, 9), 'baby-b'), record(2, tokenB, weightsFor(1, 9), 'baby-b')],
  'baby-b',
  { sequence: 2, turn: 2 },
);
const nativeIndexes = { babyA: indexA, babyB: indexB };

describe('LV01 ledger-treatment batches', () => {
  it('selects target-maximizing tokens and deranges within role', () => {
    const batch = buildLedgerTreatmentBatch({
      cases: [
        { caseId: 'a1', receiverRole: 'baby-a', targetTypeCode: 1, candidateTypeCodes: candidates },
        { caseId: 'a2', receiverRole: 'baby-a', targetTypeCode: 4, candidateTypeCodes: candidates },
        { caseId: 'b1', receiverRole: 'baby-b', targetTypeCode: 1, candidateTypeCodes: candidates },
        { caseId: 'b2', receiverRole: 'baby-b', targetTypeCode: 4, candidateTypeCodes: candidates },
      ],
      nativeIndexes,
      symbolInventory: [...inventory],
      derangementSeed: 'seed-1',
    });
    // baby-b selections come from the swapped baby-b index: role separation.
    expect(batch.cases.map((entry) => entry.selectedToken)).toEqual([tokenA, tokenB, tokenB, tokenA]);
    for (const entry of batch.cases) {
      expect(entry.shuffledSourceCaseId).not.toBe(entry.caseId);
      const source = batch.cases.find((other) => other.caseId === entry.shuffledSourceCaseId);
      expect(source?.receiverRole).toBe(entry.receiverRole);
      expect(entry.shuffledDeliveredToken).toBe(source?.selectedToken);
    }
    expect(batch.batchCommitment).toMatch(/^sha256:/u);
    const rebuilt = buildLedgerTreatmentBatch({
      cases: batch.cases.map((entry) => ({
        caseId: entry.caseId,
        receiverRole: entry.receiverRole,
        targetTypeCode: entry.targetTypeCode,
        candidateTypeCodes: entry.candidateTypeCodes,
      })),
      nativeIndexes,
      symbolInventory: [...inventory],
      derangementSeed: 'seed-1',
    });
    expect(rebuilt.batchCommitment).toBe(batch.batchCommitment);
  });

  it('preserves identical-token coincidences without re-drawing', () => {
    const batch = buildLedgerTreatmentBatch({
      cases: [
        { caseId: 'a1', receiverRole: 'baby-a', targetTypeCode: 1, candidateTypeCodes: candidates },
        { caseId: 'a2', receiverRole: 'baby-a', targetTypeCode: 1, candidateTypeCodes: candidates },
      ],
      nativeIndexes,
      symbolInventory: [...inventory],
      derangementSeed: 'seed-2',
    });
    expect(batch.cases.map((entry) => entry.selectedToken)).toEqual([tokenA, tokenA]);
    expect(batch.cases.every((entry) => entry.identicalTokenCoincidence)).toBe(true);
    expect(batch.cases.map((entry) => entry.shuffledDeliveredToken)).toEqual([tokenA, tokenA]);
    expect(batch.cases[0]?.shuffledSourceCaseId).toBe('a2');
  });

  it('fails closed on a single-case role', () => {
    expect(() => ledgerShuffledDerangement(1, 'seed')).toThrow(/at least two/u);
    expect(() => buildLedgerTreatmentBatch({
      cases: [
        { caseId: 'a1', receiverRole: 'baby-a', targetTypeCode: 1, candidateTypeCodes: candidates },
      ],
      nativeIndexes,
      symbolInventory: [...inventory],
      derangementSeed: 'seed',
    })).toThrow(/at least two/u);
  });

  it('derives registered-form batch seeds deterministically', () => {
    const parts = {
      root: 'ald-ledger-value-v2',
      studyId: 'LV01',
      stage: 'pilot',
      policyVersion: 'v2',
      slotKind: 'primary' as const,
      slotIndex: '0001',
      partition: 'within-support',
    };
    const first = deriveLv01DerangementSeed(parts);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveLv01DerangementSeed(parts)).toBe(first);
    expect(deriveLv01DerangementSeed({ ...parts, slotIndex: '0002' })).not.toBe(first);
    expect(deriveLv01DerangementSeed({ ...parts, partition: 'dev' })).not.toBe(first);
    expect(() => deriveLv01DerangementSeed({ ...parts, stage: '' })).toThrow(/empty/u);
  });

  it('slices per branch and rejects substituted tokens', () => {
    const batch = buildLedgerTreatmentBatch({
      cases: [
        { caseId: 'a1', receiverRole: 'baby-a', targetTypeCode: 1, candidateTypeCodes: candidates },
        { caseId: 'a2', receiverRole: 'baby-a', targetTypeCode: 4, candidateTypeCodes: candidates },
      ],
      nativeIndexes,
      symbolInventory: [...inventory],
      derangementSeed: 'seed-3',
    });
    const consistent = sliceLedgerTreatment(batch, 'a1', 'ledger-consistent');
    expect(consistent).toMatchObject({
      selectedToken: tokenA, deliveredToken: tokenA, sourceCaseId: 'a1',
    });
    const shuffled = sliceLedgerTreatment(batch, 'a1', 'ledger-shuffled');
    expect(shuffled.sourceCaseId).toBe('a2');
    expect(shuffled.deliveredToken).toBe(tokenB);
    expect(() => verifyLedgerTreatmentSlice(batch, 'a1', 'ledger-shuffled', shuffled)).not.toThrow();
    expect(() => verifyLedgerTreatmentSlice(batch, 'a1', 'ledger-shuffled', {
      ...shuffled, deliveredToken: tokenA,
    })).toThrow(/does not match/u);
    expect(() => sliceLedgerTreatment(batch, 'missing', 'ledger-consistent')).toThrow(/no case/u);
    expect(() => sliceLedgerTreatment(batch, 'a1', 'normal')).toThrow(/no ledger treatment/u);
  });
});
