/** LV01 fail-closed paired-case collection and immutable slot accounting. */
import { hashCanonical } from '@ald/hashing';
import { createDerivedRunConfig } from '@ald/lifecycle';
import { LV01_UNTOUCHED_TYPE_CODES } from '@ald/scenario';
import { GENESIS_HASH, type RunConfig } from '@ald/types';

import {
  assertLv01ActionDrawScope,
  deriveLv01ActionDrawSeed,
} from './lv01-action-draw.js';

export const LV01_BRANCHES = ['normal', 'disabled', 'constant', 'random', 'shuffled', 'ledger-consistent', 'ledger-shuffled'] as const;
export type Lv01Branch = (typeof LV01_BRANCHES)[number];
export type Lv01Stage = 'development' | 'qualification' | 'pilot' | 'confirmatory' | 'replication';
export type Lv01SlotStatus = 'unattempted' | 'running' | 'valid' | 'invalid' | 'aborted';
export interface Lv01Slot { readonly index: number; readonly kind: 'primary' | 'reserve'; readonly status: Lv01SlotStatus; readonly reason?: string; readonly caseCommitment?: string; readonly parentBundleRef?: string; readonly resources?: Lv01SlotResources; }
export interface Lv01StageJournal { readonly stage: Lv01Stage; readonly version: number; readonly attemptId: string; readonly slots: readonly Lv01Slot[]; readonly terminal: 'open' | 'completed' | 'failed' | 'aborted'; }
export interface Lv01AdmissionInput { readonly designVerified: boolean; readonly numericalQualificationVerified: boolean; readonly topologyQualificationVerified: boolean; readonly sourceClean: boolean; readonly registrationBound: boolean; readonly resourcesSufficient: boolean; readonly designHashesLive: boolean; readonly hostReady: boolean; readonly stage: Lv01Stage; }
export interface Lv01Admission { readonly status: 'ready' | 'blocked' | 'unresolved'; readonly reasons: readonly string[]; }
export interface Lv01PairedBranchEvidence { readonly branch: Lv01Branch; readonly scenarioHash: string; readonly receiverDrawCommitment: string; readonly preStateCommitment: string; readonly predictionCommitment: string; readonly actionRecordedAfterPrediction: boolean; readonly restoredBeforeAction: boolean; }
export type Lv01ResourceCounter = 'cpuMicroseconds' | 'wallMilliseconds' | 'peakBytes' | 'evidenceBytes' | 'verificationMilliseconds';
export const LV01_RESOURCE_COUNTERS: readonly Lv01ResourceCounter[] = ['cpuMicroseconds', 'wallMilliseconds', 'peakBytes', 'evidenceBytes', 'verificationMilliseconds'];
/**
 * Slot resource counters. `unresolved` names counters that were NOT measured
 * (failed before measurement, unobservable peak); those counters MUST be zero
 * and no consumer may treat them as measurements. Unknown is unresolved,
 * never a silent zero and never a final-RSS-as-peak substitution.
 */
export interface Lv01SlotResources { readonly cpuMicroseconds: number; readonly wallMilliseconds: number; readonly peakBytes: number; readonly evidenceBytes: number; readonly verificationMilliseconds: number; readonly unresolved: readonly Lv01ResourceCounter[]; }
export interface Lv01SlotTerminalReceipt { readonly journal: Lv01StageJournal; readonly slot: Lv01Slot; readonly resources: Lv01SlotResources; readonly failureStage: string | null; }

/** The runtime condition and predictor treatment for each paired LV01 branch. */
export interface Lv01PairedBranchPlan {
  readonly branch: Lv01Branch;
  readonly communicationCondition: RunConfig['communicationCondition'];
  readonly predictionTreatment: 'ordinary-records' | 'ledger-consistent' | 'ledger-shuffled';
  readonly config: RunConfig;
}

