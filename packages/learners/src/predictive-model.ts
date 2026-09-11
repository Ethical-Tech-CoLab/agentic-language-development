/**
 * The trainable predictive models behind the `self-supervised` (ALD-046) and
 * `hybrid` (ALD-047) tracks.
 *
 * SPEC §6.1 defines `self-supervised` as "randomly initialized
 * encoder/policy trained only to predict observations/partner behavior, no
 * scalar reward", and §6.7 asks for "the same backbone as `scratch-rl`,
 * predictive/contrastive loss in place of a scalar reward". SPEC §6.2 adds
 * that the tracks must be "expressible as variants of the same adapter
 * interface and, where feasible, the same recurrent backbone, differing only
 * in the reward/update-rule fields of `UpdateBatch`". This module is the
 * tabular special case of that backbone, mirroring what
 * `tabular-reinforce.ts` does for `scratch-rl`: state small enough to
 * canonicalize, hash, diff and read in evidence, behind the same seam a
 * recurrent model would sit behind.
 *
 * `PredictiveCountModel` is the pre-registered predictive loss of E12,
 * named once here and recorded verbatim in every exported policy
 * (`PREDICTIVE_LOSS_DEFINITION`, ALD-046 cb 3 "the evidence bundle records the
 * loss definition"):
 *
 *   cross-entropy of the partner's message under a positional
 *   co-occurrence model of P(message | candidate features)
 *
 * It holds one non-negative weight per `(message position, feature code,
 * symbol index)` triple. A folded `(feature, message)` pair adds
 * `countIncrement` to the weights on its own path; probabilities are the
 * Laplace-smoothed normalization of those weights. The loss is minimized by
 * exactly that count update, so "the update" and "the loss" are the same
 * object rather than two things that have to be kept consistent.
 *
 * The model is used symmetrically, which is what makes it a *mutual*
 * prediction model rather than a decoder:
 *
 * - as a receiver, `candidatePosterior` scores each offered candidate by how
 *   probable the message it actually received would be for that candidate's
 *   features, and the adapter selects the argmax;
 * - as a sender, `symbolProbabilities` is read as "what message would a
 *   partner produce for these features", and the adapter emits (or samples)
 *   from it.
 *
 * Nothing in this module reads, stores, or is shaped by a task outcome. There
 * is deliberately no `success`, `reward`, or `outcome` field anywhere in
 * `PredictiveCountModel` or in what it exports; `packages/learners/__tests__/
 * self-supervised.test.ts` asserts that structurally (ALD-046 cb 3 "proves
 * that outcome labels are not included").
 *
 * `PayloadMeanModel` is the second head of the `hybrid` world model — the
 * approved nonverbal outcome payload both Babies receive (SPEC §8.1 step 7).
 * It exists only for the `hybrid` track, which is allowed a task signal; the
 * `self-supervised` adapter never constructs one.
 *
 * Weights are rounded to `POLICY_DECIMALS` after every update rather than only
 * at export, so a model restored from a checkpoint continues from bit-identical
 * state and a derived run (SPEC §7.4) reproduces the parent's policy hashes.
 */
import { HASH_DOMAINS, type Sha256Hash } from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';
import { z } from 'zod';

import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import { roundAll, roundTo } from './game.js';
import { POLICY_DECIMALS } from './policy.js';
import {
  ExportedRecurrentModelSchema,
  RECURRENT_ARCHITECTURE,
  RECURRENT_SELF_SUPERVISED_OBJECTIVE,
  RecurrentCommunicationModel,
  type RecurrentModelOptions,
} from './recurrent-model.js';

/**
 * The pre-registered E12 loss, recorded in `exportPolicy().lossDefinition`.
 * Changing it is a pre-registration change, not a refactor: the string is
 * versioned so a sealed run names the exact objective it was trained under.
 */
export const PREDICTIVE_LOSS_DEFINITION =
  'predictive-cross-entropy:message|candidate-features:v1' as const;

/**
 * The pre-registered rule for turning one turn into one training pair.
 *
 * A sender knows the features it meant, so its pair is exact. A receiver does
 * not: it is told a message and shown candidates, and it is never told which
 * candidate was intended — being told would be an outcome label, which this
 * track must not consume (ALD-046 cb 1). The pre-registered substitute is
 * self-training: the receiver pairs the message with the candidate its own
 * current model scores highest (`candidatePosterior` argmax, ties to the
 * lowest index). That is a label-free rule; it is also a biased one, because
 * a wrong interpretation reinforces itself. No claim is made here about its
 * convergence — E12's job is to measure what it does.
 */
