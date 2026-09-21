/**
 * LV01's exact frozen-policy replay reference.
 *
 * This module intentionally does not reuse the historical tabular predictor:
 * LV01 binds a 4,049-parameter recurrent receiver. Every call restores an
 * isolated model from the exported checkpoint and scores without advancing its
 * hidden state, so replay cannot mutate a live learner or become a frequency
 * table standing in for the registered policy.
 */
import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import { argmaxIndex } from './game.js';
import {
  ExportedRecurrentModelSchema,
  RecurrentCommunicationModel,
  type ExportedRecurrentModel,
} from './recurrent-model.js';

export const LV01_PREDICTION_FUNCTION_VERSION =
  'lv01-ledger-value-prediction/v1' as const;

export const LV01_PARAMETER_COUNT = 4_049;
export const LV01_TYPE_COUNT = 16;
export const LV01_SYMBOL_COUNT = 32;
export const LV01_CANDIDATE_COUNT = 4;

export interface Lv01RecurrentReplayPrediction {
  readonly predictionFunctionVersion: typeof LV01_PREDICTION_FUNCTION_VERSION;
  /** The receiver's actual candidate order, never a canonicalized type order. */
  readonly candidateTypeCodes: readonly number[];
  /** Probability of each candidate in that same order. */
  readonly distribution: readonly number[];
  /** Argmax index in `candidateTypeCodes`, with lowest-index ties. */
  readonly selectedCandidateIndex: number;
  readonly parameterCount: typeof LV01_PARAMETER_COUNT;
}

export const LV01_NATIVE_ASSOCIATION_EVENT_TYPES = [
  'hypothesis.created',
  'hypothesis.revised',
  'hypothesis.contradicted',
] as const;

export type Lv01NativeAssociationEventType =
  (typeof LV01_NATIVE_ASSOCIATION_EVENT_TYPES)[number];

/** A verified, receiver-private training-ledger association record. */
export interface Lv01TrainingLedgerAssociation {
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly eventType: Lv01NativeAssociationEventType;
  /** Verified per-receiver ledger sequence, never filesystem ordering. */
  readonly sequence: number;
  readonly turn: number;
  readonly eventHash: string;
  readonly policyContextHash: string;
  readonly authenticated: boolean;
  readonly token: string;
  /** One nonnegative association weight per LV01 type code. */
  readonly associationOverTypeCodes: readonly number[];
}

export interface Lv01TrainingLedgerCutoff {
  readonly sequence: number;
  readonly turn: number;
}

export interface Lv01SelectedLedgerAssociation {
  readonly token: string;
  readonly eventHash: string;
  readonly sequence: number;
  readonly turn: number;
  readonly policyContextHash: string;
  readonly associationAgeTurns: number;
  readonly associationOverTypeCodes: readonly number[];
}

export interface Lv01NativeLedgerIndex {
  readonly predictionFunctionVersion: typeof LV01_PREDICTION_FUNCTION_VERSION;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly cutoff: Lv01TrainingLedgerCutoff;
  /** One latest qualifying association per token, ordered by token. */
  readonly selectedAssociations: readonly Lv01SelectedLedgerAssociation[];
}

export interface Lv01NativeLedgerPrediction {
  readonly predictionFunctionVersion: typeof LV01_PREDICTION_FUNCTION_VERSION;
  readonly candidateTypeCodes: readonly number[];
  readonly distribution: readonly number[];
  readonly source: 'training-ledger' | 'uniform-missing-token' | 'uniform-disabled';
  readonly selectedAssociation?: Lv01SelectedLedgerAssociation;
}

const LV01_NATIVE_EPSILON = 1e-12;

