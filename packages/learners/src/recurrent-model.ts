/**
 * Small deterministic GRU backbone shared by the scientific scratch-RL and
 * reward-free comparison adapters. It intentionally has no tensor-runtime or
 * native dependency: the complete parameter vector, Adam state, and recurrent
 * checkpoint state are canonical JSON and can be independently inspected.
 *
 * Training uses one-step truncated backpropagation through the GRU. The RL
 * path applies a clipped PPO-style actor objective plus a value loss; the
 * self-supervised path applies categorical cross-entropy to the same sender
 * head without reading a scalar reward or outcome label.
 */
import { SeededPrng } from '@ald/hashing';
import { z } from 'zod';

import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import { POLICY_DECIMALS } from './policy.js';
import { roundAll, roundTo, softmax } from './game.js';

export const RECURRENT_MODEL_VERSION = 1 as const;
export const RECURRENT_ARCHITECTURE = 'gru-actor-critic-v1' as const;
export const RECURRENT_RL_OBJECTIVE =
  'ppo-clipped:one-step-truncated-gru+value-mse:v1' as const;
export const RECURRENT_SELF_SUPERVISED_OBJECTIVE =
  'predictive-cross-entropy:partner-message|candidate-features:gru-v1' as const;

export interface RecurrentModelOptions {
  typeCount: number;
  symbolCount: number;
  messageLength: number;
  hiddenSize?: number;
  learningRate?: number;
  adamBeta1?: number;
  adamBeta2?: number;
  adamEpsilon?: number;
  ppoClip?: number;
  ppoEpochs?: number;
  valueLossCoefficient?: number;
  maxGradientNorm?: number;
}

export interface ResolvedRecurrentModelOptions {
  typeCount: number;
  symbolCount: number;
  messageLength: number;
  hiddenSize: number;
  inputSize: number;
  senderOutputSize: number;
  receiverOutputSize: number;
  learningRate: number;
  adamBeta1: number;
  adamBeta2: number;
  adamEpsilon: number;
  ppoClip: number;
  ppoEpochs: number;
  valueLossCoefficient: number;
  maxGradientNorm: number;
}

const ResolvedOptionsSchema = z.object({
  typeCount: z.number().int().positive(),
  symbolCount: z.number().int().positive(),
  messageLength: z.number().int().positive(),
  hiddenSize: z.number().int().positive(),
  inputSize: z.number().int().positive(),
  senderOutputSize: z.number().int().positive(),
  receiverOutputSize: z.number().int().positive(),
  learningRate: z.number().positive(),
  adamBeta1: z.number().min(0).max(1),
  adamBeta2: z.number().min(0).max(1),
  adamEpsilon: z.number().positive(),
  ppoClip: z.number().positive(),
  ppoEpochs: z.number().int().positive(),
  valueLossCoefficient: z.number().nonnegative(),
  maxGradientNorm: z.number().positive(),
}).strict();

export const ExportedRecurrentModelSchema = z
  .object({
    version: z.literal(RECURRENT_MODEL_VERSION),
    architecture: z.literal(RECURRENT_ARCHITECTURE),
    rlObjective: z.literal(RECURRENT_RL_OBJECTIVE),
    selfSupervisedObjective: z.literal(RECURRENT_SELF_SUPERVISED_OBJECTIVE),
    options: ResolvedOptionsSchema,
    parameterCount: z.number().int().positive(),
    parameters: z.array(z.number()),
    optimizer: z.object({
      name: z.literal('adam-v1'),
      step: z.number().int().nonnegative(),
      firstMoment: z.array(z.number()),
      secondMoment: z.array(z.number()),
    }),
    checkpointHidden: z.object({
      sender: z.array(z.number()),
      receiver: z.array(z.number()),
    }),
    updateCount: z.number().int().nonnegative(),
  })
  .strict();

export type ExportedRecurrentModel = z.infer<
  typeof ExportedRecurrentModelSchema
>;

export interface RecurrentForwardResult {
  distributions: number[][];
  value: number;
}

export interface RecurrentUpdateMetrics {
  objective: typeof RECURRENT_RL_OBJECTIVE;
  trajectories: number;
  optimizerSteps: number;
  clippedEpochs: number;
  gradientNorm: number;
  parameterDeltaL2: number;
}