export const PREDICTIVE_PAIRING_RULE =
  'receiver-argmax-self-training:v1' as const;

/**
 * The `hybrid` track's `intrinsic-prediction-progress` reward
 * (SPEC §11.1 `learningSignal`), recorded in the exported policy.
 *
 * The reward for a turn is the increase in the world model's log-likelihood of
 * that turn's own `(feature, message)` pair across the update that folds it in
 * — learning progress about the partner, never the task outcome. It is
 * non-negative by construction, because folding a pair can only raise that
 * pair's likelihood under a count model.
 */
export const PREDICTION_PROGRESS_REWARD_DEFINITION =
  'prediction-progress:partner-message-log-likelihood:v1' as const;

export const PREDICTIVE_MODEL_VERSION = 1 as const;

export const PredictiveModelOptionsSchema = z
  .object({
    /** Symbols per message; one weight table per position. */
    messageLength: z.number().int().positive(),
    /** Size of the feature-code space (type codes, or encoder codes). */
    featureCount: z.number().int().positive(),
    symbolCount: z.number().int().positive(),
    /** Laplace pseudo-count added to every weight before normalizing. */
    smoothing: z.number().positive(),
    /**
     * Magnitude of the seeded random initialization. `0` gives an exactly
     * uniform predictive model; a positive value gives each Baby a distinct
     * random starting point, which is the "recorded random initialization" of
     * ALD-046 cb 1 / ALD-047 cb 1 and breaks sender/receiver symmetry at
     * initialization rather than only through sampling.
     */
    priorNoise: z.number().min(0),
    /** Weight added per folded pair; the curriculum's `learningRate` knob. */
    countIncrement: z.number().positive(),
  })
  .strict();

export type PredictiveModelOptions = z.infer<
  typeof PredictiveModelOptionsSchema
>;

export const ExportedPredictiveModelSchema = z
  .object({
    version: z.literal(PREDICTIVE_MODEL_VERSION),
    component: z.literal('predictive-message-model'),
    kind: z.literal('positional-cooccurrence-counts'),
    lossDefinition: z.literal(PREDICTIVE_LOSS_DEFINITION),
    pairingRule: z.literal(PREDICTIVE_PAIRING_RULE),
    options: PredictiveModelOptionsSchema,
    /** `[position][featureCode][symbolIndex]`, non-negative. */
    weights: z.array(z.array(z.array(z.number()))),
    /** Number of `(feature, message)` pairs folded in so far. */
    pairs: z.number().int().nonnegative(),
  })
  .strict();

export type ExportedPredictiveModel = z.infer<
  typeof ExportedPredictiveModelSchema
>;

export interface PredictiveModelInit extends PredictiveModelOptions {
  /**
   * Seed material for the random initialization. Required when
   * `priorNoise > 0`; the seed itself is never exported.
   */
  seed?: string;
}

export interface PredictiveMessageModel {
  readonly messageLength: number;
  readonly featureCount: number;
  readonly symbolCount: number;
  readonly pairs: number;
  readonly countIncrement: number;
  setCountIncrement(value: number): void;
  observe(featureCode: number, symbolIndices: readonly number[]): void;
  symbolProbabilities(position: number, featureCode: number): number[];
  messageLogProbability(
    featureCode: number,
    symbolIndices: readonly number[],
  ): number;
  candidatePosterior(
    candidateFeatureCodes: readonly number[],
    symbolIndices: readonly number[],
  ): number[];
  featurePosterior(symbolIndices: readonly number[]): number[];
  featurePosteriorForSymbol(
    symbolIndex: number,
    positions: readonly number[],
  ): number[];
  export(): ExportedPredictiveModel | ExportedRecurrentPredictiveModel;
  hash(): Sha256Hash;
  restore(value: unknown): void;
}

/**
 * Positional co-occurrence model of P(message | features), and the update that
 * minimizes `PREDICTIVE_LOSS_DEFINITION`.
 */
export class PredictiveCountModel {
  private readonly options: PredictiveModelOptions;
  private readonly weights: number[][][];
  private folded = 0;

