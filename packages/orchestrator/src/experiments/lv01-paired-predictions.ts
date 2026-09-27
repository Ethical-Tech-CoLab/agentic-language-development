/**
 * LV01 paired-case pre-action prediction commitment with durable vectors.
 *
 * The runtime calls {@link buildLv01PairedPredictionPayload} after the Gateway
 * fixes the delivered artifact and before the receiver acts. The payload
 * carries the actual frozen native, ordinary-record, and replay probability
 * vectors — not just the input hashes the v1 digest bound — so the independent
 * auditor can re-derive every vector from committed inputs and reject forgeries.
 */
import {
  scoreLv01OrdinaryFit,
  type Lv01OrdinaryFit,
  type Lv01OrdinaryPredictorId,
} from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';
import {
  LV01_PREDICTION_FUNCTION_VERSION,
  indexLv01TrainingLedger,
  predictLv01NativeLedger,
  replayLv01RecurrentReceiver,
  type Lv01NativeLedgerPrediction,
  type Lv01RecurrentReplayPrediction,
  type Lv01TrainingLedgerAssociation,
  type Lv01TrainingLedgerCutoff,
} from '@ald/learners';
import type { BabyRole, LedgerEvent } from '@ald/types';

import type { Lv01Branch } from './ledger-value.js';

export const LV01_PAIRED_PREDICTION_COMMITMENT_DOMAIN =
  'lv01-paired-pre-action-prediction/v2' as const;
export const LV01_ORDINARY_FIT_DOMAIN = 'lv01-ordinary-fit/v1' as const;
export const LV01_MESSAGE_SCHEDULE_DOMAIN = 'lv01-message-schedule/v1' as const;

function fail(message: string): never {
  throw new Error(`LV01 paired prediction: ${message}`);
}

/** Resolves whether one ledger event is authenticated (signature verified). */
export type Lv01LedgerAuthenticate = (event: LedgerEvent) => boolean;

const NATIVE_EVENT_TYPES = new Set([
  'hypothesis.created',
  'hypothesis.revised',
  'hypothesis.contradicted',
]);

function tokenFromSubject(subjectId: string, termRef: unknown): string {
  const match = /^symbol:(.+)$/u.exec(subjectId);
  if (!match?.[1]) fail(`association subject ${subjectId} is not a symbol reference`);
  if (termRef !== undefined && termRef !== subjectId) {
    fail('association termRef disagrees with its subject');
  }
  return match[1];
}

/**
 * Map verified receiver ledger events to native-predictor training records.
 * Only hypothesis records qualify; checkpoint events supply policy context.
 * `policyContextHash` is the latest `policy.checkpointed` entry at or before
 * the association, else the association's own `previousEntryHash` (genesis
 * policy context before the first checkpoint). Deterministic in its inputs.
 */
export function mapLv01LedgerAssociations(
  events: readonly LedgerEvent[],
  receiverRole: 'baby-a' | 'baby-b',
  authenticate: Lv01LedgerAuthenticate,
): Lv01TrainingLedgerAssociation[] {
  const checkpoints = events
    .filter((event) => event.eventType === 'policy.checkpointed')
    .sort((left, right) => left.sequence - right.sequence);
  const records: Lv01TrainingLedgerAssociation[] = [];
  for (const event of events) {
    if (!NATIVE_EVENT_TYPES.has(event.eventType)) continue;
    const content = event.content as Record<string, unknown>;
    const weights = content['associationOverTypeCodes'];
    if (!Array.isArray(weights)) fail(`association at sequence ${event.sequence} has no weight vector`);
    let preceding: LedgerEvent | undefined;
    for (const checkpoint of checkpoints) {
      if (checkpoint.sequence <= event.sequence) preceding = checkpoint;
      else break;
    }
    records.push({
      receiverRole,
      eventType: event.eventType as Lv01TrainingLedgerAssociation['eventType'],
      sequence: event.sequence,
      turn: event.turn,
      eventHash: event.entryHash,
      policyContextHash: preceding?.entryHash ?? event.previousEntryHash,
      authenticated: authenticate(event),
      token: tokenFromSubject(event.subjectId, content['termRef']),
      associationOverTypeCodes: weights as readonly number[],
    });
  }
  return records.sort((left, right) => left.sequence - right.sequence);
}