export interface RecurrentPredictiveMetrics {
  objective: typeof RECURRENT_SELF_SUPERVISED_OBJECTIVE;
  examples: number;
  optimizerSteps: number;
  meanLoss: number;
  gradientNorm: number;
  parameterDeltaL2: number;
}

export interface RecurrentGradientCheck {
  parameterIndex: number;
  analytic: number;
  numerical: number;
  relativeError: number;
  epsilon: number;
}

type Role = 'sender' | 'receiver';

interface Layout {
  wz: number;
  uz: number;
  bz: number;
  wr: number;
  ur: number;
  br: number;
  wn: number;
  un: number;
  bn: number;
  senderW: number;
  senderB: number;
  receiverW: number;
  receiverB: number;
  valueW: number;
  valueB: number;
  count: number;
}

interface GruCache {
  input: number[];
  previousHidden: number[];
  updateGate: number[];
  resetGate: number[];
  candidate: number[];
  hidden: number[];
}

interface Trajectory {
  role: Role;
  cache: GruCache;
  oldDistributions: number[][];
  /** Head-output index represented by each local distribution index. */
  outputIndices: number[][];
  actions: number[];
  value: number;
  reward?: number;
}

function resolveOptions(
  options: RecurrentModelOptions,
): ResolvedRecurrentModelOptions {
  const inputSize =
    2 + options.typeCount + options.messageLength * options.symbolCount;
  return ResolvedOptionsSchema.parse({
    typeCount: options.typeCount,
    symbolCount: options.symbolCount,
    messageLength: options.messageLength,
    hiddenSize: options.hiddenSize ?? 16,
    inputSize,
    senderOutputSize: options.messageLength * options.symbolCount,
    receiverOutputSize: options.typeCount,
    learningRate: options.learningRate ?? 0.003,
    adamBeta1: options.adamBeta1 ?? 0.9,
    adamBeta2: options.adamBeta2 ?? 0.999,
    adamEpsilon: options.adamEpsilon ?? 1e-8,
    ppoClip: options.ppoClip ?? 0.2,
    ppoEpochs: options.ppoEpochs ?? 4,
    valueLossCoefficient: options.valueLossCoefficient ?? 0.5,
    maxGradientNorm: options.maxGradientNorm ?? 1,
  });
}

function buildLayout(options: ResolvedRecurrentModelOptions): Layout {
  const h = options.hiddenSize;
  const i = options.inputSize;
  let offset = 0;
  const take = (length: number): number => {
    const start = offset;
    offset += length;
    return start;
  };
  return {
    wz: take(h * i),
    uz: take(h * h),
    bz: take(h),
    wr: take(h * i),
    ur: take(h * h),
    br: take(h),
    wn: take(h * i),
    un: take(h * h),
    bn: take(h),
    senderW: take(options.senderOutputSize * h),
    senderB: take(options.senderOutputSize),
    receiverW: take(options.receiverOutputSize * h),
    receiverB: take(options.receiverOutputSize),
    valueW: take(h),
    valueB: take(1),
    count: offset,
  };
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function dotRow(
  values: readonly number[],
  offset: number,
  row: number,
  width: number,
  input: readonly number[],
): number {
  let result = 0;
  const start = offset + row * width;
  for (let column = 0; column < width; column += 1) {
    result += required(values, start + column) * required(input, column);
  }
  return result;
}

function required(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`recurrent parameter index ${String(index)} is absent`);
  }
  return value;
}

function addAt(values: number[], index: number, delta: number): void {
  values[index] = required(values, index) + delta;
}

function addOuter(
  gradient: number[],
  offset: number,
  rows: readonly number[],
  columns: readonly number[],
): void {
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns.length; column += 1) {
      addAt(
        gradient,
        offset + row * columns.length + column,
        required(rows, row) * required(columns, column),
      );
    }
  }
}

function multiplyTranspose(
  parameters: readonly number[],
  offset: number,
  rows: number,
  columns: number,
  vector: readonly number[],
): number[] {
  return Array.from({ length: columns }, (_, column) => {
    let result = 0;
    for (let row = 0; row < rows; row += 1) {
      result +=
        required(parameters, offset + row * columns + column) *
        required(vector, row);
    }
    return result;
  });
}

