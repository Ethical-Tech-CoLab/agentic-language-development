/**
 * LV01 independent paired-case auditor (R04 item 6).
 *
 * Reconstructs case identity, the delivered token, prediction-before-action
 * ordering, the shared action draw, parent state, and the sample outcome
 * from raw records: the registered case plan, raw ledger events, committed
 * prediction payloads, draw records, the sealed treatment batch, and the
 * hash-linked evidence transcript. It never reads collector-created boolean
 * flags (`actionRecordedAfterPrediction`, `restoredBeforeAction`,
 * `identicalTokenCoincidence`): ordering comes from transcript sequences,
 * restore from lineage digests, and coincidence is recomputed.
 *
 * Trust boundary: the caller supplies authentic raw records and the
 * registered plan/parent bundle (the R05 evidence loader binds those to
 * sealed bundles). Given authentic inputs, any forgery, substitution,
 * reorder, or omission fails closed.
 */
import { verifyLv01OrdinaryTranscriptMatch } from '@ald/analysis';
import { hashCanonical, unitBitsHex } from '@ald/hashing';
import type { LedgerEvent } from '@ald/types';

import {
  LV01_ACTION_DRAW_COMMITMENT_DOMAIN,
  assertLv01ActionDrawScope,
  deriveLv01ActionDrawSeed,
  drawLv01SharedUnit,
  verifyLv01ActionDraw,
  type Lv01ActionDrawDisclosure,
  type Lv01ActionDrawScope,
} from './lv01-action-draw.js';
import { LV01_BRANCHES, type Lv01Branch, type Lv01PairedCasePlan } from './ledger-value.js';
import {
  mapLv01LedgerAssociations,
  verifyLv01PairedPredictionPayload,
  type Lv01LedgerAuthenticate,
  type Lv01PairedPredictionPayload,
} from './lv01-paired-predictions.js';
import {
  verifyLedgerTreatmentSlice,
  type Lv01LedgerTreatmentBatch,
  type Lv01TreatmentSlice,
} from './lv01-ledger-treatments.js';

export const LV01_AUDIT_CASE_DOMAIN = 'lv01-paired-case/v2' as const;

function fail(message: string): never {
  throw new Error(`LV01 audit: ${message}`);
}

/** Registered parent identity the auditor recomputes the pre-state from. */
export interface Lv01AuditParentBundle {
  readonly parentRunId: string;
  readonly parentCheckpointHash: string;
  readonly babyAInitialPolicyRef: string;
  readonly babyBInitialPolicyRef: string;
  readonly parentConfigurationHash: string;
  readonly parentRandomSeed: string;
}

export interface Lv01AuditSharedInput {
  readonly symbolInventory: readonly string[];
  readonly frozenModel: unknown;
  readonly authenticate: Lv01LedgerAuthenticate;
  readonly parent: Lv01AuditParentBundle;
  readonly treatmentBatch: Lv01LedgerTreatmentBatch;
}

export type Lv01AuditTranscriptEventType =
  | 'learner-initialization'
  | 'prediction-commitment'
  | 'action-draw-commitment'
  | 'receiver-action-recorded'
  | 'action-draw-disclosed';

export interface Lv01AuditTranscriptEntry {
  readonly sequence: number;
  readonly eventType: Lv01AuditTranscriptEventType;
  readonly entryHash: string;
  readonly previousEntryHash: string;
  readonly body: unknown;
}

export interface Lv01AuditedBranch {
  readonly branch: Lv01Branch;
  readonly runId: string;
  readonly payload: Lv01PairedPredictionPayload;
  readonly predictionCommitment: string;
  readonly ledgerEvents: {
    readonly babyA: readonly LedgerEvent[];
    readonly babyB: readonly LedgerEvent[];
  };
  readonly drawSeed: string;
  readonly drawCommitment: string;
  readonly disclosure: Lv01ActionDrawDisclosure;
  readonly transcript: readonly Lv01AuditTranscriptEntry[];
  /** Ledger branches only; ordinary branches must not carry one. */
  readonly treatmentSlice?: Lv01TreatmentSlice;
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function bodyRecord(body: unknown, eventType: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) fail(`${eventType} body is not an object`);
  return body as Record<string, unknown>;
}