  constructor(init: PredictiveModelInit) {
    const options = PredictiveModelOptionsSchema.parse({
      messageLength: init.messageLength,
      featureCount: init.featureCount,
      symbolCount: init.symbolCount,
      smoothing: init.smoothing,
      priorNoise: init.priorNoise,
      countIncrement: init.countIncrement,
    });
    if (options.priorNoise > 0 && init.seed === undefined) {
      throw new LearnerConfigurationError(
        'a positive priorNoise requires a seed to draw the random initialization from',
      );
    }
    this.options = options;

    const prng =
      init.seed === undefined
        ? undefined
        : new SeededPrng(init.seed).derive('predictive-model/init');
    this.weights = Array.from({ length: options.messageLength }, () =>
      Array.from({ length: options.featureCount }, () =>
        roundAll(
          Array.from({ length: options.symbolCount }, () =>
            prng === undefined || options.priorNoise === 0
              ? 0
              : prng.nextFloat() * options.priorNoise,
          ),
          POLICY_DECIMALS,
        ),
      ),
    );
  }

  get messageLength(): number {
    return this.options.messageLength;
  }

  get featureCount(): number {
    return this.options.featureCount;
  }

  get symbolCount(): number {
    return this.options.symbolCount;
  }

  /** Pairs folded in by `observe`. Never an outcome count. */
  get pairs(): number {
    return this.folded;
  }

  get countIncrement(): number {
    return this.options.countIncrement;
  }

  /** The curriculum's `learningRate` knob (E22, SPEC §18 `curriculumMode`). */
  setCountIncrement(value: number): void {
    if (!(value > 0)) {
      throw new LearnerConfigurationError('countIncrement must be positive');
    }
    this.options.countIncrement = value;
  }

  /**
   * Fold one `(feature, message)` pair in. This is the whole update rule: the
   * gradient step of `PREDICTIVE_LOSS_DEFINITION` for a count model is exactly
   * "add to the observed path".
   */
  observe(featureCode: number, symbolIndices: readonly number[]): void {
    this.requireFeature(featureCode);
    if (symbolIndices.length === 0) {
      return;
    }
    const scored = Math.min(symbolIndices.length, this.options.messageLength);
    for (let position = 0; position < scored; position += 1) {
      const symbolIndex = this.requireSymbol(at(symbolIndices, position));
      const row = this.row(position, featureCode);
      row[symbolIndex] = roundTo(
        at(row, symbolIndex) + this.options.countIncrement,
        POLICY_DECIMALS,
      );
    }
    this.folded += 1;
  }

  /** Laplace-smoothed P(symbol | features) at one message position. */
  symbolProbabilities(position: number, featureCode: number): number[] {
    const row = this.row(position, featureCode);
    let total = 0;
    const weights = row.map((weight) => {
      const value = weight + this.options.smoothing;
      total += value;
      return value;
    });
    return weights.map((weight) => weight / total);
  }

  /**
   * `log P(message | features)`, summed over the positions the model holds
   * tables for. An empty message (the SPEC §9.6 `disabled` control delivers
   * nothing) has log-probability `0`: no symbol, no evidence.
   */
  messageLogProbability(
    featureCode: number,
    symbolIndices: readonly number[],
  ): number {
    this.requireFeature(featureCode);
    const scored = Math.min(symbolIndices.length, this.options.messageLength);
    let total = 0;
    for (let position = 0; position < scored; position += 1) {
      const probabilities = this.symbolProbabilities(position, featureCode);
      total += Math.log(at(probabilities, this.requireSymbol(at(symbolIndices, position))));
    }
    return total;
  }

  /**
   * Posterior over the offered candidates: mutual prediction, i.e. the
   * candidate under which the received message is most probable. Uniform when
   * nothing was delivered.
   */
  candidatePosterior(
    candidateFeatureCodes: readonly number[],
    symbolIndices: readonly number[],
  ): number[] {
    if (candidateFeatureCodes.length === 0) {
      throw new LearnerStateError('candidateFeatureCodes must not be empty');
    }
    const logs = candidateFeatureCodes.map((featureCode) =>
      this.messageLogProbability(featureCode, symbolIndices),
    );
    return normalizeLogs(logs);
  }

  /**
   * Posterior over the whole feature space for one message — the association a
   * hypothesis event records for a symbol (CONCEPT-IDEA.md §11.2 rule 3),
   * under a uniform prior over features.
   */
  featurePosterior(symbolIndices: readonly number[]): number[] {
    const logs = Array.from({ length: this.options.featureCount }, (_, code) =>
      this.messageLogProbability(code, symbolIndices),
    );
    return normalizeLogs(logs);
  }