function l2(values: readonly number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

export class RecurrentCommunicationModel {
  readonly options: ResolvedRecurrentModelOptions;
  readonly parameterCount: number;

  private readonly layout: Layout;
  private parameters: number[];
  private firstMoment: number[];
  private secondMoment: number[];
  private optimizerStep = 0;
  private updates = 0;
  private hidden: Record<Role, number[]>;
  private checkpointHidden: Record<Role, number[]>;
  private readonly pending = new Map<number, Trajectory>();

  constructor(seed: string, options: RecurrentModelOptions) {
    this.options = resolveOptions(options);
    this.layout = buildLayout(this.options);
    this.parameterCount = this.layout.count;
    const prng = new SeededPrng(seed).derive('recurrent-gru/init');
    const h = this.options.hiddenSize;
    const i = this.options.inputSize;
    const sender = this.options.senderOutputSize;
    const receiver = this.options.receiverOutputSize;
    const scaleFor = (fanIn: number, fanOut: number): number =>
      Math.sqrt(6 / (fanIn + fanOut));
    this.parameters = new Array<number>(this.parameterCount).fill(0);
    const initialize = (offset: number, length: number, scale: number): void => {
      for (let index = 0; index < length; index += 1) {
        this.parameters[offset + index] = roundTo(
          (prng.nextFloat() * 2 - 1) * scale,
          POLICY_DECIMALS,
        );
      }
    };
    for (const offset of [this.layout.wz, this.layout.wr, this.layout.wn]) {
      initialize(offset, h * i, scaleFor(i, h));
    }
    for (const offset of [this.layout.uz, this.layout.ur, this.layout.un]) {
      initialize(offset, h * h, scaleFor(h, h));
    }
    initialize(this.layout.senderW, sender * h, scaleFor(h, sender));
    initialize(this.layout.receiverW, receiver * h, scaleFor(h, receiver));
    initialize(this.layout.valueW, h, scaleFor(h, 1));
    this.firstMoment = new Array<number>(this.parameterCount).fill(0);
    this.secondMoment = new Array<number>(this.parameterCount).fill(0);
    this.hidden = { sender: new Array<number>(h).fill(0), receiver: new Array<number>(h).fill(0) };
    this.checkpointHidden = {
      sender: [...this.hidden.sender],
      receiver: [...this.hidden.receiver],
    };
  }

  /** Bytes required by parameters, Adam moments, and two live/checkpoint states. */
  memoryBytes(): number {
    return (
      (this.parameterCount * 3 + this.options.hiddenSize * 4) *
      Float64Array.BYTES_PER_ELEMENT
    );
  }

  setLearningRate(value: number): void {
    if (!(value > 0)) {
      throw new LearnerConfigurationError('learningRate must be positive');
    }
    this.options.learningRate = value;
  }

  sender(
    turn: number,
    typeCode: number,
    temperature = 1,
    advance = true,
  ): RecurrentForwardResult {
    this.assertIndex(typeCode, this.options.typeCount, 'typeCode');
    const input = new Array<number>(this.options.inputSize).fill(0);
    input[0] = 1;
    input[2 + typeCode] = 1;
    const cache = this.gru(input, this.hidden.sender);
    const logits = this.head(cache.hidden, this.layout.senderW, this.layout.senderB, this.options.senderOutputSize);
    const distributions = Array.from(
      { length: this.options.messageLength },
      (_, position) =>
        softmax(
          logits.slice(
            position * this.options.symbolCount,
            (position + 1) * this.options.symbolCount,
          ),
          temperature,
        ),
    );
    const value = this.value(cache.hidden);
    if (advance) {
      this.hidden.sender = [...cache.hidden];
      this.pending.set(turn, {
        role: 'sender',
        cache,
        oldDistributions: distributions.map((distribution) => [...distribution]),
        outputIndices: distributions.map((_, position) =>
          Array.from(
            { length: this.options.symbolCount },
            (__, index) => position * this.options.symbolCount + index,
          ),
        ),
        actions: [],
        value,
      });
    }
    return { distributions, value };
  }

  receiver(
    turn: number,
    symbolIndices: readonly number[],
    candidateTypeCodes: readonly number[],
    temperature = 1,
    advance = true,
  ): RecurrentForwardResult {
    if (candidateTypeCodes.length === 0) {
      throw new LearnerConfigurationError('candidateTypeCodes must not be empty');
    }
    const input = new Array<number>(this.options.inputSize).fill(0);
    input[1] = 1;
    symbolIndices.slice(0, this.options.messageLength).forEach((symbol, position) => {
      this.assertIndex(symbol, this.options.symbolCount, 'symbolIndex');
      input[
        2 +
          this.options.typeCount +
          position * this.options.symbolCount +
          symbol
      ] = 1;
    });
    candidateTypeCodes.forEach((typeCode) =>
      this.assertIndex(typeCode, this.options.typeCount, 'candidateTypeCode'),
    );
    const cache = this.gru(input, this.hidden.receiver);
    const typeLogits = this.head(
      cache.hidden,
      this.layout.receiverW,
      this.layout.receiverB,
      this.options.receiverOutputSize,
    );
    const distribution = softmax(
      candidateTypeCodes.map((typeCode) => required(typeLogits, typeCode)),
      temperature,
    );
    const value = this.value(cache.hidden);
    if (advance) {
      this.hidden.receiver = [...cache.hidden];
      this.pending.set(turn, {
        role: 'receiver',
        cache,
        oldDistributions: [[...distribution]],
        outputIndices: [[...candidateTypeCodes]],
        actions: [],
        value,
      });
    }
    return { distributions: [distribution], value };
  }

  recordActions(turn: number, actions: readonly number[]): void {
    const trajectory = this.requireTrajectory(turn);
    if (actions.length !== trajectory.oldDistributions.length) {
      throw new LearnerConfigurationError(
        `turn ${String(turn)} has ${String(trajectory.oldDistributions.length)} action distributions, not ${String(actions.length)}`,
      );
    }
    actions.forEach((action, index) =>
      this.assertIndex(
        action,
        requiredArray(trajectory.oldDistributions, index).length,
        'action',
      ),
    );
    trajectory.actions = [...actions];
  }

  recordReward(turn: number, reward: number): void {
    if (!Number.isFinite(reward)) {
      throw new LearnerConfigurationError('reward must be finite');
    }
    this.requireTrajectory(turn).reward = reward;
  }

  updateReinforcement(turns: readonly number[]): RecurrentUpdateMetrics {
    const before = [...this.parameters];
    let optimizerSteps = 0;
    let clippedEpochs = 0;
    let lastNorm = 0;
    let trajectories = 0;
    for (const turn of [...turns].sort((left, right) => left - right)) {
      const trajectory = this.pending.get(turn);
      if (
        trajectory === undefined ||
        trajectory.reward === undefined ||
        trajectory.actions.length === 0
      ) {
        if (trajectory !== undefined) this.pending.delete(turn);
        continue;
      }
      trajectories += 1;
      const advantage = trajectory.reward - trajectory.value;
      for (let epoch = 0; epoch < this.options.ppoEpochs; epoch += 1) {
        const result = this.reinforcementGradient(trajectory, advantage);
        clippedEpochs += result.clipped ? 1 : 0;
        lastNorm = this.applyGradient(result.gradient);
        optimizerSteps += 1;
      }
      this.pending.delete(turn);
    }
    if (optimizerSteps > 0) {
      this.updates += 1;
      this.captureCheckpointHidden();
    }
    return {
      objective: RECURRENT_RL_OBJECTIVE,
      trajectories,
      optimizerSteps,
      clippedEpochs,
      gradientNorm: lastNorm,
      parameterDeltaL2: l2(
        this.parameters.map((value, index) => value - required(before, index)),
      ),
    };
  }

  /**
   * Label-free model update used by E12: `featureCode` is the learner's own
   * numeric candidate feature and `messageSymbolIndices` is a public message.
   */
  updatePredictive(
    examples: readonly {
      featureCode: number;
      messageSymbolIndices: readonly number[];
    }[],
  ): RecurrentPredictiveMetrics {
    const before = [...this.parameters];
    let totalLoss = 0;
    let optimizerSteps = 0;
    let lastNorm = 0;
    examples.forEach((example, exampleIndex) => {
      const result = this.predictiveGradient(
        example.featureCode,
        example.messageSymbolIndices,
        this.hidden.sender,
      );
      this.hidden.sender = [...result.cache.hidden];
      totalLoss += result.loss;
      lastNorm = this.applyGradient(result.gradient);
      optimizerSteps += 1;
      if (exampleIndex === examples.length - 1) {
        this.captureCheckpointHidden();
      }
    });
    if (optimizerSteps > 0) this.updates += 1;
    return {
      objective: RECURRENT_SELF_SUPERVISED_OBJECTIVE,
      examples: examples.length,
      optimizerSteps,
      meanLoss: examples.length === 0 ? 0 : totalLoss / examples.length,
      gradientNorm: lastNorm,
      parameterDeltaL2: l2(
        this.parameters.map((value, index) => value - required(before, index)),
      ),
    };
  }

  /** Central-difference audit of the largest analytic predictive gradient. */
  checkPredictiveGradient(
    featureCode: number,
    messageSymbolIndices: readonly number[],
    epsilon = 1e-5,
  ): RecurrentGradientCheck {
    if (!(epsilon > 0)) {
      throw new LearnerConfigurationError('gradient-check epsilon must be positive');
    }
    const baseline = [...this.parameters];
    const analyticResult = this.predictiveGradient(
      featureCode,
      messageSymbolIndices,
      this.hidden.sender,
    );
    let parameterIndex = 0;
    for (let index = 1; index < analyticResult.gradient.length; index += 1) {
      if (
        Math.abs(required(analyticResult.gradient, index)) >
        Math.abs(required(analyticResult.gradient, parameterIndex))
      ) {
        parameterIndex = index;
      }
    }
    const analytic = required(analyticResult.gradient, parameterIndex);
    this.parameters[parameterIndex] = required(baseline, parameterIndex) + epsilon;
    const plus = this.predictiveGradient(
      featureCode,
      messageSymbolIndices,
      this.hidden.sender,
    ).loss;
    this.parameters[parameterIndex] = required(baseline, parameterIndex) - epsilon;
    const minus = this.predictiveGradient(
      featureCode,
      messageSymbolIndices,
      this.hidden.sender,
    ).loss;
    this.parameters = baseline;
    const numerical = (plus - minus) / (2 * epsilon);
    return {
      parameterIndex,
      analytic,
      numerical,
      relativeError:
        Math.abs(analytic - numerical) /
        Math.max(1e-12, Math.abs(analytic) + Math.abs(numerical)),
      epsilon,
    };
  }

  /** Predict public marks for one numeric feature without changing live state. */
  predictSymbols(featureCode: number, temperature = 1): number[][] {
    return this.sender(-1, featureCode, temperature, false).distributions;
  }

  /** Score candidate types by a public message without changing live state. */
  predictCandidates(
    symbolIndices: readonly number[],
    candidateTypeCodes: readonly number[],
    temperature = 1,
  ): number[] {
    return requiredArray(
      this.receiver(-1, symbolIndices, candidateTypeCodes, temperature, false)
        .distributions,
      0,
    );
  }

  export(): ExportedRecurrentModel {
    return {
      version: RECURRENT_MODEL_VERSION,
      architecture: RECURRENT_ARCHITECTURE,
      rlObjective: RECURRENT_RL_OBJECTIVE,
      selfSupervisedObjective: RECURRENT_SELF_SUPERVISED_OBJECTIVE,
      options: { ...this.options },
      parameterCount: this.parameterCount,
      parameters: roundAll(this.parameters, POLICY_DECIMALS),
      optimizer: {
        name: 'adam-v1',
        step: this.optimizerStep,
        firstMoment: roundAll(this.firstMoment, POLICY_DECIMALS),
        secondMoment: roundAll(this.secondMoment, POLICY_DECIMALS),
      },
      checkpointHidden: {
        sender: roundAll(this.checkpointHidden.sender, POLICY_DECIMALS),
        receiver: roundAll(this.checkpointHidden.receiver, POLICY_DECIMALS),
      },
      updateCount: this.updates,
    };
  }

  restore(value: unknown): void {
    const exported = ExportedRecurrentModelSchema.parse(value);
    const mismatches = (
      [
        'typeCount',
        'symbolCount',
        'messageLength',
        'hiddenSize',
        'inputSize',
        'senderOutputSize',
        'receiverOutputSize',
      ] as const
    ).filter((name) => exported.options[name] !== this.options[name]);
    if (mismatches.length > 0 || exported.parameterCount !== this.parameterCount) {
      throw new LearnerConfigurationError(
        `recurrent checkpoint shape mismatch: ${mismatches.join(', ') || 'parameterCount'}`,
      );
    }
    for (const [name, values, expected] of [
      ['parameters', exported.parameters, this.parameterCount],
      ['firstMoment', exported.optimizer.firstMoment, this.parameterCount],
      ['secondMoment', exported.optimizer.secondMoment, this.parameterCount],
      ['sender hidden', exported.checkpointHidden.sender, this.options.hiddenSize],
      ['receiver hidden', exported.checkpointHidden.receiver, this.options.hiddenSize],
    ] as const) {
      if (values.length !== expected || values.some((value) => !Number.isFinite(value))) {
        throw new LearnerConfigurationError(
          `recurrent checkpoint ${name} has an invalid shape or value`,
        );
      }
    }
    this.parameters = [...exported.parameters];
    this.firstMoment = [...exported.optimizer.firstMoment];
    this.secondMoment = [...exported.optimizer.secondMoment];
    this.optimizerStep = exported.optimizer.step;
    this.updates = exported.updateCount;
    this.checkpointHidden = {
      sender: [...exported.checkpointHidden.sender],
      receiver: [...exported.checkpointHidden.receiver],
    };
    this.hidden = {
      sender: [...this.checkpointHidden.sender],
      receiver: [...this.checkpointHidden.receiver],
    };
    this.pending.clear();
  }

  /** Evaluation may advance transient hidden state but cannot change export. */
  resetLiveHiddenToCheckpoint(): void {
    this.hidden = {
      sender: [...this.checkpointHidden.sender],
      receiver: [...this.checkpointHidden.receiver],
    };
    this.pending.clear();
  }

  private gru(input: number[], previousHidden: number[]): GruCache {
    const h = this.options.hiddenSize;
    const i = this.options.inputSize;
    const updateGate = new Array<number>(h);
    const resetGate = new Array<number>(h);
    const candidate = new Array<number>(h);
    for (let row = 0; row < h; row += 1) {
      updateGate[row] = sigmoid(
        dotRow(this.parameters, this.layout.wz, row, i, input) +
          dotRow(this.parameters, this.layout.uz, row, h, previousHidden) +
          required(this.parameters, this.layout.bz + row),
      );
      resetGate[row] = sigmoid(
        dotRow(this.parameters, this.layout.wr, row, i, input) +
          dotRow(this.parameters, this.layout.ur, row, h, previousHidden) +
          required(this.parameters, this.layout.br + row),
      );
    }
    const gatedPrevious = previousHidden.map(
      (value, index) => value * required(resetGate, index),
    );
    for (let row = 0; row < h; row += 1) {
      candidate[row] = Math.tanh(
        dotRow(this.parameters, this.layout.wn, row, i, input) +
          dotRow(this.parameters, this.layout.un, row, h, gatedPrevious) +
          required(this.parameters, this.layout.bn + row),
      );
    }
    const hidden = candidate.map(
      (value, index) =>
        (1 - required(updateGate, index)) * value +
        required(updateGate, index) * required(previousHidden, index),
    );
    return {
      input,
      previousHidden: [...previousHidden],
      updateGate,
      resetGate,
      candidate,
      hidden,
    };
  }

  private head(
    hidden: readonly number[],
    weightOffset: number,
    biasOffset: number,
    outputs: number,
  ): number[] {
    return Array.from(
      { length: outputs },
      (_, output) =>
        dotRow(
          this.parameters,
          weightOffset,
          output,
          this.options.hiddenSize,
          hidden,
        ) + required(this.parameters, biasOffset + output),
    );
  }

  private value(hidden: readonly number[]): number {
    return (
      dotRow(
        this.parameters,
        this.layout.valueW,
        0,
        this.options.hiddenSize,
        hidden,
      ) + required(this.parameters, this.layout.valueB)
    );
  }

  private reinforcementGradient(
    trajectory: Trajectory,
    advantage: number,
  ): { gradient: number[]; clipped: boolean } {
    const gradient = new Array<number>(this.parameterCount).fill(0);
    const cache = this.gru(trajectory.cache.input, trajectory.cache.previousHidden);
    const outputSize =
      trajectory.role === 'sender'
        ? this.options.senderOutputSize
        : this.options.receiverOutputSize;
    const weightOffset =
      trajectory.role === 'sender'
        ? this.layout.senderW
        : this.layout.receiverW;
    const biasOffset =
      trajectory.role === 'sender'
        ? this.layout.senderB
        : this.layout.receiverB;
    const logits = this.head(cache.hidden, weightOffset, biasOffset, outputSize);
    const hiddenGradient = new Array<number>(this.options.hiddenSize).fill(0);
    let clipped = false;

    trajectory.actions.forEach((action, actionPosition) => {
      const representedOutputs = requiredArray(
        trajectory.outputIndices,
        actionPosition,
      );
      const current = softmax(
        representedOutputs.map((output) => required(logits, output)),
        1,
      );
      const old = requiredArray(trajectory.oldDistributions, actionPosition);
      const ratio =
        required(current, action) / Math.max(1e-12, required(old, action));
      const shouldClip =
        (advantage >= 0 && ratio > 1 + this.options.ppoClip) ||
        (advantage < 0 && ratio < 1 - this.options.ppoClip);
      clipped ||= shouldClip;
      if (shouldClip) return;
      current.forEach((probability, index) => {
        const localOutput = required(representedOutputs, index);
        const derivative =
          advantage * ratio * (probability - (index === action ? 1 : 0));
        addAt(gradient, biasOffset + localOutput, derivative);
        for (let hidden = 0; hidden < this.options.hiddenSize; hidden += 1) {
          addAt(
            gradient,
            weightOffset + localOutput * this.options.hiddenSize + hidden,
            derivative * required(cache.hidden, hidden),
          );
          addAt(
            hiddenGradient,
            hidden,
            required(
              this.parameters,
              weightOffset + localOutput * this.options.hiddenSize + hidden,
            ) * derivative,
          );
        }
      });
    });

    const currentValue = this.value(cache.hidden);
    const valueDerivative =
      this.options.valueLossCoefficient *
      (currentValue - (trajectory.reward ?? currentValue));
    addAt(gradient, this.layout.valueB, valueDerivative);
    for (let hidden = 0; hidden < this.options.hiddenSize; hidden += 1) {
      addAt(
        gradient,
        this.layout.valueW + hidden,
        valueDerivative * required(cache.hidden, hidden),
      );
      addAt(
        hiddenGradient,
        hidden,
        required(this.parameters, this.layout.valueW + hidden) * valueDerivative,
      );
    }
    this.backpropGru(cache, hiddenGradient, gradient);
    return { gradient, clipped };
  }

  private predictiveGradient(
    featureCode: number,
    messageSymbolIndices: readonly number[],
    previousHidden: readonly number[],
  ): { cache: GruCache; gradient: number[]; loss: number } {
    this.assertIndex(featureCode, this.options.typeCount, 'featureCode');
    const input = new Array<number>(this.options.inputSize).fill(0);
    input[0] = 1;
    input[2 + featureCode] = 1;
    const cache = this.gru(input, [...previousHidden]);
    const logits = this.head(
      cache.hidden,
      this.layout.senderW,
      this.layout.senderB,
      this.options.senderOutputSize,
    );
    const gradient = new Array<number>(this.parameterCount).fill(0);
    const hiddenGradient = new Array<number>(this.options.hiddenSize).fill(0);
    let loss = 0;
    for (let position = 0; position < this.options.messageLength; position += 1) {
      const target = messageSymbolIndices[position];
      if (target === undefined) continue;
      this.assertIndex(target, this.options.symbolCount, 'messageSymbolIndex');
      const start = position * this.options.symbolCount;
      const probabilities = softmax(
        logits.slice(start, start + this.options.symbolCount),
        1,
      );
      loss -= Math.log(Math.max(1e-12, required(probabilities, target)));
      probabilities.forEach((probability, index) => {
        const output = start + index;
        const derivative = probability - (index === target ? 1 : 0);
        addAt(gradient, this.layout.senderB + output, derivative);
        for (let hidden = 0; hidden < this.options.hiddenSize; hidden += 1) {
          addAt(
            gradient,
            this.layout.senderW + output * this.options.hiddenSize + hidden,
            derivative * required(cache.hidden, hidden),
          );
          addAt(
            hiddenGradient,
            hidden,
            required(
              this.parameters,
              this.layout.senderW + output * this.options.hiddenSize + hidden,
            ) * derivative,
          );
        }
      });
    }
    this.backpropGru(cache, hiddenGradient, gradient);
    return { cache, gradient, loss };
  }

  private backpropGru(
    cache: GruCache,
    hiddenGradient: readonly number[],
    gradient: number[],
  ): void {
    const h = this.options.hiddenSize;
    const candidateGradient = new Array<number>(h);
    const updateGradient = new Array<number>(h);
    for (let index = 0; index < h; index += 1) {
      candidateGradient[index] =
        required(hiddenGradient, index) *
        (1 - required(cache.updateGate, index));
      updateGradient[index] =
        required(hiddenGradient, index) *
        (required(cache.previousHidden, index) - required(cache.candidate, index));
    }
    const candidatePreactivation = candidateGradient.map(
      (value, index) =>
        value * (1 - required(cache.candidate, index) ** 2),
    );
    const gatedPrevious = cache.previousHidden.map(
      (value, index) => value * required(cache.resetGate, index),
    );
    addOuter(gradient, this.layout.wn, candidatePreactivation, cache.input);
    addOuter(gradient, this.layout.un, candidatePreactivation, gatedPrevious);
    candidatePreactivation.forEach((value, index) => {
      addAt(gradient, this.layout.bn + index, value);
    });

    const gatedGradient = multiplyTranspose(
      this.parameters,
      this.layout.un,
      h,
      h,
      candidatePreactivation,
    );
    const resetPreactivation = gatedGradient.map(
      (value, index) =>
        value *
        required(cache.previousHidden, index) *
        required(cache.resetGate, index) *
        (1 - required(cache.resetGate, index)),
    );
    addOuter(gradient, this.layout.wr, resetPreactivation, cache.input);
    addOuter(
      gradient,
      this.layout.ur,
      resetPreactivation,
      cache.previousHidden,
    );
    resetPreactivation.forEach((value, index) => {
      addAt(gradient, this.layout.br + index, value);
    });

    const updatePreactivation = updateGradient.map(
      (value, index) =>
        value *
        required(cache.updateGate, index) *
        (1 - required(cache.updateGate, index)),
    );
    addOuter(gradient, this.layout.wz, updatePreactivation, cache.input);
    addOuter(
      gradient,
      this.layout.uz,
      updatePreactivation,
      cache.previousHidden,
    );
    updatePreactivation.forEach((value, index) => {
      addAt(gradient, this.layout.bz + index, value);
    });
  }

  private applyGradient(gradient: number[]): number {
    const norm = l2(gradient);
    const scale = norm > this.options.maxGradientNorm
      ? this.options.maxGradientNorm / norm
      : 1;
    this.optimizerStep += 1;
    const beta1Power = 1 - this.options.adamBeta1 ** this.optimizerStep;
    const beta2Power = 1 - this.options.adamBeta2 ** this.optimizerStep;
    for (let index = 0; index < this.parameterCount; index += 1) {
      const value = required(gradient, index) * scale;
      const first =
        this.options.adamBeta1 * required(this.firstMoment, index) +
        (1 - this.options.adamBeta1) * value;
      const second =
        this.options.adamBeta2 * required(this.secondMoment, index) +
        (1 - this.options.adamBeta2) * value * value;
      this.firstMoment[index] = roundTo(first, POLICY_DECIMALS);
      this.secondMoment[index] = roundTo(second, POLICY_DECIMALS);
      const correctedFirst = first / beta1Power;
      const correctedSecond = second / beta2Power;
      this.parameters[index] = roundTo(
        required(this.parameters, index) -
          (this.options.learningRate * correctedFirst) /
            (Math.sqrt(correctedSecond) + this.options.adamEpsilon),
        POLICY_DECIMALS,
      );
    }
    return norm * scale;
  }

  private captureCheckpointHidden(): void {
    this.checkpointHidden = {
      sender: roundAll(this.hidden.sender, POLICY_DECIMALS),
      receiver: roundAll(this.hidden.receiver, POLICY_DECIMALS),
    };
    this.hidden = {
      sender: [...this.checkpointHidden.sender],
      receiver: [...this.checkpointHidden.receiver],
    };
  }

  private requireTrajectory(turn: number): Trajectory {
    const trajectory = this.pending.get(turn);
    if (trajectory === undefined) {
      throw new LearnerStateError(`no recurrent trajectory for turn ${String(turn)}`);
    }
    return trajectory;
  }

  private assertIndex(value: number, size: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value >= size) {
      throw new LearnerConfigurationError(
        `${name} ${String(value)} is outside [0, ${String(size)})`,
      );
    }
  }
}

function requiredArray<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`recurrent array index ${String(index)} is absent`);
  }
  return value;
}
