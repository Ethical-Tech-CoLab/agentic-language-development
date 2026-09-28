/**
 * LV01 independent auditor: reconstruction from raw records, forgery rejection.
 *
 * Every fixture runs the real production builders (plan, ledger mapping,
 * payload, draw commitment, treatment batch); the auditor re-derives from
 * the raw records. No collector boolean appears in the auditor's inputs.
 */
import { analyzeLv01Family, selectLv01OrdinaryPredictor } from '@ald/analysis';
import { drawIndexFromUnit, hashCanonical } from '@ald/hashing';
import {
  RecurrentCommunicationModel,
  indexLv01TrainingLedger,
  predictLv01NativeLedger,
  selectLedgerConsistentToken,
} from '@ald/learners';
import { fixedTokenInventory, type LedgerEvent } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../helpers.js';
import {
  auditLv01PairedCase,
  type Lv01AuditSharedInput,
  type Lv01AuditedBranch,
} from '../../src/experiments/lv01-auditor.js';
import { commitLv01ActionDraw, deriveLv01ActionDrawSeed } from '../../src/experiments/lv01-action-draw.js';
import {
  LV01_BRANCHES,
  createLv01PairedCasePlan,
  type Lv01Branch,
  type Lv01PairedCasePlan,
} from '../../src/experiments/ledger-value.js';
import {
  buildLedgerTreatmentBatch,
  sliceLedgerTreatment,
  type Lv01LedgerTreatmentBatch,
} from '../../src/experiments/lv01-ledger-treatments.js';
import {
  buildLv01PairedPredictionPayload,
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
} from '../../src/experiments/lv01-paired-predictions.js';

const inventory = fixedTokenInventory(32);
const candidates = [1, 4, 9, 14];
const refs = ['ref-a', 'ref-b', 'ref-c', 'ref-d'];
const PARENT_RUN_ID = 'lv01-audit-parent';
const PREFIX = 'lv01-audit-pair';
const ROOT_SEED = `sha256:${'e'.repeat(64)}`;
const CHECKPOINT = `sha256:${'c'.repeat(64)}`;
const SCENARIO = `sha256:${'f'.repeat(64)}`;
const POLICY = `sha256:${'a'.repeat(64)}`;
const SCHEDULE = `sha256:${'b'.repeat(64)}`;
const SLOT_SEEDS = {
  scenario: `sha256:${'d'.repeat(64)}`,
  babyA: `sha256:${'5'.repeat(64)}`,
  babyB: `sha256:${'6'.repeat(64)}`,
  gateway: `sha256:${'7'.repeat(64)}`,
  analysis: `sha256:${'8'.repeat(64)}`,
};
const SCOPE = {
  stage: 'development' as const,
  slotKind: 'primary' as const,
  slotIndex: '0007',
  partition: 'dev' as const,
  receiverRole: 'baby-b' as const,
  caseId: `${PREFIX}:turn:0`,
};
/** Hand-calculated association weights: type 1 -> 3, type 4 -> 1, rest 0. */
function weights(): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  array[1] = 3;
  array[4] = 1;
  return array;
}
function weights2(): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  array[9] = 2;
  array[14] = 2;
  return array;
}

function ledgerEvent(runId: string, stream: 'babyA' | 'babyB', partial: Partial<LedgerEvent> & { sequence: number }): LedgerEvent {
  return {
    version: 1,
    runId,
    babyId: stream === 'babyA' ? 'A' : 'B',
    turn: 0,
    eventType: 'hypothesis.created',
    contentSchema: 'agent-native-ledger',
    subjectId: 'symbol:S01',
    content: { termRef: 'symbol:S01', associationOverTypeCodes: weights() },
    blindingNonce: 'nonce',
    previousEntryHash: `sha256:${'0'.repeat(64)}`,
    recordedAt: '2026-09-27T00:00:00.000Z',
    writerKeyId: 'test-key',
    entryHash: hashCanonical('audit-fixture-entry/v1', `${runId}:${stream}:${partial.sequence}`),
    writerSignature: 'sig',
    ...partial,
  } as LedgerEvent;
}