  /**
   * Posterior over the feature space for one symbol, marginalized over the
   * message positions that symbol occupied. This is the association a
   * `hypothesis.*` event records for a term: "which features does this symbol
   * predict", read straight off the predictive model rather than off a
   * separate bookkeeping structure.
   */
  featurePosteriorForSymbol(
    symbolIndex: number,
    positions: readonly number[],
  ): number[] {
    const used =
      positions.length > 0
        ? positions.filter((position) => position < this.options.messageLength)
        : [0];
    const scored = used.length > 0 ? used : [0];
    const logs = Array.from({ length: this.options.featureCount }, (_, code) => {
      let total = 0;
      for (const position of scored) {
        const probabilities = this.symbolProbabilities(position, code);
        total += Math.log(at(probabilities, this.requireSymbol(symbolIndex)));
      }
      return total;
    });
    return normalizeLogs(logs);
  }

  export(): ExportedPredictiveModel {
    return {
      version: PREDICTIVE_MODEL_VERSION,
      component: 'predictive-message-model',
      kind: 'positional-cooccurrence-counts',
      lossDefinition: PREDICTIVE_LOSS_DEFINITION,
      pairingRule: PREDICTIVE_PAIRING_RULE,
      options: { ...this.options },
      weights: this.weights.map((table) =>
        table.map((row) => roundAll(row, POLICY_DECIMALS)),
      ),
      pairs: this.folded,
    };
  }

  /** Component hash for `LearnerProvenance.components` (ALD-047 cb 1). */
  hash(): Sha256Hash {
    return hashCanonical(HASH_DOMAINS.policyCheckpoint, this.export());
  }

  /**
   * Restore the weights of a recorded model in place. Used by a derived run
   * (SPEC §7.4) and by a §7.3 recovery; the shape must match exactly, because
   * two models of the same total size can index entirely different feature
   * spaces.
   */
  restore(value: unknown): void {
    const recorded = parseExportedPredictiveModel(value);
    const mismatches: string[] = [];
    for (const [name, left, right] of [
      ['messageLength', recorded.options.messageLength, this.options.messageLength],
      ['featureCount', recorded.options.featureCount, this.options.featureCount],
      ['symbolCount', recorded.options.symbolCount, this.options.symbolCount],
    ] as const) {
      if (left !== right) {
        mismatches.push(`${name} ${String(left)} != ${String(right)}`);
      }
    }
    if (mismatches.length > 0) {
      throw new LearnerConfigurationError(
        `predictive-model checkpoint shape does not match this run: ${mismatches.join(', ')}`,
      );
    }
    recorded.weights.forEach((table, position) => {
      table.forEach((row, featureCode) => {
        const target = this.row(position, featureCode);
        row.forEach((weight, symbolIndex) => {
          target[symbolIndex] = weight;
        });
      });
    });
    this.folded = recorded.pairs;
  }

  private row(position: number, featureCode: number): number[] {
    const table = this.weights[position];
    if (table === undefined) {
      throw new LearnerStateError(
        `No predictive table for message position ${String(position)}`,
      );
    }
    const row = table[featureCode];
    if (row === undefined) {
      throw new LearnerStateError(
        `Feature code ${String(featureCode)} is outside the predictive table`,
      );
    }
    return row;
  }

  private requireFeature(featureCode: number): number {
    if (
      !Number.isInteger(featureCode) ||
      featureCode < 0 ||
      featureCode >= this.options.featureCount
    ) {
      throw new LearnerStateError(
        `Feature code ${String(featureCode)} is outside [0, ${String(this.options.featureCount)})`,
      );
    }
    return featureCode;
  }

  private requireSymbol(symbolIndex: number): number {
    if (
      !Number.isInteger(symbolIndex) ||
      symbolIndex < 0 ||
      symbolIndex >= this.options.symbolCount
    ) {
      throw new LearnerStateError(
        `Symbol index ${String(symbolIndex)} is outside [0, ${String(this.options.symbolCount)})`,
      );
    }
    return symbolIndex;
  }
}

