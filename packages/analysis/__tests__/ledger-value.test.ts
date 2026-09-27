import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';
import { analyzeLv01Family, scoreLv01OrdinaryFit, scoreLv01Prediction, selectLv01OrdinaryPredictor, verifyLv01OrdinaryTranscriptMatch } from '../src/ledger-value.js';

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
describe('LV01 scoring and family reduction', () => {
  it('separates actual-action Brier labels from task-target intervention labels', () => {
    expect(scoreLv01Prediction({ candidateTypeCodes: [1, 4, 9, 14], nativeDistribution: [0.1, 0.2, 0.3, 0.4], replayDistribution: [0.4, 0.3, 0.2, 0.1], label: { actualSelectedCandidateIndex: 3, taskTargetCandidateIndex: 0 } })).toMatchObject({ nativeBrier: 0.5, replayBrier: 1.1, replayTargetActionProbability: 0.4 });
  });
  it('uses equal role means and completes valid nulls without calling them crashes', () => {
    const values = Array.from({ length: 3 }, (_, index) => ({ seedId: `seed-${index}`, byRole: { 'baby-a': { incremental: [0], fidelity: [-0.03 + index * 0.001], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] }, 'baby-b': { incremental: [0], fidelity: [-0.03 + index * 0.001], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] } } }));
    const result = analyzeLv01Family(values);
    expect(result.dispositions).toEqual({ 'LV-U': 'inconclusive', 'LV-P': 'not-supported', 'LV-C': 'inconclusive', 'LV-L': 'inconclusive' });
    expect(result.componentIntervals.incremental.degenerate).toBe(true);
    expect(result.componentIntervals.fidelity.degenerate).toBe(false);
  });
  it('supports LV-U on incremental gains while degenerate members stay inconclusive', () => {
    const values = Array.from({ length: 4 }, (_, index) => ({ seedId: `seed-${index}`, byRole: { 'baby-a': { incremental: [0.1 + index * 0.001], fidelity: [0], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] }, 'baby-b': { incremental: [0.1 + index * 0.001], fidelity: [0], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] } } }));
    const result = analyzeLv01Family(values);
    expect(result.dispositions['LV-U']).toBe('supported');
    expect(result.dispositions['LV-P']).toBe('inconclusive');
    expect(result.dispositions['LV-C']).toBe('inconclusive');
    expect(result.dispositions['LV-L']).toBe('inconclusive');
    expect(result.memberPValues['LV-U']).toBeLessThan(0.05);
    const interval = result.componentIntervals.incremental;
    expect(interval.marginal95.lower).toBeLessThan(0.1);
    expect(interval.marginal95.upper).toBeGreaterThan(0.1);
    expect(interval.simultaneousLowerBound).toBeGreaterThan(0.02);
  });
});
describe('LV01 ordinary-fit transcript sanity', () => {
  it('accepts committed vectors matching the fit and rejects tampered ones', () => {
    const fit = selectLv01OrdinaryPredictor({ inventory, training: [row('t1', 'S01', 0), row('t2', 'S02', 1)], validationFit: [row('f1', 'S01', 0), row('f2', 'S02', 1)], validationSelection: [row('s1', 'S01', 0), row('s2', 'S02', 1)] });
    const refit = fit.refitPredictor;
    const unsigned = (id: string, token: string) => ({ caseId: id, receiverRole: 'baby-a' as const, deliveredToken: token, candidateTypeCodes: [1, 4, 9, 14] });
    const records = [unsigned('t1', 'S01'), unsigned('t2', 'S02')].map((record) => ({ ...record, committedDistribution: scoreLv01OrdinaryFit(refit.id, refit.fit, record, inventory) }));
    expect(() => verifyLv01OrdinaryTranscriptMatch({ id: refit.id, fit: refit.fit, inventory, records })).not.toThrow();
    const tampered = records.map((record, index) => index === 0 ? { ...record, committedDistribution: [record.committedDistribution[0]! + 0.5, ...record.committedDistribution.slice(1)] } : record);
    expect(() => verifyLv01OrdinaryTranscriptMatch({ id: refit.id, fit: refit.fit, inventory, records: tampered })).toThrow(/ordinary transcript mismatch on case t1/u);
    expect(() => verifyLv01OrdinaryTranscriptMatch({ id: refit.id, fit: refit.fit, inventory, records: [] })).toThrow(/at least one record/u);
  });
});