function isNativeAssociationEventType(value: unknown): value is Lv01NativeAssociationEventType {
  return (
    typeof value === 'string' &&
    (LV01_NATIVE_ASSOCIATION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

function assertLv01CandidateTypes(candidateTypeCodes: readonly number[]): void {
  if (candidateTypeCodes.length !== LV01_CANDIDATE_COUNT) {
    throw new LearnerConfigurationError(
      `LV01 requires exactly ${LV01_CANDIDATE_COUNT} candidate types`,
    );
  }
  if (new Set(candidateTypeCodes).size !== candidateTypeCodes.length) {
    throw new LearnerConfigurationError('LV01 candidate types must be distinct');
  }
  for (const typeCode of candidateTypeCodes) {
    if (!Number.isInteger(typeCode) || typeCode < 0 || typeCode >= LV01_TYPE_COUNT) {
      throw new LearnerConfigurationError(
        `LV01 candidate type ${String(typeCode)} is outside [0, ${LV01_TYPE_COUNT})`,
      );
    }
  }
}

function assertLv01Model(model: ExportedRecurrentModel): void {
  const { options } = model;
  if (
    options.typeCount !== LV01_TYPE_COUNT ||
    options.symbolCount !== LV01_SYMBOL_COUNT ||
    options.messageLength !== 1 ||
    options.hiddenSize !== 16 ||
    options.inputSize !== 50 ||
    options.senderOutputSize !== 32 ||
    options.receiverOutputSize !== 16 ||
    model.parameterCount !== LV01_PARAMETER_COUNT
  ) {
    throw new LearnerConfigurationError(
      'recurrent policy does not match the frozen LV01 architecture',
    );
  }
}

function symbolIndex(
  token: string,
  symbolInventory: readonly string[],
): number {
  if (symbolInventory.length !== LV01_SYMBOL_COUNT) {
    throw new LearnerConfigurationError(
      `LV01 requires exactly ${LV01_SYMBOL_COUNT} inventory tokens`,
    );
  }
  if (new Set(symbolInventory).size !== symbolInventory.length) {
    throw new LearnerConfigurationError('LV01 inventory tokens must be distinct');
  }
  const index = symbolInventory.indexOf(token);
  if (index < 0) {
    throw new LearnerStateError('delivered token is absent from the LV01 inventory');
  }
  return index;
}

function assertTrainingCutoff(cutoff: Lv01TrainingLedgerCutoff): void {
  if (!Number.isInteger(cutoff.sequence) || cutoff.sequence < 1) {
    throw new LearnerConfigurationError('LV01 ledger cutoff sequence must be positive');
  }
  if (!Number.isInteger(cutoff.turn) || cutoff.turn < 0) {
    throw new LearnerConfigurationError('LV01 ledger cutoff turn must be non-negative');
  }
}

function uniformPrediction(
  candidateTypeCodes: readonly number[],
  source: Extract<
    Lv01NativeLedgerPrediction['source'],
    'uniform-missing-token' | 'uniform-disabled'
  >,
): Lv01NativeLedgerPrediction {
  return {
    predictionFunctionVersion: LV01_PREDICTION_FUNCTION_VERSION,
    candidateTypeCodes: [...candidateTypeCodes],
    distribution: Array.from(
      { length: candidateTypeCodes.length },
      () => 1 / candidateTypeCodes.length,
    ),
    source,
  };
}

/**
 * Read the latest usable association for every token from a verified training
 * prefix. Post-cutoff records are deliberately ignored before validation so a
 * later event cannot change a prospective prediction or turn an old prefix
 * into an integrity failure.
 */
export function indexLv01TrainingLedger(
  records: readonly Lv01TrainingLedgerAssociation[],
  receiverRole: 'baby-a' | 'baby-b',
  cutoff: Lv01TrainingLedgerCutoff,
): Lv01NativeLedgerIndex {
  assertTrainingCutoff(cutoff);
  const preCutoff = records
    .filter((record) => record.receiverRole === receiverRole && record.sequence <= cutoff.sequence)
    .sort((left, right) => left.sequence - right.sequence);
  const selected = new Map<string, Lv01SelectedLedgerAssociation>();
  const seenSequences = new Set<number>();

  for (const record of preCutoff) {
    if (seenSequences.has(record.sequence)) {
      throw new LearnerStateError(
        `LV01 training ledger has duplicate sequence ${String(record.sequence)}`,
      );
    }
    seenSequences.add(record.sequence);
    if (!isNativeAssociationEventType(record.eventType)) {
      throw new LearnerStateError('LV01 training ledger has an unsupported association event');
    }
    if (!record.authenticated) {
      throw new LearnerStateError('LV01 training ledger association is unauthenticated');
    }
    if (
      !Number.isInteger(record.sequence) ||
      record.sequence < 1 ||
      !Number.isInteger(record.turn) ||
      record.turn < 0 ||
      record.turn > cutoff.turn ||
      record.eventHash.length === 0 ||
      record.policyContextHash.length === 0 ||
      record.token.length === 0
    ) {
      throw new LearnerStateError('LV01 training ledger association has invalid provenance');
    }
    if (
      record.associationOverTypeCodes.length !== LV01_TYPE_COUNT ||
      record.associationOverTypeCodes.some(
        (weight) => !Number.isFinite(weight) || weight < 0,
      )
    ) {
      throw new LearnerStateError('LV01 training ledger association has invalid weights');
    }
    selected.set(record.token, {
      token: record.token,
      eventHash: record.eventHash,
      sequence: record.sequence,
      turn: record.turn,
      policyContextHash: record.policyContextHash,
      associationAgeTurns: cutoff.turn - record.turn,
      associationOverTypeCodes: [...record.associationOverTypeCodes],
    });
  }

  return {
    predictionFunctionVersion: LV01_PREDICTION_FUNCTION_VERSION,
    receiverRole,
    cutoff: { ...cutoff },
    selectedAssociations: [...selected.values()].sort((left, right) =>
      left.token.localeCompare(right.token),
    ),
  };
}

/**
 * Produce LV01's native four-candidate distribution from the training-only
 * index. It has no outcome, target, or live-policy input: those belong to
 * later scoring and causal analyses, never this prospective predictor.
 */
export function predictLv01NativeLedger(
  index: Lv01NativeLedgerIndex,
  deliveredToken: string | null,
  candidateTypeCodes: readonly number[],
): Lv01NativeLedgerPrediction {
  assertLv01CandidateTypes(candidateTypeCodes);
  if (deliveredToken === null) {
    return uniformPrediction(candidateTypeCodes, 'uniform-disabled');
  }
  const association = index.selectedAssociations.find(
    (entry) => entry.token === deliveredToken,
  );
  if (association === undefined) {
    return uniformPrediction(candidateTypeCodes, 'uniform-missing-token');
  }
  const weights = candidateTypeCodes.map(
    (typeCode) =>
      (association.associationOverTypeCodes[typeCode] as number) +
      LV01_NATIVE_EPSILON,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const distribution = weights.map((weight) => weight / total);
  if (!distribution.every(Number.isFinite)) {
    throw new LearnerStateError('LV01 native ledger produced a non-finite probability');
  }
  return {
    predictionFunctionVersion: LV01_PREDICTION_FUNCTION_VERSION,
    candidateTypeCodes: [...candidateTypeCodes],
    distribution,
    source: 'training-ledger',
    selectedAssociation: association,
  };
}

/**
 * Reconstruct the registered recurrent receiver from a frozen checkpoint and
 * score a one-token LV01 delivery. This function owns a fresh model instance;
 * it neither receives nor mutates a live learner.
 */
export function replayLv01RecurrentReceiver(
  frozenModel: unknown,
  deliveredToken: string,
  symbolInventory: readonly string[],
  candidateTypeCodes: readonly number[],
): Lv01RecurrentReplayPrediction {
  const exportedModel = ExportedRecurrentModelSchema.parse(frozenModel);
  assertLv01Model(exportedModel);
  assertLv01CandidateTypes(candidateTypeCodes);

  const restored = new RecurrentCommunicationModel(
    'lv01/replay-isolated-instance',
    exportedModel.options,
  );
  restored.restore(exportedModel);
  const before = JSON.stringify(restored.export());
  const distribution = restored.predictCandidates(
    [symbolIndex(deliveredToken, symbolInventory)],
    candidateTypeCodes,
    1,
  );
  if (!distribution.every(Number.isFinite)) {
    throw new LearnerStateError('LV01 recurrent replay produced a non-finite probability');
  }
  const total = distribution.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-12) {
    throw new LearnerStateError('LV01 recurrent replay probabilities do not sum to one');
  }
  if (JSON.stringify(restored.export()) !== before) {
    throw new LearnerStateError('LV01 recurrent replay advanced frozen model state');
  }

  return {
    predictionFunctionVersion: LV01_PREDICTION_FUNCTION_VERSION,
    candidateTypeCodes: [...candidateTypeCodes],
    distribution,
    selectedCandidateIndex: argmaxIndex(distribution),
    parameterCount: LV01_PARAMETER_COUNT,
  };
}