/** Immutable parent checkpoint and child identifiers for one seven-branch case. */
export interface Lv01PairedCasePlanInput {
  readonly parent: RunConfig;
  readonly parentCheckpointHash: string;
  readonly babyAInitialPolicyRef: string;
  readonly babyBInitialPolicyRef: string;
  readonly childRunIdPrefix: string;
  /**
   * Committed ledger-treatment slices per branch. Ledger branches deliver
   * only with a committed slice; ordinary branches must not carry one.
   */
  readonly ledgerTreatments?: Partial<Record<Lv01Branch, {
    readonly selectedToken: string;
    readonly deliveredToken: string;
    readonly batchCommitment: string;
    readonly sourceCaseId: string;
  }>>;
  /**
   * Shared action-draw scope. One seed per case (no branch part); the
   * receiver role follows the scheduled case (turn 0 is always baby-b by
   * role math, so baby-a cases name their receiver explicitly).
   */
  readonly actionDrawScope: {
    readonly stage: 'development' | 'qualification' | 'shadow' | 'generalization' | 'pilot';
    readonly slotKind: 'primary' | 'reserve';
    readonly slotIndex: string;
    readonly partition: 'dev' | 'within-support' | 'novel-composition';
  };
  /**
   * Slot-bound seed material. Every branch of the slot shares it (paired
   * serving); distinct slots get distinct scenarios and bindings.
   */
  readonly slotSeeds: {
    readonly scenario: string;
    readonly babyA: string;
    readonly babyB: string;
    readonly gateway: string;
    readonly analysis: string;
  };
  /** Scheduled LV01 case served by every branch of this paired case. */
  readonly scheduledCase: {
    readonly partition: 'training' | 'validation-fit' | 'validation-selection' | 'within-support-test';
    readonly caseIndex: number;
    readonly receiverRole: 'baby-a' | 'baby-b';
  };
}

/** Seven independent derived runs that begin from the same exported parent state. */
export interface Lv01PairedCasePlan {
  readonly preStateCommitment: string;
  readonly branches: readonly Lv01PairedBranchPlan[];
}

function fail(message: string): never { throw new Error(`LV01 collector: ${message}`); }

const branchTreatment = (branch: Lv01Branch): {
  communicationCondition: RunConfig['communicationCondition'];
  predictionTreatment: Lv01PairedBranchPlan['predictionTreatment'];
} => {
  switch (branch) {
    case 'normal': return { communicationCondition: 'normal', predictionTreatment: 'ordinary-records' };
    case 'disabled': return { communicationCondition: 'disabled', predictionTreatment: 'ordinary-records' };
    case 'constant': return { communicationCondition: 'constant', predictionTreatment: 'ordinary-records' };
    case 'random': return { communicationCondition: 'random', predictionTreatment: 'ordinary-records' };
    case 'shuffled': return { communicationCondition: 'shuffled', predictionTreatment: 'ordinary-records' };
    case 'ledger-consistent': return { communicationCondition: 'normal', predictionTreatment: 'ledger-consistent' };
    case 'ledger-shuffled': return { communicationCondition: 'normal', predictionTreatment: 'ledger-shuffled' };
  }
};

/**
 * Compile the only supported paired-case reset: a fresh derived run per
 * branch, each initialized from the exact same immutable parent policies.
 *
 * A live in-place snapshot would expose mutable Gateway and learner state to
 * a controller. Derived lineage instead loads the exported recurrent policy
 * (including optimizer and checkpoint-hidden state) inside each isolated
 * Baby and makes every branch's evidence chain independently verifiable.
 */
