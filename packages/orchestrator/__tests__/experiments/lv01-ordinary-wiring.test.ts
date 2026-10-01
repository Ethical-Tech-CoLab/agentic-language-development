/**
 * LV01 ordinary wiring: collection-time provider built from a real
 * validation-window selection plus a folds-binding receipt.
 */
import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  LV01_ORDINARY_WIRING_FOLDS_DOMAIN,
  wireLv01CollectionOrdinary,
} from '../../src/experiments/lv01-ordinary-wiring.js';
import type { Lv01OrdinaryRecord } from '@ald/analysis';

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
});