function frozenModel(): unknown {
  const model = new RecurrentCommunicationModel('lv01-audit-fixture', {
    typeCount: 16,
    symbolCount: 32,
    messageLength: 1,
    hiddenSize: 16,
  });
  model.updatePredictive([{ featureCode: 1, messageSymbolIndices: [2] }]);
  return model.export();
}

function ordinarySelection() {
  const row = (caseId: string, action: number) => ({
    caseId,
    receiverRole: 'baby-b' as const,
    deliveredToken: 'S01',
    candidateTypeCodes: candidates,
    actualSelectedCandidateIndex: action,
  });
  const selection = selectLv01OrdinaryPredictor({
    inventory: [...inventory],
    training: [row('t-1', 0), row('t-2', 1)],
    validationFit: [row('f-1', 0), row('f-2', 0)],
    validationSelection: [row('s-1', 0), row('s-2', 1)],
  });
  return { ordinaryId: selection.refitPredictor.id, ordinaryFit: selection.refitPredictor.fit };
}

const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: `sha256:${'a'.repeat(64)}`,
  analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
  seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

interface ValidCase {
  plan: Lv01PairedCasePlan;
  shared: Lv01AuditSharedInput;
  branches: Lv01AuditedBranch[];
  batch: Lv01LedgerTreatmentBatch;
}

