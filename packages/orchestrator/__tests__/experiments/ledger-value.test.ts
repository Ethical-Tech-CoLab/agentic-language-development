import { describe, expect, it } from 'vitest';
import { LV01_BRANCHES, assessLv01Admission, captureLv01SlotTerminal, createLv01StageJournal, finalizeLv01Stage, transitionLv01Slot, verifyLv01PairedCase } from '../../src/experiments/ledger-value.js';
describe('LV01 paired collector gates', () => {
  it('keeps slots immutable and terminal accounting explicit', () => { let journal = createLv01StageJournal('pilot', 1, 2); journal = transitionLv01Slot(journal, 1, 'running'); journal = transitionLv01Slot(journal, 1, 'valid'); expect(() => transitionLv01Slot(journal, 1, 'running')).toThrow(/twice/u); expect(finalizeLv01Stage(journal).terminal).toBe('failed'); });
  it('blocks pilot admission until every prerequisite is evidenced', () => { expect(assessLv01Admission({ designVerified: true, numericalQualificationVerified: true, topologyQualificationVerified: false, sourceClean: true, registrationBound: false, resourcesSufficient: false, stage: 'pilot' })).toMatchObject({ status: 'blocked', reasons: ['topology-qualification-missing', 'registration-binding-missing', 'resource-allocation-missing'] }); });
  it('requires seven shared-state branches and a pre-action commitment', () => { const evidence = LV01_BRANCHES.map((branch) => ({ branch, scenarioHash: 'scenario', receiverDrawCommitment: 'draw', preStateCommitment: 'state', predictionCommitment: `prediction-${branch}`, actionRecordedAfterPrediction: true, restoredBeforeAction: true })); expect(verifyLv01PairedCase(evidence).caseCommitment).toMatch(/^sha256:/u); expect(() => verifyLv01PairedCase([...evidence.slice(0, 6), { ...evidence[6]!, scenarioHash: 'other' }])).toThrow(/share/u); });
  it('retains resources and failure diagnostics for an invalid slot', () => {
    const receipt = captureLv01SlotTerminal(createLv01StageJournal('development', 1, 1), 1, 'invalid', {
      cpuMicroseconds: 1, wallMilliseconds: 2, peakBytes: 3, evidenceBytes: 4, verificationMilliseconds: 5,
    }, 'audit', 'bundle verification failed');
    expect(receipt).toMatchObject({ slot: { status: 'invalid', reason: 'bundle verification failed' }, failureStage: 'audit' });
    expect(() => captureLv01SlotTerminal(createLv01StageJournal('development', 1, 1), 1, 'invalid', {
      cpuMicroseconds: -1, wallMilliseconds: 2, peakBytes: 3, evidenceBytes: 4, verificationMilliseconds: 5,
    }, 'audit', 'bundle verification failed')).toThrow(/resource/u);
  });
});