export const ExportedRecurrentPredictiveModelSchema = z
  .object({
    version: z.literal(1),
    component: z.literal('predictive-message-model'),
    kind: z.literal(RECURRENT_ARCHITECTURE),
    lossDefinition: z.literal(RECURRENT_SELF_SUPERVISED_OBJECTIVE),
    pairingRule: z.literal(PREDICTIVE_PAIRING_RULE),
    options: z
      .object({
        messageLength: z.number().int().positive(),
        featureCount: z.number().int().positive(),
        symbolCount: z.number().int().positive(),
        learningRate: z.number().positive(),
      })
      .strict(),
    model: ExportedRecurrentModelSchema,
    pairs: z.number().int().nonnegative(),
  })
  .strict();

export type ExportedRecurrentPredictiveModel = z.infer<
  typeof ExportedRecurrentPredictiveModelSchema
>;

export interface RecurrentPredictiveModelInit {
  messageLength: number;
  featureCount: number;
  symbolCount: number;
  learningRate: number;
  seed: string;
  recurrent?: Omit<
    RecurrentModelOptions,
    'typeCount' | 'symbolCount' | 'messageLength' | 'learningRate'
  >;
}

/** Matched GRU backbone with a reward-free partner-message objective. */
export class RecurrentPredictiveModel implements PredictiveMessageModel {
  private readonly core: RecurrentCommunicationModel;
  private folded = 0;

  constructor(private readonly options: RecurrentPredictiveModelInit) {
    if (!(options.learningRate > 0)) {
      throw new LearnerConfigurationError('learningRate must be positive');
    }
    this.core = new RecurrentCommunicationModel(options.seed, {
      typeCount: options.featureCount,
      symbolCount: options.symbolCount,
      messageLength: options.messageLength,
      learningRate: options.learningRate,
      ...options.recurrent,
    });
  }

  get messageLength(): number {
    return this.options.messageLength;
  }

  get featureCount(): number {
    return this.options.featureCount;
  }

  get symbolCount(): number {
    return this.options.symbolCount;
  }

  get pairs(): number {
    return this.folded;
  }

  get countIncrement(): number {
    return this.options.learningRate;
  }

  setCountIncrement(value: number): void {
    if (!(value > 0)) {
      throw new LearnerConfigurationError('learningRate must be positive');
    }
    this.options.learningRate = value;
    this.core.setLearningRate(value);
  }

  observe(featureCode: number, symbolIndices: readonly number[]): void {
    if (symbolIndices.length === 0) return;
    this.core.updatePredictive([
      { featureCode, messageSymbolIndices: symbolIndices },
    ]);
    this.folded += 1;
  }

  symbolProbabilities(position: number, featureCode: number): number[] {
    const distributions = this.core.predictSymbols(featureCode);
    return at(distributions, position);
  }

  messageLogProbability(
    featureCode: number,
    symbolIndices: readonly number[],
  ): number {
    let total = 0;
    const scored = Math.min(symbolIndices.length, this.messageLength);
    for (let position = 0; position < scored; position += 1) {
      total += Math.log(
        Math.max(
          1e-12,
          at(
            this.symbolProbabilities(position, featureCode),
            at(symbolIndices, position),
          ),
        ),
      );
    }
    return total;
  }

  candidatePosterior(
    candidateFeatureCodes: readonly number[],
    symbolIndices: readonly number[],
  ): number[] {
    if (candidateFeatureCodes.length === 0) {
      throw new LearnerStateError('candidateFeatureCodes must not be empty');
    }
    return normalizeLogs(
      candidateFeatureCodes.map((featureCode) =>
        this.messageLogProbability(featureCode, symbolIndices),
      ),
    );
  }

  featurePosterior(symbolIndices: readonly number[]): number[] {
    return this.candidatePosterior(
      Array.from({ length: this.featureCount }, (_, index) => index),
      symbolIndices,
    );
  }

  featurePosteriorForSymbol(
    symbolIndex: number,
    positions: readonly number[],
  ): number[] {
    const used = positions.length > 0 ? positions : [0];
    return normalizeLogs(
      Array.from({ length: this.featureCount }, (_, featureCode) =>
        used.reduce(
          (total, position) =>
            total +
            Math.log(
              Math.max(
                1e-12,
                at(this.symbolProbabilities(position, featureCode), symbolIndex),
              ),
            ),
          0,
        ),
      ),
    );
  }

  export(): ExportedRecurrentPredictiveModel {
    return {
      version: 1,
      component: 'predictive-message-model',
      kind: RECURRENT_ARCHITECTURE,
      lossDefinition: RECURRENT_SELF_SUPERVISED_OBJECTIVE,
      pairingRule: PREDICTIVE_PAIRING_RULE,
      options: {
        messageLength: this.messageLength,
        featureCount: this.featureCount,
        symbolCount: this.symbolCount,
        learningRate: this.options.learningRate,
      },
      model: this.core.export(),
      pairs: this.folded,
    };
  }

