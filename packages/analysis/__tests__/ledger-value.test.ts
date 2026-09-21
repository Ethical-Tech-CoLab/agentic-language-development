import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';
import { selectLv01OrdinaryPredictor } from '../src/ledger-value.js';

const inventory = fixedTokenInventory(32);
function row(id: string, token: string | null, action: number) { return { caseId: id, receiverRole: 'baby-a' as const, deliveredToken: token, candidateTypeCodes: [1, 4, 9, 14], actualSelectedCandidateIndex: action }; }
describe('LV01 ordinary-record predictor selection', () => {
  it('fits all fixed candidates, selects only on validation rows, then refits', () => {
    const result = selectLv01OrdinaryPredictor({ inventory, training: [row('t1', 'S01', 0), row('t2', 'S02', 1)], validationFit: [row('f1', 'S01', 0), row('f2', 'S02', 1)], validationSelection: [row('s1', 'S01', 0), row('s2', 'S02', 1)] });
    expect(result.candidatePredictors.map((model) => model.id)).toEqual(['uniform', 'validation-majority', 'transcript-only', 'task-history', 'ordinary-record-softmax']);
    expect(Object.keys(result.validationBrierByPredictor)).toHaveLength(5);
    const probabilities = result.refitPredictor.probabilitiesFor({ caseId: 'test', receiverRole: 'baby-a', deliveredToken: 'S01', candidateTypeCodes: [1, 4, 9, 14] });
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });
  it('refuses target/future fields and overlapping folds', () => {
    expect(() => selectLv01OrdinaryPredictor({ inventory, training: [row('same', 'S01', 0)], validationFit: [row('f', 'S01', 0)], validationSelection: [row('same', 'S01', 0)] })).toThrow(/disjoint/u);
    const poisoned = { ...row('t', 'S01', 0), trueTargetTypeCode: 14 };
    expect(() => selectLv01OrdinaryPredictor({ inventory, training: [poisoned as unknown as ReturnType<typeof row>], validationFit: [row('f', 'S01', 0)], validationSelection: [row('s', 'S01', 0)] })).toThrow(/forbidden/u);
  });
});