function recomputedPreState(parent: Lv01AuditParentBundle): string {
  return hashCanonical('lv01-paired-pre-state/v1', {
    parentRunId: parent.parentRunId,
    parentCheckpointHash: parent.parentCheckpointHash,
    babyAInitialPolicyRef: parent.babyAInitialPolicyRef,
    babyBInitialPolicyRef: parent.babyBInitialPolicyRef,
    configurationHash: parent.parentConfigurationHash,
  });
}

function recomputedDrawCommitment(input: {
  readonly drawSeed: string;
  readonly turn: number;
  readonly receiver: 'baby-a' | 'baby-b';
  readonly candidateRefs: readonly string[];
  readonly preStateCommitment: string;
  readonly uBitsHex: string;
}): { drawSeedCommitment: string; uCommitment: string; drawCommitment: string } {
  const drawSeedCommitment = hashCanonical('lv01-action-draw-seed/v1', input.drawSeed);
  const uCommitment = hashCanonical('lv01-action-draw-u-commit/v1', input.uBitsHex);
  const drawCommitment = hashCanonical(LV01_ACTION_DRAW_COMMITMENT_DOMAIN, {
    drawSeedCommitment,
    uCommitment,
    candidateRefsHash: hashCanonical('lv01-draw-candidates/v1', [...input.candidateRefs]),
    turn: input.turn,
    receiver: input.receiver,
    preStateCommitment: input.preStateCommitment,
  });
  return { drawSeedCommitment, uCommitment, drawCommitment };
}

const TRANSCRIPT_ORDER: readonly Lv01AuditTranscriptEventType[] = [
  'learner-initialization',
  'prediction-commitment',
  'action-draw-commitment',
  'receiver-action-recorded',
  'action-draw-disclosed',
];

function verifyTranscript(input: {
  readonly branch: Lv01Branch;
  readonly transcript: readonly Lv01AuditTranscriptEntry[];
  readonly parent: Lv01AuditParentBundle;
  readonly predictionCommitment: string;
  readonly drawCommitment: string;
  readonly payload: Lv01PairedPredictionPayload;
  readonly disclosure: Lv01ActionDrawDisclosure;
}): void {
  const entries = [...input.transcript].sort((left, right) => left.sequence - right.sequence);
  const sequences = entries.map((entry) => entry.sequence);
  if (
    sequences.length === 0 ||
    sequences.some((sequence) => !Number.isInteger(sequence) || sequence < 1) ||
    new Set(sequences).size !== sequences.length
  ) {
    fail(`${input.branch} transcript sequences are not unique positive integers`);
  }
  for (const entry of entries) {
    if (!TRANSCRIPT_ORDER.includes(entry.eventType)) fail(`${input.branch} transcript carries unknown event ${String(entry.eventType)}`);
    if (entry.entryHash.length === 0 || entry.previousEntryHash.length === 0) fail(`${input.branch} transcript entry ${entry.sequence} has empty chain hashes`);
  }
  // The excerpt starts mid-chain, so only links between included entries verify.
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]!.previousEntryHash !== entries[index - 1]!.entryHash) {
      fail(`${input.branch} transcript chain breaks at sequence ${entries[index]!.sequence}`);
    }
  }
  const position = (type: Lv01AuditTranscriptEventType): number => entries.findIndex((entry) => entry.eventType === type);
  const positions = TRANSCRIPT_ORDER.map(position);
  if (positions.some((index) => index < 0)) fail(`${input.branch} transcript omits a required case event`);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! <= positions[index - 1]!) fail(`${input.branch} transcript shuffles case chronology`);
  }
  const body = (type: Lv01AuditTranscriptEventType): Record<string, unknown> =>
    bodyRecord(entries[positions[TRANSCRIPT_ORDER.indexOf(type)]!]!.body, `${input.branch} ${type}`);
  const init = body('learner-initialization');
  if (
    init['parentRunId'] !== input.parent.parentRunId ||
    init['derivedFromCheckpointHash'] !== input.parent.parentCheckpointHash ||
    init['babyAInitialPolicyRef'] !== input.parent.babyAInitialPolicyRef ||
    init['babyBInitialPolicyRef'] !== input.parent.babyBInitialPolicyRef
  ) {
    fail(`${input.branch} restore lineage is stale or foreign`);
  }
  if (body('prediction-commitment')['commitment'] !== input.predictionCommitment) {
    fail(`${input.branch} transcript prediction commitment disagrees with the payload`);
  }
  if (body('action-draw-commitment')['drawCommitment'] !== input.drawCommitment) {
    fail(`${input.branch} transcript draw commitment disagrees with the draw record`);
  }
  const action = body('receiver-action-recorded');
  if (action['selectedCandidateRef'] !== input.disclosure.selectedCandidateRef) {
    fail(`${input.branch} recorded action disagrees with the disclosed selection`);
  }
  if (action['deliveredToken'] !== input.payload.deliveredToken) {
    fail(`${input.branch} recorded action disagrees with the committed token`);
  }
  if (!Array.isArray(action['candidateRefs']) || !sameStrings(action['candidateRefs'] as string[], input.payload.candidateRefs)) {
    fail(`${input.branch} recorded action disagrees with the committed candidate order`);
  }
  if (action['scenarioStateHash'] !== input.payload.state.scenarioStateHash) {
    fail(`${input.branch} recorded action disagrees with the committed scenario`);
  }
  if (body('action-draw-disclosed')['uBitsHex'] !== input.disclosure.uBitsHex) {
    fail(`${input.branch} transcript disclosure disagrees with the draw record`);
  }
}