export function createLv01PairedCasePlan(input: Lv01PairedCasePlanInput): Lv01PairedCasePlan {
  if (input.parent.experimentId !== 'LV01') fail('paired cases require an LV01 parent');
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.parentCheckpointHash)) fail('parent checkpoint hash is invalid');
  if (!/^policies\/baby-a-(?:latest|policy-(?:initial|[0-9]+))\.json$/u.test(input.babyAInitialPolicyRef)) fail('baby-a policy reference is invalid');
  if (!/^policies\/baby-b-(?:latest|policy-(?:initial|[0-9]+))\.json$/u.test(input.babyBInitialPolicyRef)) fail('baby-b policy reference is invalid');
  if (!/^[a-z0-9-]+$/u.test(input.childRunIdPrefix)) fail('child run identifier prefix is invalid');
  if (input.parent.seedBindings === undefined) fail('paired cases require parent seed bindings');
  const drawScope = {
    ...input.actionDrawScope,
    receiverRole: input.scheduledCase.receiverRole,
    caseId: `${input.childRunIdPrefix}:turn:0`,
  };
  assertLv01ActionDrawScope(drawScope);
  const drawSeed = deriveLv01ActionDrawSeed(input.slotSeeds.scenario, drawScope);
  const drawSeedCommitment = hashCanonical('lv01-action-draw-seed/v1', drawSeed);
  const preStateCommitment = hashCanonical('lv01-paired-pre-state/v1', {
    parentRunId: input.parent.runId,
    parentCheckpointHash: input.parentCheckpointHash,
    babyAInitialPolicyRef: input.babyAInitialPolicyRef,
    babyBInitialPolicyRef: input.babyBInitialPolicyRef,
    configurationHash: hashCanonical('lv01-paired-parent-config/v1', input.parent),
  });
  const branches = LV01_BRANCHES.map((branch) => {
    const treatment = branchTreatment(branch);
    const ledgerSlice = input.ledgerTreatments?.[branch];
    const isLedgerBranch = treatment.predictionTreatment !== 'ordinary-records';
    if (isLedgerBranch && ledgerSlice === undefined) fail(`branch ${branch} requires a committed ledger-treatment slice`);
    if (!isLedgerBranch && ledgerSlice !== undefined) fail(`branch ${branch} must not carry a ledger-treatment slice`);
    const config = createDerivedRunConfig(
      input.parent,
      input.parentCheckpointHash,
      `${input.childRunIdPrefix}-${branch}`,
      {
        babyAInitialPolicyRef: input.babyAInitialPolicyRef,
        babyBInitialPolicyRef: input.babyBInitialPolicyRef,
        overrides: {
          communicationCondition: treatment.communicationCondition,
          evaluationOnly: true,
          // A paired case is one held-out episode per immutable branch. More
          // episodes would be a separate paired-case allocation, not a
          // silent expansion of this branch-reset primitive.
          evaluationTurns: 1,
          // Slot-bound seeds: the scenario seed doubles as the run seed so
          // the nursery regenerates this slot's scheduled case; bindings
          // stay consistent (scenario must equal randomSeed).
          randomSeed: input.slotSeeds.scenario,
          seedBindings: {
            version: 1,
            scenario: input.slotSeeds.scenario,
            babyA: input.slotSeeds.babyA,
            babyB: input.slotSeeds.babyB,
            gateway: input.slotSeeds.gateway,
            analysis: input.slotSeeds.analysis,
            actionDraw: drawSeed,
          },
          // Frozen LV01 untouched diagonal: the nursery builds its engine
          // held-out list from here, and scheduled cases require it.
          interventionPlan: { version: 1, heldOutTypeCodes: [...LV01_UNTOUCHED_TYPE_CODES] },
          // The derived engine config differs from the parent's (held-outs
          // above), so the inherited scenarioBundleHash cannot name it. Pass
          // the documented genesis placeholder; the nursery binds the actual
          // served-engine hash at createRun (SPEC §15.1).
          scenarioBundleHash: GENESIS_HASH,
          lv01PairedCase: {
            version: 1,
            branch,
            predictionTreatment: treatment.predictionTreatment,
            preStateCommitment,
            ...(ledgerSlice === undefined ? {} : { ledgerTreatment: { ...ledgerSlice } }),
            actionDraw: { ...drawScope, drawSeedCommitment },
            scheduledCase: { ...input.scheduledCase },
          },
        },
      },
    );
    return { branch, ...treatment, config };
  });
  if (new Set(branches.map((entry) => entry.config.runId)).size !== LV01_BRANCHES.length) fail('branch run identifiers collide');
  return { preStateCommitment, branches };
}
export function createLv01StageJournal(stage: Lv01Stage, version: number, primarySlots: number, reserveSlots = 0): Lv01StageJournal {
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(primarySlots) || primarySlots < 1 || !Number.isInteger(reserveSlots) || reserveSlots < 0) fail('stage journal dimensions are invalid');
  const slots: Lv01Slot[] = [
    ...[...Array(primarySlots)].map((_, index) => ({ index: index + 1, kind: 'primary' as const, status: 'unattempted' as const })),
    ...[...Array(reserveSlots)].map((_, index) => ({ index: primarySlots + index + 1, kind: 'reserve' as const, status: 'unattempted' as const })),
  ];
  return { stage, version, attemptId: `lv01-${stage}-v${version}`, slots, terminal: 'open' };
}
export function transitionLv01Slot(journal: Lv01StageJournal, index: number, status: Exclude<Lv01SlotStatus, 'unattempted'>, reason?: string): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('terminal journal cannot change');
  const slot = journal.slots.find((entry) => entry.index === index); if (!slot) fail('unknown slot');
  if (status === 'running') { if (slot.status !== 'unattempted') fail('a slot cannot be started twice'); }
  else if (slot.status !== 'running') fail('only a running slot can become terminal');
  if ((status === 'invalid' || status === 'aborted') && (!reason || reason.length === 0)) fail('invalid or aborted slot requires a reason');
  return { ...journal, slots: journal.slots.map((entry) => entry.index === index ? { ...entry, status, ...(reason ? { reason } : {}) } : entry) };
}
/** Terminal slots retain measured resource counters even when execution fails. */
export function captureLv01SlotTerminal(journal: Lv01StageJournal, index: number, status: Exclude<Lv01SlotStatus, 'unattempted' | 'running'>, resources: Lv01SlotResources, failureStage: string | null, reason?: string): Lv01SlotTerminalReceipt {
  for (const counter of LV01_RESOURCE_COUNTERS) {
    const value = resources[counter];
    if (!Number.isFinite(value) || value < 0) fail('terminal resource counters must be finite non-negative numbers');
  }
  for (const name of resources.unresolved) {
    if (!LV01_RESOURCE_COUNTERS.includes(name)) fail(`unknown unresolved counter ${name}`);
    if (resources[name] !== 0) fail(`unresolved counter ${name} must be zero, never a fabricated measurement`);
  }
  if (status === 'valid' && resources.unresolved.length !== 0) fail('valid slot cannot carry unresolved counters');
  if (status === 'valid' && (failureStage !== null || reason !== undefined)) fail('valid slot cannot carry a failure diagnostic');
  if (status !== 'valid' && (failureStage === null || failureStage.length === 0 || reason === undefined || reason.length === 0)) fail('failed slot requires stage and reason');
  const updated = transitionLv01Slot(transitionLv01Slot(journal, index, 'running'), index, status, reason);
  const journalWithResources: Lv01StageJournal = {
    ...updated,
    slots: updated.slots.map((entry) => (entry.index === index ? { ...entry, resources } : entry)),
  };
  return { journal: journalWithResources, slot: journalWithResources.slots.find((slot) => slot.index === index)!, resources, failureStage };
}
/** Link a valid slot to its own trained parent bundle (stageDir-relative); valid slots only. */
export function recordLv01SlotParent(journal: Lv01StageJournal, index: number, parentBundleRef: string): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('terminal journal cannot change');
  const slot = journal.slots.find((entry) => entry.index === index); if (!slot) fail('unknown slot');
  if (slot.status !== 'valid') fail('only a valid slot can link a parent');
  if (parentBundleRef.length === 0 || parentBundleRef.startsWith('/') || parentBundleRef.split('/').includes('..')) fail('parent bundle ref must be a contained relative path');
  return { ...journal, slots: journal.slots.map((entry) => entry.index === index ? { ...entry, parentBundleRef } : entry) };
}
/** Link a valid slot to its audited case commitment; valid slots only. */
export function recordLv01SlotCase(journal: Lv01StageJournal, index: number, caseCommitment: string): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('terminal journal cannot change');
  const slot = journal.slots.find((entry) => entry.index === index); if (!slot) fail('unknown slot');
  if (slot.status !== 'valid') fail('only a valid slot can link a case');
  if (!/^sha256:[0-9a-f]{64}$/u.test(caseCommitment)) fail('case commitment is malformed');
  return { ...journal, slots: journal.slots.map((entry) => entry.index === index ? { ...entry, caseCommitment } : entry) };
}
export function finalizeLv01Stage(journal: Lv01StageJournal): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('stage journal is already terminal');
  if (journal.slots.some((slot) => slot.status === 'running')) fail('running slots prevent terminal accounting');
  const primary = journal.slots.filter((slot) => slot.kind === 'primary');
  const terminal = primary.every((slot) => slot.status === 'valid') ? 'completed' : primary.some((slot) => slot.status === 'aborted') ? 'aborted' : 'failed';
  return { ...journal, terminal };
}
export function assessLv01Admission(input: Lv01AdmissionInput): Lv01Admission {
  const reasons: string[] = [];
  if (!input.designVerified) reasons.push('design-not-verified');
  if (!input.numericalQualificationVerified) reasons.push('numerical-qualification-missing');
  if (!input.topologyQualificationVerified) reasons.push('topology-qualification-missing');
  if (!input.sourceClean) reasons.push('source-not-clean');
  if (!input.registrationBound) reasons.push('registration-binding-missing');
  if (!input.resourcesSufficient) reasons.push('resource-allocation-missing');
  if (!input.designHashesLive) reasons.push('design-hashes-changed');
  if (!input.hostReady) reasons.push('host-not-ready');
  return { status: reasons.length === 0 ? 'ready' : 'blocked', reasons };
}
/** Verify the complete pre-action paired case before it can enter analysis. */
export function verifyLv01PairedCase(evidence: readonly Lv01PairedBranchEvidence[]): { caseCommitment: string } {
  if (evidence.length !== LV01_BRANCHES.length || evidence.some((entry, index) => entry.branch !== LV01_BRANCHES[index])) fail('all seven ordered branches are required');
  const first = evidence[0]; if (!first) fail('paired evidence is empty');
  for (const entry of evidence) {
    if (entry.scenarioHash !== first.scenarioHash || entry.receiverDrawCommitment !== first.receiverDrawCommitment || entry.preStateCommitment !== first.preStateCommitment) fail('paired branches do not share scenario, receiver draw, and pre-state');
    if (!entry.actionRecordedAfterPrediction || !entry.restoredBeforeAction || entry.predictionCommitment.length === 0) fail('branch violates prediction chronology or restore requirement');
  }
  return { caseCommitment: hashCanonical('lv01-paired-case/v1', evidence) };
}