/**
 * The training cutoff is the maximum over mapped receiver hypothesis records.
 * Hypothesis records are written only by `updatePolicy`, which evaluation
 * disables, so no evaluation turn can extend this cutoff; the verifier
 * re-derives the same maximum from the same filtered set.
 */
export function deriveLv01LedgerCutoff(
  records: readonly Lv01TrainingLedgerAssociation[],
): Lv01TrainingLedgerCutoff {
  if (records.length === 0) fail('training ledger has no mapped associations');
  return {
    sequence: Math.max(...records.map((record) => record.sequence)),
    turn: Math.max(...records.map((record) => record.turn)),
  };
}

export interface Lv01PairedPredictionState {
  readonly scenarioStateHash: string;
  readonly receiverPolicyHash: string;
  readonly trainingLedgerHeads: {
    readonly babyA: readonly string[];
    readonly babyB: readonly string[];
  };
}

export interface Lv01PairedPredictionBuildInput {
  readonly branch: Lv01Branch;
  readonly predictionTreatment: 'ordinary-records' | 'ledger-consistent' | 'ledger-shuffled';
  readonly turn: number;
  readonly receiver: BabyRole;
  readonly caseId: string;
  readonly candidateRefs: readonly string[];
  readonly candidateTypeCodes: readonly number[];
  readonly deliveredToken: string | null;
  readonly symbolInventory: readonly string[];
  readonly ledgerRecords: readonly Lv01TrainingLedgerAssociation[];
  readonly cutoff: Lv01TrainingLedgerCutoff;
  /** Exported recurrent `model` block behind `receiverPolicyHash`. Tabular exports fail. */
  readonly frozenModel: unknown;
  readonly ordinaryId: Lv01OrdinaryPredictorId;
  readonly ordinaryFit: Lv01OrdinaryFit;
  readonly state: Lv01PairedPredictionState;
  readonly scheduleDigest: string;
}

export interface Lv01PairedPredictionPayload {
  readonly version: 1;
  readonly predictionFunctionVersion: typeof LV01_PREDICTION_FUNCTION_VERSION;
  readonly branch: Lv01Branch;
  readonly predictionTreatment: Lv01PairedPredictionBuildInput['predictionTreatment'];
  readonly turn: number;
  readonly receiver: BabyRole;
  readonly caseId: string;
  readonly candidateRefs: readonly string[];
  readonly candidateTypeCodes: readonly number[];
  readonly deliveredToken: string | null;
  readonly scheduleDigest: string;
  readonly cutoff: Lv01TrainingLedgerCutoff;
  readonly native: Lv01NativeLedgerPrediction;
  readonly ordinary: {
    readonly id: Lv01OrdinaryPredictorId;
    readonly distribution: readonly number[];
    readonly fitDigest: string;
    readonly fit: Lv01OrdinaryFit;
  };
  readonly replay: Lv01RecurrentReplayPrediction | null;
  readonly state: Lv01PairedPredictionState;
}

function assertCandidateRefs(candidateRefs: readonly string[]): void {
  if (candidateRefs.length !== 4 || new Set(candidateRefs).size !== 4) {
    fail('candidate references must be four distinct strings');
  }
}

export function buildLv01PairedPredictionPayload(
  input: Lv01PairedPredictionBuildInput,
): { payload: Lv01PairedPredictionPayload; commitment: string } {
  assertCandidateRefs(input.candidateRefs);
  if (input.caseId.length === 0) fail('case identity is empty');
  if (
    input.deliveredToken !== null &&
    !input.symbolInventory.includes(input.deliveredToken)
  ) {
    fail('delivered token is outside the frozen inventory');
  }
  const receiverRole = input.receiver === 'baby-a' || input.receiver === 'baby-b'
    ? input.receiver
    : fail('receiver role is invalid');
  const index = indexLv01TrainingLedger(input.ledgerRecords, receiverRole, input.cutoff);
  const native = predictLv01NativeLedger(index, input.deliveredToken, input.candidateTypeCodes);
  const ordinaryDistribution = scoreLv01OrdinaryFit(
    input.ordinaryId,
    input.ordinaryFit,
    {
      caseId: input.caseId,
      receiverRole,
      deliveredToken: input.deliveredToken,
      candidateTypeCodes: input.candidateTypeCodes,
    },
    input.symbolInventory,
  );
  const ordinaryFitDigest = hashCanonical(LV01_ORDINARY_FIT_DOMAIN, {
    id: input.ordinaryId,
    fit: input.ordinaryFit,
  });
  const replay = input.deliveredToken === null
    ? null
    : replayLv01RecurrentReceiver(
      input.frozenModel,
      input.deliveredToken,
      input.symbolInventory,
      input.candidateTypeCodes,
    );
  const payload: Lv01PairedPredictionPayload = {
    version: 1,
    predictionFunctionVersion: LV01_PREDICTION_FUNCTION_VERSION,
    branch: input.branch,
    predictionTreatment: input.predictionTreatment,
    turn: input.turn,
    receiver: input.receiver,
    caseId: input.caseId,
    candidateRefs: [...input.candidateRefs],
    candidateTypeCodes: [...input.candidateTypeCodes],
    deliveredToken: input.deliveredToken,
    scheduleDigest: input.scheduleDigest,
    cutoff: { ...input.cutoff },
    native,
    ordinary: {
      id: input.ordinaryId,
      distribution: [...ordinaryDistribution],
      fitDigest: ordinaryFitDigest,
      fit: input.ordinaryFit,
    },
    replay,
    state: input.state,
  };
  return {
    payload,
    commitment: hashCanonical(LV01_PAIRED_PREDICTION_COMMITMENT_DOMAIN, payload),
  };
}