function verifyTreatmentBatch(batch: Lv01LedgerTreatmentBatch): void {
  const caseIds = batch.cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) fail('treatment batch case identities collide');
  for (const entry of batch.cases) {
    if (entry.shuffledSourceCaseId === entry.caseId) fail(`treatment batch case ${entry.caseId} keeps its own selection`);
    if (entry.identicalTokenCoincidence !== (entry.shuffledDeliveredToken === entry.selectedToken)) {
      fail(`treatment batch case ${entry.caseId} misreports its token coincidence`);
    }
  }
}

/**
 * Audit one seven-branch paired case against the registered plan and raw
 * records. Returns the v2 case commitment over the reconstructed record.
 */
export function auditLv01PairedCase(input: {
  readonly plan: Lv01PairedCasePlan;
  readonly shared: Lv01AuditSharedInput;
  readonly branches: readonly Lv01AuditedBranch[];
}): { caseCommitment: string } {
  if (input.branches.length !== LV01_BRANCHES.length || input.plan.branches.length !== LV01_BRANCHES.length) {
    fail('audit requires all seven planned and evidenced branches');
  }
  const preState = recomputedPreState(input.shared.parent);
  if (preState !== input.plan.preStateCommitment) fail('registered pre-state does not match the parent bundle');
  verifyTreatmentBatch(input.shared.treatmentBatch);

  const first = input.branches[0]!;
  const scopeOf = (branch: Lv01Branch): Lv01ActionDrawScope & { drawSeedCommitment: string } => {
    const planned = input.plan.branches.find((entry) => entry.branch === branch)?.config.lv01PairedCase;
    if (planned?.actionDraw === undefined) fail(`plan has no draw scope for ${branch}`);
    return planned.actionDraw;
  };
  const firstScope = scopeOf(first.branch);
  const scopeKey = (scope: Lv01ActionDrawScope): string =>
    [scope.stage, scope.slotKind, scope.slotIndex, scope.partition, scope.receiverRole, scope.caseId].join('|');

  for (let index = 0; index < input.branches.length; index += 1) {
    const branch = input.branches[index]!;
    if (branch.branch !== LV01_BRANCHES[index]) fail('audited branches arrive out of order');
    const planned = input.plan.branches[index]!;
    if (planned.branch !== branch.branch) fail('plan and evidence disagree on branch order');
    if (branch.runId !== planned.config.runId) fail(`${branch.branch} run identity disagrees with the plan`);
    const pairedCase = planned.config.lv01PairedCase;
    if (pairedCase === undefined || pairedCase.branch !== branch.branch) fail(`${branch.branch} plan section is missing or swapped`);
    if (pairedCase.preStateCommitment !== preState) fail(`${branch.branch} plan pre-state is stale`);
    if (pairedCase.predictionTreatment !== branch.payload.predictionTreatment) {
      fail(`${branch.branch} payload treatment disagrees with the plan`);
    }
    if (!branch.runId.endsWith(`-${branch.branch}`)) fail(`${branch.branch} run identity carries no branch suffix`);
    const prefix = branch.runId.slice(0, -(branch.branch.length + 1));
    const scope = scopeOf(branch.branch);
    if (scopeKey(scope) !== scopeKey(firstScope)) fail('draw scope differs between branches');
    if (scope.caseId !== `${prefix}:turn:0`) fail(`${branch.branch} draw scope case identity is foreign`);
    if (branch.payload.caseId !== `${branch.runId}:turn:0`) fail(`${branch.branch} payload case identity is foreign`);
    if (branch.payload.turn !== 0) fail(`${branch.branch} is not the registered turn-0 evaluation`);
    if (branch.payload.receiver !== scope.receiverRole) fail(`${branch.branch} receiver disagrees with the draw scope`);
    if (branch.drawSeed !== first.drawSeed) fail('branches do not share one draw seed');

    // Shared case records: identical order, scenario, policy, schedule, and fit.
    const reference = first.payload;
    if (
      !sameStrings(branch.payload.candidateRefs, reference.candidateRefs) ||
      !sameNumbers(branch.payload.candidateTypeCodes, reference.candidateTypeCodes)
    ) {
      fail(`${branch.branch} candidate order disagrees with the case`);
    }
    if (
      branch.payload.state.scenarioStateHash !== reference.state.scenarioStateHash ||
      branch.payload.state.receiverPolicyHash !== reference.state.receiverPolicyHash ||
      branch.payload.scheduleDigest !== reference.scheduleDigest ||
      branch.payload.ordinary.id !== reference.ordinary.id ||
      branch.payload.ordinary.fitDigest !== reference.ordinary.fitDigest
    ) {
      fail(`${branch.branch} shared case records disagree with the case`);
    }
  }

  const audited = input.branches.map((branch) => {
    const receiver = branch.payload.receiver;
    if (receiver !== 'baby-a' && receiver !== 'baby-b') fail(`${branch.branch} receiver role is invalid`);
    const streams = branch.payload.receiver === 'baby-a' ? branch.ledgerEvents.babyA : branch.ledgerEvents.babyB;
    const records = mapLv01LedgerAssociations(streams, receiver, input.shared.authenticate);
    for (const record of records) {
      if (record.sequence > branch.payload.cutoff.sequence || record.turn > branch.payload.cutoff.turn) {
        fail(`${branch.branch} training ledger reaches past the committed cutoff`);
      }
    }
    const heads = branch.payload.state.trainingLedgerHeads;
    if (
      !sameStrings(heads.babyA, branch.ledgerEvents.babyA.map((event) => event.entryHash)) ||
      !sameStrings(heads.babyB, branch.ledgerEvents.babyB.map((event) => event.entryHash))
    ) {
      fail(`${branch.branch} ledger heads disagree with the raw ledger streams`);
    }
    verifyLv01PairedPredictionPayload(
      branch.payload,
      branch.predictionCommitment,
      { ledgerRecords: records, frozenModel: input.shared.frozenModel, symbolInventory: input.shared.symbolInventory },
    );
    verifyLv01OrdinaryTranscriptMatch({
      id: branch.payload.ordinary.id,
      fit: branch.payload.ordinary.fit,
      inventory: input.shared.symbolInventory,
      records: [{
        caseId: branch.payload.caseId,
        receiverRole: receiver,
        deliveredToken: branch.payload.deliveredToken,
        candidateTypeCodes: branch.payload.candidateTypeCodes,
        committedDistribution: branch.payload.ordinary.distribution,
      }],
    });

    const planned = input.plan.branches.find((entry) => entry.branch === branch.branch)!;
    const isLedgerBranch = planned.predictionTreatment !== 'ordinary-records';
    if (isLedgerBranch) {
      if (branch.treatmentSlice === undefined) fail(`${branch.branch} delivers with no committed slice`);
      const plannedSlice = planned.config.lv01PairedCase?.ledgerTreatment;
      if (
        plannedSlice === undefined ||
        plannedSlice.selectedToken !== branch.treatmentSlice.selectedToken ||
        plannedSlice.deliveredToken !== branch.treatmentSlice.deliveredToken ||
        plannedSlice.batchCommitment !== branch.treatmentSlice.batchCommitment ||
        plannedSlice.sourceCaseId !== branch.treatmentSlice.sourceCaseId
      ) {
        fail(`${branch.branch} evidence slice disagrees with the registered plan slice`);
      }
      verifyLedgerTreatmentSlice(input.shared.treatmentBatch, branch.payload.caseId, branch.branch, branch.treatmentSlice);
      if (branch.payload.deliveredToken !== branch.treatmentSlice.deliveredToken) {
        fail(`${branch.branch} committed token disagrees with its treatment slice`);
      }
    } else {
      if (branch.treatmentSlice !== undefined) fail(`${branch.branch} must not carry a ledger-treatment slice`);
      if ((branch.payload.deliveredToken === null) !== (branch.branch === 'disabled')) {
        fail(`${branch.branch} null-token rule is violated`);
      }
    }

    const scope = scopeOf(branch.branch);
    assertLv01ActionDrawScope(scope);
    const seed = deriveLv01ActionDrawSeed(input.shared.parent.parentRandomSeed, scope);
    if (seed !== branch.drawSeed) fail(`${branch.branch} draw seed is not the registered derivation`);
    const draw = recomputedDrawCommitment({
      drawSeed: branch.drawSeed,
      turn: branch.payload.turn,
      receiver,
      candidateRefs: branch.disclosure.candidateRefs,
      preStateCommitment: preState,
      uBitsHex: branch.disclosure.uBitsHex,
    });
    if (draw.drawSeedCommitment !== scope.drawSeedCommitment) fail(`${branch.branch} draw seed commitment is foreign`);
    if (draw.drawCommitment !== branch.drawCommitment) fail(`${branch.branch} draw commitment does not match its inputs`);
    if (!sameStrings(branch.disclosure.candidateRefs, branch.payload.candidateRefs)) {
      fail(`${branch.branch} disclosure reorders the committed candidates`);
    }
    if (unitBitsHex(drawLv01SharedUnit(branch.drawSeed, branch.payload.turn)) !== branch.disclosure.uBitsHex) {
      fail(`${branch.branch} disclosed unit value does not match the draw seed`);
    }
    verifyLv01ActionDraw({ drawSeed: branch.drawSeed, turn: branch.payload.turn, disclosure: branch.disclosure });
    if (planned.communicationCondition === 'normal') {
      if (branch.payload.replay === null) fail(`${branch.branch} normal-condition sampling has no replay vector`);
      if (!sameNumbers(branch.disclosure.probs, branch.payload.replay.distribution)) {
        fail(`${branch.branch} sampling vector is not the replayed policy response`);
      }
    }

    verifyTranscript({
      branch: branch.branch,
      transcript: branch.transcript,
      parent: input.shared.parent,
      predictionCommitment: branch.predictionCommitment,
      drawCommitment: branch.drawCommitment,
      payload: branch.payload,
      disclosure: branch.disclosure,
    });
    return {
      branch: branch.branch,
      runId: branch.runId,
      caseId: branch.payload.caseId,
      predictionCommitment: branch.predictionCommitment,
      drawCommitment: branch.drawCommitment,
      deliveredToken: branch.payload.deliveredToken,
      selectedCandidateRef: branch.disclosure.selectedCandidateRef,
    };
  });

  return {
    caseCommitment: hashCanonical(LV01_AUDIT_CASE_DOMAIN, {
      preStateCommitment: preState,
      scopeCaseId: firstScope.caseId,
      branches: audited,
    }),
  };
}
