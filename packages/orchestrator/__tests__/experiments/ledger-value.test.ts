import { describe, expect, it } from 'vitest';
import { buildRunConfig } from '@ald/lifecycle';
import { fixedTokenInventory } from '@ald/types';
import { LV01_BRANCHES, assessLv01Admission, captureLv01SlotTerminal, createLv01PairedCasePlan, createLv01StageJournal, finalizeLv01Stage, transitionLv01Slot, verifyLv01PairedCase } from '../../src/experiments/ledger-value.js';
import { createHarness, testConfig } from '../helpers.js';
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
  it('compiles all branches as derived runs from one immutable recurrent state', () => {
    const rootSeed = `sha256:${'f'.repeat(64)}`;
    const parent = buildRunConfig({
      runId: 'lv01-parent', experimentId: 'LV01', randomSeed: rootSeed,
      seedBindings: {
        version: 1,
        scenario: rootSeed,
        babyA: `sha256:${'1'.repeat(64)}`,
        babyB: `sha256:${'2'.repeat(64)}`,
        gateway: `sha256:${'3'.repeat(64)}`,
        analysis: `sha256:${'4'.repeat(64)}`,
      },
      babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
      ledgerValuePlan: {
        version: 1,
        designCommitmentHash: `sha256:${'a'.repeat(64)}`,
        analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
        seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
        predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
        partitionContractVersion: 'lv01-within-support/v1',
      },
    });
    const slice = {
      selectedToken: 'S0',
      deliveredToken: 'S0',
      batchCommitment: `sha256:${'e'.repeat(64)}`,
      sourceCaseId: 'case-0',
    };
    const plan = createLv01PairedCasePlan({
      parent,
      parentCheckpointHash: `sha256:${'d'.repeat(64)}`,
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: 'lv01-paired-case',
      ledgerTreatments: { 'ledger-consistent': slice, 'ledger-shuffled': slice },
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
    });
    expect(plan.preStateCommitment).toMatch(/^sha256:/u);
    expect(plan.branches.map((entry) => entry.branch)).toEqual(LV01_BRANCHES);
    expect(plan.branches.map((entry) => entry.config.parentRunId)).toEqual(
      LV01_BRANCHES.map(() => parent.runId),
    );
    expect(plan.branches.every((entry) => entry.config.evaluationOnly === true)).toBe(true);
    expect(plan.branches.map((entry) => entry.config.evaluationTurns)).toEqual(
      LV01_BRANCHES.map(() => 1),
    );
    expect(plan.branches.map((entry) => entry.config.lv01PairedCase?.preStateCommitment)).toEqual(
      LV01_BRANCHES.map(() => plan.preStateCommitment),
    );
    expect(plan.branches.map((entry) => entry.config.lv01PairedCase?.branch)).toEqual(LV01_BRANCHES);
    expect(plan.branches.map((entry) => entry.config.randomSeed)).toEqual(
      LV01_BRANCHES.map(() => parent.randomSeed),
    );
    expect(plan.branches.find((entry) => entry.branch === 'ledger-consistent')?.predictionTreatment)
      .toBe('ledger-consistent');
    expect(plan.branches.find((entry) => entry.branch === 'ledger-shuffled')?.communicationCondition)
      .toBe('normal');
    const drawSeeds = plan.branches.map((entry) => entry.config.seedBindings?.actionDraw);
    expect(new Set(drawSeeds).size).toBe(1);
    expect(drawSeeds[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.branches.map((entry) => entry.config.lv01PairedCase?.actionDraw)).toEqual(
      LV01_BRANCHES.map(() => expect.objectContaining({
        stage: 'development',
        slotKind: 'primary',
        slotIndex: '0001',
        partition: 'dev',
        receiverRole: 'baby-b',
        caseId: 'lv01-paired-case:turn:0',
      })),
    );
    expect(() => createLv01PairedCasePlan({ ...{
      parent, parentCheckpointHash: `sha256:${'d'.repeat(64)}`,
      babyAInitialPolicyRef: 'bad-ref', babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: 'lv01-paired-case',
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
    } })).toThrow(/policy reference/u);
    expect(() => createLv01PairedCasePlan({
      parent: { ...parent, seedBindings: undefined },
      parentCheckpointHash: `sha256:${'d'.repeat(64)}`,
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      childRunIdPrefix: 'lv01-paired-case',
      ledgerTreatments: { 'ledger-consistent': slice, 'ledger-shuffled': slice },
      actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
    })).toThrow(/seed bindings/u);
  });
  it('leaves an LV01 commitment-to-action crash unrecoverable without a blind retry', async () => {
    let reached = false;
    const harness = await createHarness({
      lv01PredictionFor: () => ({ ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } }),
      afterLv01PairedPredictionCommitment: async () => {
        reached = true;
        throw new Error('qualification-stop-after-lv01-prediction');
      },
    });
    try {
      const faultRoot = `sha256:${'9'.repeat(64)}`;
      const parent = testConfig({
        runId: 'lv01-fault-parent', experimentId: 'LV01', randomSeed: faultRoot,
        seedBindings: {
          version: 1,
          scenario: faultRoot,
          babyA: `sha256:${'1'.repeat(64)}`,
          babyB: `sha256:${'2'.repeat(64)}`,
          gateway: `sha256:${'3'.repeat(64)}`,
          analysis: `sha256:${'4'.repeat(64)}`,
        },
        babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
        babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
        learningSignal: 'extrinsic-task', maxTurnsPerRun: 1, evaluationTurns: 1,
        ledgerValuePlan: {
          version: 1, designCommitmentHash: `sha256:${'a'.repeat(64)}`,
          analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
          seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
          predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
          partitionContractVersion: 'lv01-within-support/v1',
        },
      });
      await harness.runtime.createRun(parent);
      const checkpoint = harness.runtime.checkpoints(parent.runId).at(-1);
      const child = createLv01PairedCasePlan({
        parent, parentCheckpointHash: checkpoint?.checkpointHash ?? '',
        babyAInitialPolicyRef: 'policies/baby-a-policy-initial.json',
        babyBInitialPolicyRef: 'policies/baby-b-policy-initial.json',
        childRunIdPrefix: 'lv01-fault-child',
        actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
        ledgerTreatments: {
          'ledger-consistent': {
            selectedToken: 'S0', deliveredToken: 'S0',
            batchCommitment: `sha256:${'e'.repeat(64)}`, sourceCaseId: 'case-0',
          },
          'ledger-shuffled': {
            selectedToken: 'S0', deliveredToken: 'S0',
            batchCommitment: `sha256:${'e'.repeat(64)}`, sourceCaseId: 'case-0',
          },
        },
      }).branches[0]!.config;
      await harness.runtime.createRun(child);
      const seedToken = fixedTokenInventory(32)[2] as string;
      await harness.runtime.writerFor(child.runId).appendLedgerEvent({
        runId: child.runId,
        babyId: 'B',
        turn: 0,
        draft: {
          eventType: 'hypothesis.created',
          contentSchema: 'agent-native-ledger',
          subjectId: `symbol:${seedToken}`,
          content: {
            hypothesisRef: `hyp:${seedToken}:1`,
            termRef: `symbol:${seedToken}`,
            associationOverTypeCodes: Array.from({ length: 16 }, () => 0),
          },
          blindingNonce: 'test-nonce',
        },
      });
      await expect(harness.runtime.step(child.runId)).rejects.toThrow(
        'qualification-stop-after-lv01-prediction',
      );
      expect(reached).toBe(true);
      expect(harness.runtime.turnRecords(child.runId)).toHaveLength(0);
      expect(harness.runtime.auditLog(child.runId)
        .some((event) => event.reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed'))
        .toBe(true);
      const restarted = harness.restart();
      await expect(restarted.runtime.recover(child.runId)).rejects.toThrow(/cannot resume/u);
      restarted.close();
    } finally {
      await harness.cleanup();
    }
  });
});