function validCase(): ValidCase {
  const parent = testConfig({
    runId: PARENT_RUN_ID,
    experimentId: 'LV01',
    randomSeed: ROOT_SEED,
    seedBindings: {
      version: 1,
      scenario: ROOT_SEED,
      babyA: `sha256:${'1'.repeat(64)}`,
      babyB: `sha256:${'2'.repeat(64)}`,
      gateway: `sha256:${'3'.repeat(64)}`,
      analysis: `sha256:${'4'.repeat(64)}`,
    },
    babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 4,
    evaluationTurns: 1,
    ledgerValuePlan: LEDGER_VALUE_PLAN,
  });
  const caseIdFor = (branch: Lv01Branch): string => `${PREFIX}-${branch}:turn:0`;
  // Treatment batch first: the plan commits its slices and branches deliver them.
  const batchRecords = mapLv01LedgerAssociations(
    [
      ledgerEvent('batch-index', 'babyB', { sequence: 1, turn: 0 }),
      ledgerEvent('batch-index', 'babyB', {
        sequence: 2,
        turn: 1,
        eventType: 'hypothesis.revised',
        subjectId: 'symbol:S02',
        content: { termRef: 'symbol:S02', associationOverTypeCodes: weights2() },
      }),
    ],
    'baby-b',
    () => true,
  );
  const batchCutoff = deriveLv01LedgerCutoff(batchRecords);
  const batchIndex = indexLv01TrainingLedger(batchRecords, 'baby-b', batchCutoff);
  const batchRecordsA = mapLv01LedgerAssociations(
    [
      ledgerEvent('batch-index', 'babyA', { sequence: 1, turn: 0 }),
      ledgerEvent('batch-index', 'babyA', {
        sequence: 2,
        turn: 1,
        eventType: 'hypothesis.revised',
        subjectId: 'symbol:S02',
        content: { termRef: 'symbol:S02', associationOverTypeCodes: weights2() },
      }),
    ],
    'baby-a',
    () => true,
  );
  const batchCutoffA = deriveLv01LedgerCutoff(batchRecordsA);
  const batchIndexA = indexLv01TrainingLedger(batchRecordsA, 'baby-a', batchCutoffA);
  const batch = buildLedgerTreatmentBatch({
    cases: (['ledger-consistent', 'ledger-shuffled'] as const).map((branch) => ({
      caseId: caseIdFor(branch),
      receiverRole: 'baby-b' as const,
      targetTypeCode: 1,
      candidateTypeCodes: candidates,
    })),
    nativeIndexes: { babyA: batchIndexA, babyB: batchIndex },
    symbolInventory: [...inventory],
    derangementSeed: 'audit-derangement',
  });
  const plan = createLv01PairedCasePlan({
    parent,
    parentCheckpointHash: CHECKPOINT,
    babyAInitialPolicyRef: 'policies/baby-a-latest.json',
    babyBInitialPolicyRef: 'policies/baby-b-latest.json',
    childRunIdPrefix: PREFIX,
    actionDrawScope: {
      stage: SCOPE.stage,
      slotKind: SCOPE.slotKind,
      slotIndex: SCOPE.slotIndex,
      partition: SCOPE.partition,
    },
    slotSeeds: { ...SLOT_SEEDS },
    scheduledCase: { partition: 'within-support-test', caseIndex: 0, receiverRole: 'baby-b' },
    ledgerTreatments: {
      'ledger-consistent': { ...sliceLedgerTreatment(batch, caseIdFor('ledger-consistent'), 'ledger-consistent') },
      'ledger-shuffled': { ...sliceLedgerTreatment(batch, caseIdFor('ledger-shuffled'), 'ledger-shuffled') },
    },
  });
  const drawSeed = deriveLv01ActionDrawSeed(SLOT_SEEDS.scenario, SCOPE);
  const { ordinaryId, ordinaryFit } = ordinarySelection();
  const model = frozenModel();
  // One frozen parent stream pair, referenced (never copied) by every branch.
  const parentBabyB = [
    ledgerEvent(PARENT_RUN_ID, 'babyB', { sequence: 1, turn: 0 }),
    ledgerEvent(PARENT_RUN_ID, 'babyB', {
      sequence: 2,
      turn: 1,
      eventType: 'hypothesis.revised',
      subjectId: 'symbol:S02',
      content: { termRef: 'symbol:S02', associationOverTypeCodes: weights2() },
    }),
  ];
  const parentBabyA = [ledgerEvent(PARENT_RUN_ID, 'babyA', { sequence: 1, turn: 0 })];
  const parentHeads = {
    babyA: parentBabyA.map((event) => event.entryHash),
    babyB: parentBabyB.map((event) => event.entryHash),
  };
  const parentRecords = mapLv01LedgerAssociations(parentBabyB, 'baby-b', () => true);
  const parentCutoff = deriveLv01LedgerCutoff(parentRecords);
  const deliveredFor = (branch: Lv01Branch): string | null => {
    switch (branch) {
      case 'disabled': return null;
      case 'constant': return 'S02';
      case 'random': return 'S03';
      case 'shuffled': return 'S04';
      case 'ledger-consistent': return sliceLedgerTreatment(batch, caseIdFor(branch), branch).deliveredToken;
      case 'ledger-shuffled': return sliceLedgerTreatment(batch, caseIdFor(branch), branch).deliveredToken;
      default: return 'S01';
    }
  };
  const branches = LV01_BRANCHES.map((branch): Lv01AuditedBranch => {
    const runId = `${PREFIX}-${branch}`;
    const planned = plan.branches.find((entry) => entry.branch === branch)!;
    const { payload, commitment } = buildLv01PairedPredictionPayload({
      branch,
      predictionTreatment: planned.config.lv01PairedCase!.predictionTreatment,
      turn: 0,
      receiver: 'baby-b',
      caseId: `${runId}:turn:0`,
      candidateRefs: refs,
      candidateTypeCodes: candidates,
      deliveredToken: deliveredFor(branch),
      symbolInventory: [...inventory],
      ledgerRecords: parentRecords,
      cutoff: parentCutoff,
      frozenModel: model,
      ordinaryId,
      ordinaryFit,
      state: {
        scenarioStateHash: SCENARIO,
        receiverPolicyHash: POLICY,
        trainingLedgerHeads: { babyA: [...parentHeads.babyA], babyB: [...parentHeads.babyB] },
      },
      scheduleDigest: SCHEDULE,
    });
    const commit = commitLv01ActionDraw({
      drawSeed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: refs,
      preStateCommitment: plan.preStateCommitment,
    });
    // Intervened branches record (not re-derive) their sampling vector.
    const probs = planned.communicationCondition === 'normal'
      ? [...payload.replay!.distribution]
      : [0.1, 0.2, 0.3, 0.4];
    const selectedCandidateRef = refs[drawIndexFromUnit(probs, commit.u)] as string;
    const disclosure = { uBitsHex: commit.uBitsHex, probs, candidateRefs: [...refs], selectedCandidateRef };
    const entryHash = (sequence: number): string => hashCanonical('audit-fixture-transcript/v1', `${runId}:${sequence}`);
    const transcript = [
      {
        sequence: 1,
        eventType: 'learner-initialization' as const,
        entryHash: entryHash(1),
        previousEntryHash: `sha256:${'0'.repeat(64)}`,
        body: {
          parentRunId: PARENT_RUN_ID,
          derivedFromCheckpointHash: CHECKPOINT,
          babyAInitialPolicyRef: 'policies/baby-a-latest.json',
          babyBInitialPolicyRef: 'policies/baby-b-latest.json',
        },
      },
      {
        sequence: 2,
        eventType: 'prediction-commitment' as const,
        entryHash: entryHash(2),
        previousEntryHash: entryHash(1),
        body: { commitment },
      },
      {
        sequence: 3,
        eventType: 'action-draw-commitment' as const,
        entryHash: entryHash(3),
        previousEntryHash: entryHash(2),
        body: { drawCommitment: commit.drawCommitment },
      },
      {
        sequence: 4,
        eventType: 'receiver-action-recorded' as const,
        entryHash: entryHash(4),
        previousEntryHash: entryHash(3),
        body: {
          selectedCandidateRef,
          deliveredToken: deliveredFor(branch),
          candidateRefs: [...refs],
          scenarioStateHash: SCENARIO,
        },
      },
      {
        sequence: 5,
        eventType: 'action-draw-disclosed' as const,
        entryHash: entryHash(5),
        previousEntryHash: entryHash(4),
        body: { uBitsHex: commit.uBitsHex },
      },
    ];
    return {
      branch,
      runId,
      payload,
      predictionCommitment: commitment,
      drawSeed,
      drawCommitment: commit.drawCommitment,
      disclosure,
      transcript,
      ...(planned.predictionTreatment === 'ordinary-records'
        ? {}
        : { treatmentSlice: sliceLedgerTreatment(batch, `${runId}:turn:0`, branch) }),
    };
  });
  const shared: Lv01AuditSharedInput = {
    symbolInventory: [...inventory],
    frozenModel: model,
    authenticate: () => true,
    parent: {
      parentRunId: PARENT_RUN_ID,
      parentCheckpointHash: CHECKPOINT,
      babyAInitialPolicyRef: 'policies/baby-a-latest.json',
      babyBInitialPolicyRef: 'policies/baby-b-latest.json',
      parentConfigurationHash: hashCanonical('lv01-paired-parent-config/v1', parent),
      parentRandomSeed: ROOT_SEED,
    },
    treatmentBatch: batch,
    parentLedgerEvents: { babyA: parentBabyA, babyB: parentBabyB },
  };
  return { plan, shared, branches, batch };
}

