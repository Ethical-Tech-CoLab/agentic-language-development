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