  hash(): Sha256Hash {
    return hashCanonical(HASH_DOMAINS.policyCheckpoint, this.export());
  }

  restore(value: unknown): void {
    const recorded = ExportedRecurrentPredictiveModelSchema.parse(value);
    const mismatches = [
      ['messageLength', recorded.options.messageLength, this.messageLength],
      ['featureCount', recorded.options.featureCount, this.featureCount],
      ['symbolCount', recorded.options.symbolCount, this.symbolCount],
    ].flatMap(([name, left, right]) =>
      left === right ? [] : [`${String(name)} ${String(left)} != ${String(right)}`],
    );
    if (mismatches.length > 0) {
      throw new LearnerConfigurationError(
        `recurrent predictive checkpoint shape does not match this run: ${mismatches.join(', ')}`,
      );
    }
    this.options.learningRate = recorded.options.learningRate;
    this.core.restore(recorded.model);
    this.folded = recorded.pairs;
  }
}

/** Parse and shape-check an exported predictive model. */
export function parseExportedPredictiveModel(
  value: unknown,
): ExportedPredictiveModel {
  const model = ExportedPredictiveModelSchema.parse(value);
  const { messageLength, featureCount, symbolCount } = model.options;
  if (model.weights.length !== messageLength) {
    throw new LearnerConfigurationError(
      'a predictive model must hold one weight table per message position',
    );
  }
  for (const table of model.weights) {
    if (table.length !== featureCount) {
      throw new LearnerConfigurationError(
        'each predictive table must hold one row per feature code',
      );
    }
    for (const row of table) {
      if (row.length !== symbolCount) {
        throw new LearnerConfigurationError(
          'each predictive row must hold one column per symbol',
        );
      }
      for (const weight of row) {
        if (!Number.isFinite(weight) || weight < 0) {
          throw new LearnerConfigurationError(
            'predictive weights must be finite and non-negative',
          );
        }
      }
    }
  }
  return model;
}

export const EXPORTED_PAYLOAD_MODEL_VERSION = 1 as const;

export const ExportedPayloadModelSchema = z
  .object({
    version: z.literal(EXPORTED_PAYLOAD_MODEL_VERSION),
    component: z.literal('outcome-payload-model'),
    kind: z.literal('moving-average'),
    dimension: z.number().int().positive(),
    rate: z.number().min(0).max(1),
    /** Fallback prediction for a key never seen before. */
    globalMean: z.array(z.number()),
    /** Sorted by `key`, so the canonical form is order-independent. */
    entries: z.array(
      z
        .object({ key: z.string().min(1), mean: z.array(z.number()) })
        .strict(),
    ),
  })
  .strict();

export type ExportedPayloadModel = z.infer<typeof ExportedPayloadModelSchema>;

/**
 * The `hybrid` world model's second head: a moving-average prediction of the
 * approved nonverbal outcome payload (SPEC §8.1 step 7) for one
 * `(role, feature, message)` key.
 *
 * This head is `hybrid`-only. It touches the outcome payload, so constructing
 * one inside the `self-supervised` adapter would break ALD-046 cb 3; that
 * adapter never does.
 */
export class PayloadMeanModel {
  private readonly means = new Map<string, number[]>();
  private globalMean: number[];

  constructor(
    private readonly dimension: number,
    private readonly rate: number,
  ) {
    if (!Number.isInteger(dimension) || dimension < 1) {
      throw new LearnerConfigurationError(
        'payload dimension must be a positive integer',
      );
    }
    if (!(rate >= 0 && rate <= 1)) {
      throw new LearnerConfigurationError('payload rate must be within [0, 1]');
    }
    this.globalMean = new Array<number>(dimension).fill(0);
  }

  /** Prediction for `key`, falling back to the global mean when unseen. */
  predict(key: string): number[] {
    return [...(this.means.get(key) ?? this.globalMean)];
  }