export interface Lv01PairedPredictionAuditInput {
  readonly ledgerRecords: readonly Lv01TrainingLedgerAssociation[];
  readonly frozenModel: unknown;
  readonly symbolInventory: readonly string[];
}

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Independently re-derive every committed vector and the commitment digest.
 * Rejects forged vectors, moved cutoffs, swapped candidate orders, and any
 * digest mismatch. Never trusts collector-supplied flags.
 */
export function verifyLv01PairedPredictionPayload(
  payload: Lv01PairedPredictionPayload,
  commitment: string,
  input: Lv01PairedPredictionAuditInput,
): void {
  if (payload.predictionFunctionVersion !== LV01_PREDICTION_FUNCTION_VERSION) {
    fail('prediction function version is not the registered LV01 version');
  }
  const derivedCutoff = deriveLv01LedgerCutoff(input.ledgerRecords);
  if (
    derivedCutoff.sequence !== payload.cutoff.sequence ||
    derivedCutoff.turn !== payload.cutoff.turn
  ) {
    fail('committed cutoff does not match the mapped training records');
  }
  const rebuilt = buildLv01PairedPredictionPayload({
    branch: payload.branch,
    predictionTreatment: payload.predictionTreatment,
    turn: payload.turn,
    receiver: payload.receiver,
    caseId: payload.caseId,
    candidateRefs: payload.candidateRefs,
    candidateTypeCodes: payload.candidateTypeCodes,
    deliveredToken: payload.deliveredToken,
    symbolInventory: input.symbolInventory,
    ledgerRecords: input.ledgerRecords,
    cutoff: payload.cutoff,
    frozenModel: input.frozenModel,
    ordinaryId: payload.ordinary.id,
    ordinaryFit: payload.ordinary.fit,
    state: payload.state,
    scheduleDigest: payload.scheduleDigest,
  });
  if (!sameNumbers(rebuilt.payload.native.distribution, payload.native.distribution)) {
    fail('native vector does not match its committed inputs');
  }
  if (rebuilt.payload.native.source !== payload.native.source) {
    fail('native vector source does not match its committed inputs');
  }
  if (!sameNumbers(rebuilt.payload.ordinary.distribution, payload.ordinary.distribution)) {
    fail('ordinary vector does not match its committed inputs');
  }
  if (rebuilt.payload.ordinary.fitDigest !== payload.ordinary.fitDigest) {
    fail('ordinary fit digest does not match its committed fit');
  }
  if (
    (rebuilt.payload.replay === null) !== (payload.replay === null) ||
    (rebuilt.payload.replay !== null && payload.replay !== null &&
      !sameNumbers(rebuilt.payload.replay.distribution, payload.replay.distribution))
  ) {
    fail('replay vector does not match its committed inputs');
  }
  if (rebuilt.commitment !== commitment) {
    fail('commitment digest does not match the persisted payload');
  }
}

/** Outcome-blind ordinary-record input bound by the study collector. */
export interface Lv01PairedPredictionProvider {
  readonly ordinaryId: Lv01OrdinaryPredictorId;
  readonly ordinaryFit: Lv01OrdinaryFit;
}