/**
 * H07 calibration reserves (handoff §5.2): after five full-workload
 * calibration dyads, each per-slot CPU/storage/wall reserve is twice the
 * largest complete measured slot cost and the peak-memory bound is 1.5 times
 * the conservative measured maximum. The same function covers the post-pilot
 * update by taking maxima over calibration and pilot measurements together.
 * Pure arithmetic over supplied measurements; it invents none.
 */
export const LV01_CALIBRATION_DYADS = 5;
export const LV01_SLOT_RESERVE_MULTIPLIER = 2;
export const LV01_PEAK_MEMORY_MULTIPLIER = 1.5;
export const LV01_PILOT_PRIMARY_SLOTS = 20;

export interface Lv01CalibrationReserve {
  readonly measuredDyads: number;
  readonly perSlotCpuMicroseconds: number;
  readonly perSlotEvidenceBytes: number;
  readonly perSlotWallMilliseconds: number;
  readonly peakBytesBound: number;
}

export interface Lv01ScaledReserve {
  readonly slots: number;
  readonly cpuMicroseconds: number;
  readonly evidenceBytes: number;
  readonly wallMilliseconds: number;
}

export function computeLv01CalibrationReserves(measurements: readonly Lv01SlotResources[]): Lv01CalibrationReserve {
  if (measurements.length < LV01_CALIBRATION_DYADS) fail(`at least ${LV01_CALIBRATION_DYADS} complete full-workload dyads are required`);
  for (const entry of measurements) {
    if (entry.unresolved.length !== 0) fail(`calibration rejects unresolved counters: ${entry.unresolved.join(', ')}`);
    if (![entry.cpuMicroseconds, entry.wallMilliseconds, entry.peakBytes, entry.evidenceBytes]
      .every((value) => Number.isFinite(value) && value > 0)) fail('calibration requires complete measured slot costs');
    if (!Number.isFinite(entry.verificationMilliseconds) || entry.verificationMilliseconds < 0) fail('calibration verification cost must be a finite non-negative number');
  }
  const max = (pick: (entry: Lv01SlotResources) => number): number =>
    Math.max(...measurements.map(pick));
  return {
    measuredDyads: measurements.length,
    perSlotCpuMicroseconds: max((entry) => entry.cpuMicroseconds) * LV01_SLOT_RESERVE_MULTIPLIER,
    perSlotEvidenceBytes: max((entry) => entry.evidenceBytes) * LV01_SLOT_RESERVE_MULTIPLIER,
    perSlotWallMilliseconds: max((entry) => entry.wallMilliseconds) * LV01_SLOT_RESERVE_MULTIPLIER,
    peakBytesBound: max((entry) => entry.peakBytes) * LV01_PEAK_MEMORY_MULTIPLIER,
  };
}

/** Scale a per-slot reserve over a slot count (e.g. the twenty-slot pilot). */
export function scaleLv01ReserveForSlots(reserve: Lv01CalibrationReserve, slots: number): Lv01ScaledReserve {
  if (!Number.isInteger(slots) || slots < 1) fail('slot count must be a positive integer');
  return {
    slots,
    cpuMicroseconds: reserve.perSlotCpuMicroseconds * slots,
    evidenceBytes: reserve.perSlotEvidenceBytes * slots,
    wallMilliseconds: reserve.perSlotWallMilliseconds * slots,
  };
}