  /**
   * One moving-average step toward the observed payload. Returns the squared
   * prediction error *before* the step, which is a researcher-facing
   * diagnostic (E31 drift, E21 comparison) and is deliberately not a reward:
   * the `hybrid` intrinsic signal is
   * `PREDICTION_PROGRESS_REWARD_DEFINITION`, computed from the message model.
   */
  update(key: string, payload: readonly number[]): number {
    const observed = Array.from(
      { length: this.dimension },
      (_, index) => payload[index] ?? 0,
    );
    const before = this.means.get(key) ?? this.globalMean;
    let error = 0;
    for (let index = 0; index < this.dimension; index += 1) {
      error += (at(before, index) - at(observed, index)) ** 2;
    }
    this.means.set(key, this.step(before, observed));
    this.globalMean = this.step(this.globalMean, observed);
    return roundTo(error, POLICY_DECIMALS);
  }

  export(): ExportedPayloadModel {
    return {
      version: EXPORTED_PAYLOAD_MODEL_VERSION,
      component: 'outcome-payload-model',
      kind: 'moving-average',
      dimension: this.dimension,
      rate: roundTo(this.rate, POLICY_DECIMALS),
      globalMean: roundAll(this.globalMean, POLICY_DECIMALS),
      entries: [...this.means.entries()]
        .map(([key, mean]) => ({ key, mean: roundAll(mean, POLICY_DECIMALS) }))
        .sort((left, right) => compareStrings(left.key, right.key)),
    };
  }

  hash(): Sha256Hash {
    return hashCanonical(HASH_DOMAINS.policyCheckpoint, this.export());
  }

  restore(value: unknown): void {
    const recorded = ExportedPayloadModelSchema.parse(value);
    if (recorded.dimension !== this.dimension) {
      throw new LearnerConfigurationError(
        `payload model dimension ${String(recorded.dimension)} != ${String(this.dimension)}`,
      );
    }
    this.means.clear();
    for (const entry of recorded.entries) {
      if (entry.mean.length !== this.dimension) {
        throw new LearnerConfigurationError(
          'every payload mean must hold one component per dimension',
        );
      }
      this.means.set(entry.key, [...entry.mean]);
    }
    if (recorded.globalMean.length !== this.dimension) {
      throw new LearnerConfigurationError(
        'the payload global mean must hold one component per dimension',
      );
    }
    this.globalMean = [...recorded.globalMean];
  }

  private step(from: readonly number[], toward: readonly number[]): number[] {
    return roundAll(
      from.map(
        (value, index) => value + this.rate * (at(toward, index) - value),
      ),
      POLICY_DECIMALS,
    );
  }
}

/**
 * Normalize a vector of log-weights into a probability distribution, shifting
 * by the maximum first so a long message cannot underflow to all zeros.
 */
export function normalizeLogs(logs: readonly number[]): number[] {
  if (logs.length === 0) {
    return [];
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const value of logs) {
    if (value > max) {
      max = value;
    }
  }
  const weights = logs.map((value) => Math.exp(value - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) {
    return logs.map(() => 1 / logs.length);
  }
  return weights.map((weight) => weight / total);
}

/**
 * Mix a distribution with the uniform distribution. `rate` is the pre-
 * registered exploration rate: `0` leaves the distribution untouched, `1`
 * makes the choice uniform.
 */
export function mixWithUniform(
  distribution: readonly number[],
  rate: number,
): number[] {
  if (distribution.length === 0) {
    return [];
  }
  if (!(rate >= 0 && rate <= 1)) {
    throw new LearnerConfigurationError('explorationRate must be within [0, 1]');
  }
  const uniform = 1 / distribution.length;
  return distribution.map((value) => (1 - rate) * value + rate * uniform);
}

/**
 * Lowest index holding the maximum value, or `-1` for an empty list. Ties
 * resolve to the lowest index, which is what makes the receiver's
 * interpretation and the pairing rule reproducible from a checkpoint alone.
 */
export function lowestArgmax(values: readonly number[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  values.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value;
      best = index;
    }
  });
  return best;
}

/** Code-unit ordering, so a canonical snapshot does not depend on a locale. */
export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Indexed read that keeps `noUncheckedIndexedAccess` honest. `game.ts` has the
 * same helper privately; it is not exported there and that module is owned by
 * another workstream, so it is repeated here rather than edited in.
 */
export function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`Index ${String(index)} is outside the table`);
  }
  return value;
}

/** Row of a matrix, with the same bounds guarantee as `at`. */
export function row(matrix: readonly number[][], index: number): number[] {
  const value = matrix[index];
  if (value === undefined) {
    throw new LearnerStateError(`Row ${String(index)} is outside the table`);
  }
  return value;
}