describe('LV01 independent auditor', () => {
  it('accepts a fully reconstructed seven-branch case deterministically', () => {
    const input = validCase();
    const first = auditLv01PairedCase(input);
    expect(first.caseCommitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(auditLv01PairedCase(validCase()).caseCommitment).toBe(first.caseCommitment);
    // Intervened branches keep recorded (non-replay) sampling vectors.
    const shuffled = input.branches.find((entry) => entry.branch === 'shuffled')!;
    expect(shuffled.disclosure.probs).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('rejects an omitted or reordered branch', () => {
    const input = validCase();
    expect(() => auditLv01PairedCase({ ...input, branches: input.branches.slice(0, 6) })).toThrow(/seven/u);
    const swapped = [...input.branches];
    const held = swapped[0]!;
    swapped[0] = swapped[1]!;
    swapped[1] = held;
    expect(() => auditLv01PairedCase({ ...input, branches: swapped })).toThrow(/out of order/u);
  });

  it('rejects mixed candidate order between payload and disclosure', () => {
    const input = validCase();
    const branches = structuredClone(input.branches);
    const target = branches[0]!;
    const swappedRefs = [...refs].reverse();
    const swappedProbs = [...target.disclosure.probs].reverse();
    // Recommit the draw over the swapped order so only the order check can fire.
    const recommitted = commitLv01ActionDraw({
      drawSeed: target.drawSeed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: swappedRefs,
      preStateCommitment: input.plan.preStateCommitment,
    });
    target.drawCommitment = recommitted.drawCommitment;
    target.disclosure = {
      uBitsHex: recommitted.uBitsHex,
      probs: swappedProbs,
      candidateRefs: swappedRefs,
      selectedCandidateRef: swappedRefs[drawIndexFromUnit(swappedProbs, recommitted.u)] as string,
    };
    const transcript = [...target.transcript];
    transcript[2] = { ...transcript[2]!, body: { drawCommitment: recommitted.drawCommitment } };
    target.transcript = transcript;
    expect(() => auditLv01PairedCase({ ...input, branches })).toThrow(/reorders the committed candidates/u);
  });

  it('rejects a changed native vector', () => {
    const input = validCase();
    const branches = structuredClone(input.branches);
    const distribution = [...branches[2]!.payload.native.distribution];
    distribution[0] = (distribution[0] as number) + 0.5;
    branches[2]!.payload = { ...branches[2]!.payload, native: { ...branches[2]!.payload.native, distribution } };
    expect(() => auditLv01PairedCase({ ...input, branches })).toThrow(/native vector/u);
  });

  it('rejects a wrong action draw', () => {
    const input = validCase();
    const branches = structuredClone(input.branches);
    branches[0]!.disclosure = { ...branches[0]!.disclosure, uBitsHex: `${'f'.repeat(63)}0` };
    expect(() => auditLv01PairedCase({ ...input, branches })).toThrow(/draw commitment does not match/u);
  });

  it('rejects a normal branch whose sampling vector is not the replay', () => {
    const input = validCase();
    const fixture = validCase();
    const u = commitLv01ActionDraw({
      drawSeed: fixture.branches[0]!.drawSeed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: refs,
      preStateCommitment: fixture.plan.preStateCommitment,
    }).u;
    const branches = structuredClone(input.branches);
    const probs = [0.25, 0.25, 0.25, 0.25];
    branches[0]!.disclosure = {
      ...branches[0]!.disclosure,
      probs,
      selectedCandidateRef: refs[drawIndexFromUnit(probs, u)] as string,
    };
    const transcript = [...branches[0]!.transcript];
    transcript[3] = { ...transcript[3]!, body: { ...(transcript[3]!.body as Record<string, unknown>), selectedCandidateRef: branches[0]!.disclosure.selectedCandidateRef } };
    branches[0]!.transcript = transcript;
    expect(() => auditLv01PairedCase({ ...input, branches })).toThrow(/not the replayed policy response/u);
  });

  it('rejects shuffled chronology and a broken transcript chain', () => {
    const input = validCase();
    const shuffled = structuredClone(input.branches);
    const entries = [...shuffled[1]!.transcript];
    entries[1] = { ...entries[1]!, sequence: 4 };
    entries[3] = { ...entries[3]!, sequence: 2 };
    // Re-link the chain along the new order so only the chronology check fires.
    const relinked = [...entries].sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < relinked.length; index += 1) {
      relinked[index] = { ...relinked[index]!, previousEntryHash: relinked[index - 1]!.entryHash };
    }
    shuffled[1]!.transcript = relinked;
    expect(() => auditLv01PairedCase({ ...input, branches: shuffled })).toThrow(/shuffles case chronology/u);
    const broken = structuredClone(input.branches);
    const transcript = [...broken[1]!.transcript];
    transcript[2] = { ...transcript[2]!, previousEntryHash: `sha256:${'9'.repeat(64)}` };
    broken[1]!.transcript = transcript;
    expect(() => auditLv01PairedCase({ ...input, branches: broken })).toThrow(/chain breaks/u);
  });

  it('rejects stale restore lineage and a foreign pre-state', () => {
    const input = validCase();
    const stale = structuredClone(input.branches);
    const transcript = [...stale[4]!.transcript];
    transcript[0] = {
      ...transcript[0]!,
      body: { ...(transcript[0]!.body as Record<string, unknown>), parentRunId: 'foreign-parent' },
    };
    stale[4]!.transcript = transcript;
    expect(() => auditLv01PairedCase({ ...input, branches: stale })).toThrow(/stale or foreign/u);
    const foreign = validCase();
    foreign.shared = {
      ...foreign.shared,
      parent: { ...foreign.shared.parent, babyAInitialPolicyRef: 'policies/baby-a-policy-63.json' },
    };
    expect(() => auditLv01PairedCase(foreign)).toThrow(/pre-state/u);
  });

  it('rejects a future ledger row past the committed cutoff', () => {
    const input = validCase();
    const future = ledgerEvent(PARENT_RUN_ID, 'babyB', {
      sequence: 9,
      turn: 99,
      subjectId: 'symbol:S09',
      content: { termRef: 'symbol:S09', associationOverTypeCodes: weights() },
    });
    const shared = {
      ...input.shared,
      parentLedgerEvents: {
        babyA: [...input.shared.parentLedgerEvents.babyA],
        babyB: [...input.shared.parentLedgerEvents.babyB, future],
      },
    };
    expect(() => auditLv01PairedCase({ ...input, shared })).toThrow(/past the committed cutoff/u);
  });

  it('rejects a substituted treatment slice and a misreported coincidence', () => {
    const input = validCase();
    const substituted = structuredClone(input.branches);
    const ledger = substituted.find((entry) => entry.branch === 'ledger-consistent')!;
    ledger.treatmentSlice = { ...ledger.treatmentSlice!, deliveredToken: 'S31' };
    expect(() => auditLv01PairedCase({ ...input, branches: substituted })).toThrow(/disagrees with the registered plan slice/u);
    const recoined = validCase();
    const cases = structuredClone(recoined.batch.cases);
    cases[0] = { ...cases[0]!, identicalTokenCoincidence: !cases[0]!.identicalTokenCoincidence };
    recoined.shared = { ...recoined.shared, treatmentBatch: { ...recoined.batch, cases } };
    expect(() => auditLv01PairedCase(recoined)).toThrow(/misreports its token coincidence/u);
  });

  it('rejects a null token outside the disabled branch', () => {
    const input = validCase();
    const rebuilt = structuredClone(input.branches);
    const target = rebuilt.find((entry) => entry.branch === 'constant')!;
    const records = mapLv01LedgerAssociations(input.shared.parentLedgerEvents.babyB, 'baby-b', () => true);
    const { payload, commitment } = buildLv01PairedPredictionPayload({
      branch: 'constant',
      predictionTreatment: 'ordinary-records',
      turn: 0,
      receiver: 'baby-b',
      caseId: target.payload.caseId,
      candidateRefs: refs,
      candidateTypeCodes: candidates,
      deliveredToken: null,
      symbolInventory: [...inventory],
      ledgerRecords: records,
      cutoff: deriveLv01LedgerCutoff(records),
      frozenModel: input.shared.frozenModel,
      ordinaryId: target.payload.ordinary.id,
      ordinaryFit: target.payload.ordinary.fit,
      state: target.payload.state,
      scheduleDigest: target.payload.scheduleDigest,
    });
    const index = rebuilt.findIndex((entry) => entry.branch === 'constant');
    const action = { ...(rebuilt[index]!.transcript[3]!.body as Record<string, unknown>), deliveredToken: null };
    const transcript = [...rebuilt[index]!.transcript];
    transcript[3] = { ...transcript[3]!, body: action };
    rebuilt[index] = { ...rebuilt[index]!, payload, predictionCommitment: commitment, transcript };
    expect(() => auditLv01PairedCase({ ...input, branches: rebuilt })).toThrow(/null-token rule/u);
  });

  it('ignores collector flags: they cannot rescue a missing restore', () => {
    const input = validCase();
    const branches = structuredClone(input.branches);
    branches[3]!.transcript = branches[3]!.transcript.filter((entry) => entry.eventType !== 'learner-initialization');
    const flagged = branches.map((entry) => ({
      ...entry,
      actionRecordedAfterPrediction: true,
      restoredBeforeAction: true,
    }));
    expect(() => auditLv01PairedCase({ ...input, branches: flagged as unknown as Lv01AuditedBranch[] }))
      .toThrow(/omits a required case event/u);
  });
});

describe('LV01 auditor acceptance behaviors', () => {
  it('reproduces a hand-calculated categorical policy exactly', () => {
    const input = validCase();
    const normal = input.branches.find((entry) => entry.branch === 'normal')!;
    const epsilon = 1e-12;
    const total = 4 + 4 * epsilon;
    const expected = [(3 + epsilon) / total, (1 + epsilon) / total, epsilon / total, epsilon / total];
    for (const [index, value] of normal.payload.native.distribution.entries()) {
      expect(value).toBeCloseTo(expected[index] as number, 15);
    }
    expect(normal.payload.native.source).toBe('training-ledger');
    const records = mapLv01LedgerAssociations(input.shared.parentLedgerEvents.babyB, 'baby-b', () => true);
    const index = indexLv01TrainingLedger(records, 'baby-b', deriveLv01LedgerCutoff(records));
    expect(selectLedgerConsistentToken(index, 1, candidates, [...inventory])).toBe('S01');
    expect(normal.payload.replay).not.toBeNull();
    // Frozen prediction function: the replayed policy response is pinned exactly.
    const pinnedReplay = [0.21968553057614595, 0.3161278156044371, 0.1925616052230896, 0.2716250485963274];
    for (const [index, value] of normal.payload.replay!.distribution.entries()) {
      expect(value).toBeCloseTo(pinnedReplay[index] as number, 15);
    }
    expect(normal.payload.replay!.selectedCandidateIndex).toBe(1);
    expect(normal.payload.replay!.distribution.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(normal.payload.replay!.selectedCandidateIndex).toBe(
      normal.payload.replay!.distribution.indexOf(Math.max(...normal.payload.replay!.distribution)),
    );
  });

  it('predicts identically across signature envelopes; corruption fails verification', () => {
    const input = validCase();
    const events = input.shared.parentLedgerEvents.babyB;
    const reenveloped = events.map((event, position) => ({
      ...event,
      entryHash: hashCanonical('audit-reenvelope/v1', position),
      writerSignature: 'different-valid-signature',
    }));
    const left = indexLv01TrainingLedger(
      mapLv01LedgerAssociations(events, 'baby-b', () => true), 'baby-b', { sequence: 2, turn: 1 },
    );
    const right = indexLv01TrainingLedger(
      mapLv01LedgerAssociations(reenveloped, 'baby-b', () => true), 'baby-b', { sequence: 2, turn: 1 },
    );
    expect(predictLv01NativeLedger(right, 'S01', candidates).distribution)
      .toEqual(predictLv01NativeLedger(left, 'S01', candidates).distribution);
    const unauthenticated = mapLv01LedgerAssociations(events, 'baby-b', () => false);
    expect(() => indexLv01TrainingLedger(unauthenticated, 'baby-b', { sequence: 2, turn: 1 }))
      .toThrow(/unauthenticated/u);
  });

  it('leaves the seeded action trace unchanged without summary inputs', () => {
    const scopeKeys = Object.keys(SCOPE).sort();
    expect(scopeKeys).toEqual(['caseId', 'partition', 'receiverRole', 'slotIndex', 'slotKind', 'stage']);
    const seed = deriveLv01ActionDrawSeed(ROOT_SEED, SCOPE);
    const commit = (preState: string) => commitLv01ActionDraw({
      drawSeed: seed,
      turn: 0,
      receiver: 'baby-b',
      candidateRefs: refs,
      preStateCommitment: preState,
    });
    // Same seed and turn with different predictor contexts: identical unit value.
    expect(commit(`sha256:${'1'.repeat(64)}`).u).toBe(commit(`sha256:${'2'.repeat(64)}`).u);
    const probs = [0.1, 0.2, 0.3, 0.4];
    expect(drawIndexFromUnit(probs, commit(SCENARIO).u)).toBe(drawIndexFromUnit(probs, commit(POLICY).u));
  });

  it('cannot support a useful-ledger claim from an uninformative policy', () => {
    const values = Array.from({ length: 4 }, (_, index) => ({
      seedId: `seed-${index}`,
      byRole: {
        'baby-a': { incremental: [0], fidelity: [0], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] },
        'baby-b': { incremental: [0], fidelity: [0], disabled: [0], constant: [0], random: [0], shuffled: [0], intervention: [0] },
      },
    }));
    expect(analyzeLv01Family(values).dispositions['LV-U']).not.toBe('supported');
  });
});
