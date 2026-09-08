/**
 * `hybrid` reference adapter: from-scratch sensory encoder + trainable world
 * model + randomly initialized communication policy (ALD-047,
 * EXPERIMENT-NOTEBOOK.md E11/E12/E21 infrastructure).
 *
 * SPEC §6.1 defines the track as "From-scratch sensory encoder + trainable
 * recurrent world model + randomly initialized communication policy; frozen
 * non-text-aligned visual features only after passing §6.5", with the claim
 * boundary "same claim strength as `scratch-rl` if it passes semantic-leakage
 * tests". §6.7 names "from-scratch encoder + small recurrent world model +
 * randomly initialized communication head" as the reference implementation.
 * This adapter is the tabular instance of exactly that composition:
 *
 * 1. `SeededSensoryEncoder` (`encoder.ts`) — the from-scratch sensory
 *    encoder. Random hyperplanes through the input box, seeded from the
 *    Baby's private seed, mapping one opaque numeric observation row to one
 *    discrete code. Frozen after initialization, so its hash is a stable
 *    component record.
 * 2. `PredictiveCountModel` + `PayloadMeanModel` (`predictive-model.ts`) —
 *    the trainable world model. Two heads: the partner's next message given
 *    the encoder code, and the approved nonverbal outcome payload
 *    (SPEC §8.1 step 7) given the code and the message. Neither head is a
 *    task label; the payload head is a prediction of the payload both Babies
 *    receive.
 * 3. A randomly initialized communication policy — tabular softmax sender and
 *    receiver tables over *encoder codes*, updated by REINFORCE with a
 *    moving-average baseline. The update rule is implemented here rather than
 *    imported from `TabularReinforceAdapter`: the two tracks share
 *    `game.ts`'s arithmetic (SPEC §6.2's "same backbone where feasible") but
 *    not each other's private state.
 *
 * All three components are randomly initialized from the private seed and all
 * three hashes are recorded in `exportPolicy().components` and in
 * `describeProvenance()` (ALD-047 cb 1). `initialPolicyHash()` is the hash of
 * `exportPolicy()` at the end of `init()` — the recorded random-initialization
 * hash of ALD-045 cb 1 applied to this track.
 *
 * Learning signals (SPEC §11.1: "`hybrid` must declare whether it uses an
 * RL-compatible or self-supervised signal"). This adapter declares an
 * RL-compatible signal and supports the two named here:
 *
 * - `extrinsic-task`: the REINFORCE reward is the task reward, or the approved
 *   nonverbal outcome bit when `reward` is absent;
 * - `intrinsic-prediction-progress`: the reward is
 *   `PREDICTION_PROGRESS_REWARD_DEFINITION` — the increase in the world
 *   model's log-likelihood of this turn's own `(code, message)` pair across
 *   the update that folds it in. The task reward field is never read in this
 *   mode.
 *
 * Optional frozen visual features (SPEC §6.5 item 3) are supplied as a
 * `FrozenFeatureExtractor`, which is genuinely in the sensory path rather than
 * a provenance decoration. When one is present and declares
 * `textAligned: true`, `claimClassification()` returns
 * `weakened-text-aligned-features` and `describeProvenance()` reports the
 * component as `frozen-visual-features` with `textAligned: true`.
 * `strict-ungrounded` here means only "no text-aligned frozen feature is
 * declared in this adapter's path" — it is *not* a leakage result. SPEC §6.5
 * requires the ALD-057 battery to pass before a strict ungrounded claim may be
 * made, and that battery is another workstream's; this adapter exposes the
 * provenance and component hashes it needs and asserts nothing further.
 */
import {
  HASH_DOMAINS,
  ObservationSchema,
  type CurriculumStage,
  type DeliveredChannelArtifact,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LearnerComponentRecord,
  type LearnerInitContext,
  type LearnerProvenance,
  type LedgerDraftEnvelope,
  type LedgerEventDraft,
  type Observation,
  type OutcomeEvent,
  type PolicyCheckpointRef,
  type PrivateLedgerClient,
  type RunConfig,
  type Sha256Hash,
  type TurnBudget,
  type TurnProposalEnvelope,
  type UpdateBatch,
} from '@ald/types';
import { SeededPrng, domainHash, hashCanonical } from '@ald/hashing';
import { z } from 'zod';

import { BlindingNonceSource, buildNoncedDraft } from './drafts.js';
import {
  LearnerConfigurationError,
  LearnerStateError,
  UnsupportedLearningSignalError,
} from './errors.js';
import {
  ExportedSensoryEncoderSchema,
  SeededSensoryEncoder,
  type FrozenFeatureExtractor,
  type SensoryEncoderMode,
} from './encoder.js';
import {
  extractSymbols,
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  roundMatrix,
  roundTo,
  softmax,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';
import { HypothesisRecordSchema, POLICY_DECIMALS } from './policy.js';
import {
  ExportedPayloadModelSchema,
  ExportedPredictiveModelSchema,
  PREDICTION_PROGRESS_REWARD_DEFINITION,
  PREDICTIVE_LOSS_DEFINITION,
  PREDICTIVE_PAIRING_RULE,
  PayloadMeanModel,
  PredictiveCountModel,
  at,
  compareStrings,
  lowestArgmax,
  row,
} from './predictive-model.js';

/** Learning signals this track can consume (SPEC §11.1 `learningSignal`). */
export const HYBRID_LEARNING_SIGNALS = [
  'extrinsic-task',
  'intrinsic-prediction-progress',
] as const;

export type HybridRewardMode = (typeof HYBRID_LEARNING_SIGNALS)[number];

/**
 * SPEC §6.5 item 3 / ALD-047 cb 3. `strict-ungrounded` is a statement about
 * this adapter's declared component provenance only: no text-aligned frozen
 * feature is in its sensory path. A strict *claim* additionally requires the
 * ALD-057 semantic-leakage battery to pass, which this adapter does not run
 * and does not assert.
 */
export type HybridClaimClassification =
  | 'strict-ungrounded'
  | 'weakened-text-aligned-features';

export interface HybridAdapterOptions extends GameShapeOptions {
  /** REINFORCE step size (default `0.3`). */
  learningRate?: number;
  /** Moving-average baseline decay (default `0.9`). */
  baselineDecay?: number;
  /** Softmax temperature for action sampling (default `1`). */
  temperature?: number;
  /** Uniform mixing applied to the sender's action distribution (default `0`). */
  explorationRate?: number;
  /** Bits per encoder code; `codeCount = 2 ** codeBits` (default `5`). */
  codeBits?: number;
  /** Encoding used by the sensory encoder (default `random-projection`). */
  encoderMode?: SensoryEncoderMode;
  /** Magnitude of the random logit initialization (default `0.01`). */
  policyInitScale?: number;
  /** Laplace pseudo-count in the world model's message head (default `1`). */
  smoothing?: number;
  /** Random initialization of the world model's message head (default `0.25`). */
  priorNoise?: number;
  /** Moving-average rate of the outcome-payload head (default `0.2`). */
  payloadRate?: number;
  /** Components of the outcome payload the world model tracks (default `1`). */
  payloadDimension?: number;
  /**
   * The single intrinsic reward this track implements. Setting this and
   * configuring `RunConfig.learningSignal: 'intrinsic-prediction-progress'`
   * are two halves of one contract: `init()` refuses any combination in which
   * they disagree, exactly as the tabular track does, so a misconfiguration
   * surfaces once at `init` rather than at every `updatePolicy`.
   */
  intrinsicMode?: 'prediction-progress';
  /**
   * A frozen, non-trainable feature bank in front of the sensory encoder
   * (SPEC §6.1, §6.5 item 3). Injected as an interface with a real `project`
   * implementation, so a declared frozen component is genuinely in the
   * sensory-to-policy path. This repository ships no model weights, so the
   * only implementations available here are deterministic test doubles.
   */
  frozenVisualFeatures?: FrozenFeatureExtractor;
}

export const HybridPolicyOptionsSchema = z
  .object({
    valuesPerAttribute: z.number().int().positive(),
    attributeCount: z.number().int().positive(),
    messageLength: z.number().int().positive(),
    learningRate: z.number().positive(),
    baselineDecay: z.number().min(0).max(1),
    temperature: z.number().positive(),
    explorationRate: z.number().min(0).max(1),
    codeBits: z.number().int().positive(),
    policyInitScale: z.number().min(0),
    smoothing: z.number().positive(),
    priorNoise: z.number().min(0),
    payloadRate: z.number().min(0).max(1),
    payloadDimension: z.number().int().positive(),
    /** True while a consolidation stage is active (E22). */
    consolidating: z.boolean(),
    intrinsicMode: z.literal('prediction-progress').optional(),
  })
  .strict();

export type HybridPolicyOptions = z.infer<typeof HybridPolicyOptionsSchema>;

/** Per-run, per-Baby registries (see `self-supervised.ts` for the rationale). */
export const HybridRegistriesSchema = z
  .object({
    runId: z.string().min(1),
    babyId: z.string().min(1),
    emitted: z.array(z.string().min(1)),
    received: z.array(z.string().min(1)),
    hypotheses: z.array(HypothesisRecordSchema),
    /**
     * How often each encoder code was observed for each object type code, from
     * this Baby's own observations. It is what lets a `hybrid` ledger event
     * quote an `argmaxTypeCode` comparable with the tabular track's, even
     * though its tables are indexed by encoder codes.
     */
    encoderCodeTypeTally: z.array(
      z
        .object({
          code: z.number().int().nonnegative(),
          typeCode: z.number().int().nonnegative(),
          count: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type HybridRegistries = z.infer<typeof HybridRegistriesSchema>;

export const LearnerComponentRecordSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum([
      'sensory-encoder',
      'world-model',
      'communication-policy',
      'value-function',
      'language-model',
      'memory',
      'other',
    ]),
    provenance: z.enum([
      'random-init',
      'frozen-open-weight',
      'frozen-visual-features',
      'derived-run-policy',
      'none',
    ]),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    textAligned: z.boolean(),
  })
  .strict();

export const EXPORTED_HYBRID_POLICY_VERSION = 1 as const;

export const ExportedHybridPolicySchema = z
  .object({
    version: z.literal(EXPORTED_HYBRID_POLICY_VERSION),
    track: z.literal('hybrid'),
    /** The declared signal this run trained under (SPEC §11.1). */
    learningSignal: z.enum(HYBRID_LEARNING_SIGNALS),
    /** ALD-046-style record of the world model's objective. */
    lossDefinition: z.literal(PREDICTIVE_LOSS_DEFINITION),
    pairingRule: z.literal(PREDICTIVE_PAIRING_RULE),
    /** Present only in `intrinsic-prediction-progress` mode. */
    intrinsicRewardDefinition: z
      .literal(PREDICTION_PROGRESS_REWARD_DEFINITION)
      .optional(),
    seedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    options: HybridPolicyOptionsSchema,
    /** ALD-047 cb 1: provenance and hash of every component. */
    components: z.array(LearnerComponentRecordSchema).min(3),
    claimClassification: z.enum([
      'strict-ungrounded',
      'weakened-text-aligned-features',
    ]),
    encoder: ExportedSensoryEncoderSchema,
    world: z
      .object({
        message: ExportedPredictiveModelSchema,
        payload: ExportedPayloadModelSchema,
      })
      .strict(),
    policy: z
      .object({
        /** `[encoderCode][symbolIndex]` sender logits. */
        thetaSender: z.array(z.array(z.number())).min(1),
        /** `[position][symbolIndex][encoderCode]` receiver logits. */
        thetaReceiver: z.array(z.array(z.array(z.number()))).min(1),
        baseline: z.number(),
      })
      .strict(),
    registries: HybridRegistriesSchema,
  })
  .strict();

export type ExportedHybridPolicy = z.infer<typeof ExportedHybridPolicySchema>;

/**
 * One buffered turn. `reward` is present only for the `extrinsic-task` mode
 * and is this Baby's own copy of its own turn's reward — the `hybrid` track is
 * allowed a task signal, which is exactly what separates it from
 * `self-supervised`.
 */
interface HybridUpdateRecord {
  turn: number;
  role: 'sender' | 'receiver';
  /** Encoder codes of this Baby's own observed candidate rows. */
  candidateCodes: number[];
  /** Object type codes of the same rows, for the ledger's comparability. */
  candidateTypeCodes: number[];
  messageSymbolIndices: number[];
  /** Sender only: index into `candidateCodes` of the target row. */
  targetIndexIfSender?: number;
  /** Receiver only: index into `candidateCodes` it selected. */
  actionIndex?: number;
  /** Action distribution at action time (over symbols, or over candidates). */
  probs: number[];
  confidence: number;
  primaryEvidenceRef: string;
  /** The encoder code this Baby bound the message to on this turn. */
  actedCode: number;
  actedTypeCode: number;
  /** `extrinsic-task` only; computed at most once per turn. */
  reward?: number;
}

interface ReceivedMessage {
  turn: number;
  symbols: string[];
  symbolIndices: number[];
  channelEventHash: string | null;
}

interface HypothesisRecord {
  version: number;
  hypothesisRef: string;
  argmaxTypeCode: number;
}

interface AdapterState {
  context: LearnerInitContext;
  ledger: PrivateLedgerClient;
  shape: ResolvedGameShape;
  options: HybridPolicyOptions;
  rewardMode: HybridRewardMode;
  symbols: string[];
  symbolIndex: Map<string, number>;
  actionStream: SeededPrng;
  nonces: BlindingNonceSource;
  seedHash: string;
}

const MAX_PENDING_TURNS = 4_096;
const CONTRADICTION_CONFIDENCE = 0.5;

export class HybridAdapter implements LearnerAdapter {
  readonly track = 'hybrid' as const;

  private state: AdapterState | undefined;
  private encoder: SeededSensoryEncoder | undefined;
  private world: PredictiveCountModel | undefined;
  private payload: PayloadMeanModel | undefined;
  private thetaSender: number[][] = [];
  private thetaReceiver: number[][][] = [];
  private baseline = 0;
  private observation: ParsedObservation | undefined;
  private lastReceived: ReceivedMessage | undefined;
  private readonly pending = new Map<number, HybridUpdateRecord>();
  private readonly hypotheses = new Map<string, HypothesisRecord>();
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  /** `code -> typeCode -> count`, from this Baby's own observations. */
  private readonly codeTypeTally = new Map<number, Map<number, number>>();
  private registryCheckpoint: HybridRegistries | undefined;
  private initialHash: Sha256Hash | undefined;
  private diagnostics: string[] = [];
  /** Prediction progress of the last folded batch, for E21/E31 diagnostics. */
  private lastProgress: number[] = [];

  constructor(private readonly options: HybridAdapterOptions = {}) {}

  /** Researcher-facing hyperparameter differences from a loaded checkpoint. */
  get policyLoadDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  /**
   * World-model prediction progress recorded by the most recent
   * `updatePolicy`, one value per folded turn. Private learner state; never
   * delivered to a Baby and never written to a ledger.
   */
  get lastPredictionProgress(): readonly number[] {
    return this.lastProgress;
  }

  async init(context: LearnerInitContext): Promise<void> {
    if (context.symbolInventory.length === 0) {
      throw new LearnerConfigurationError('symbolInventory must not be empty');
    }
    const shape = resolveGameShape(
      this.options,
      context.config.maxSymbolsPerMessage,
    );
    const options = HybridPolicyOptionsSchema.parse({
      valuesPerAttribute: shape.valuesPerAttribute,
      attributeCount: shape.attributeCount,
      messageLength: shape.messageLength,
      learningRate: this.options.learningRate ?? 0.3,
      baselineDecay: this.options.baselineDecay ?? 0.9,
      temperature: this.options.temperature ?? 1,
      explorationRate: this.options.explorationRate ?? 0,
      codeBits: this.options.codeBits ?? 5,
      policyInitScale: this.options.policyInitScale ?? 0.01,
      smoothing: this.options.smoothing ?? 1,
      priorNoise: this.options.priorNoise ?? 0.25,
      payloadRate: this.options.payloadRate ?? 0.2,
      payloadDimension: this.options.payloadDimension ?? 1,
      consolidating: false,
      ...(this.options.intrinsicMode === undefined
        ? {}
        : { intrinsicMode: this.options.intrinsicMode }),
    });

    const prng = new SeededPrng(context.seed);
    this.state = {
      context,
      ledger: context.ledger,
      shape,
      options,
      rewardMode: resolveRewardMode(context.config, this.options),
      symbols: [...context.symbolInventory],
      symbolIndex: new Map(
        context.symbolInventory.map((symbol, index) => [symbol, index]),
      ),
      actionStream: prng.derive('hybrid/action'),
      nonces: new BlindingNonceSource({
        seed: context.seed,
        runId: context.runId,
        babyId: context.babyId,
      }),
      seedHash: domainHash(HASH_DOMAINS.seed, context.seed),
    };

    // Component 1: the from-scratch sensory encoder. A sender row carries one
    // extra target-flag column, so the encoder is built for the attribute
    // columns alone and every row is projected on its attribute prefix — the
    // sender's own target flag must not change the code of a candidate.
    this.encoder = new SeededSensoryEncoder({
      seed: context.seed,
      rowDimension: shape.attributeCount,
      inputScale: shape.valuesPerAttribute,
      codeBits: options.codeBits,
      ...(this.options.encoderMode === undefined
        ? {}
        : { mode: this.options.encoderMode }),
      ...(this.options.frozenVisualFeatures === undefined
        ? {}
        : { frozenFeatures: this.options.frozenVisualFeatures }),
    });

    // Component 2: the trainable world model, both heads.
    this.world = new PredictiveCountModel({
      messageLength: shape.messageLength,
      featureCount: this.encoder.codeCount,
      symbolCount: context.symbolInventory.length,
      smoothing: options.smoothing,
      priorNoise: options.priorNoise,
      countIncrement: 1,
      seed: context.seed,
    });
    this.payload = new PayloadMeanModel(
      options.payloadDimension,
      options.payloadRate,
    );

    // Component 3: the randomly initialized communication policy.
    const policyStream = prng.derive('hybrid/policy-init');
    const symbolCount = context.symbolInventory.length;
    const draw = (): number =>
      options.policyInitScale === 0
        ? 0
        : roundTo(
            (policyStream.nextFloat() * 2 - 1) * options.policyInitScale,
            POLICY_DECIMALS,
          );
    this.thetaSender = Array.from({ length: this.encoder.codeCount }, () =>
      Array.from({ length: symbolCount }, draw),
    );
    this.thetaReceiver = Array.from({ length: shape.messageLength }, () =>
      Array.from({ length: symbolCount }, () =>
        Array.from({ length: requireEncoder(this.encoder).codeCount }, draw),
      ),
    );
    this.baseline = 0;

    this.observation = undefined;
    this.lastReceived = undefined;
    this.pending.clear();
    this.codeTypeTally.clear();
    this.diagnostics = [];
    this.lastProgress = [];
    this.restoreRegistries(undefined);

    if (context.initialPolicy !== undefined) {
      this.loadPolicy(context.initialPolicy);
    }

    this.initialHash = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      this.exportPolicy(),
    );
    return Promise.resolve();
  }

  /**
   * Hash of `exportPolicy()` as of the end of `init()` — the recorded
   * random-initialization hash of ALD-045 cb 1 applied to this track. It
   * covers all three components at once, because each of their hashes is part
   * of the exported policy.
   */
  initialPolicyHash(): Sha256Hash {
    if (this.initialHash === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.initialHash;
  }

  /**
   * SPEC §6.5 item 3 / ALD-047 cb 3: a declared text-aligned frozen feature
   * automatically weakens the classification. This is a statement about the
   * declared sensory path only; a strict ungrounded *claim* additionally needs
   * the ALD-057 battery to pass.
   */
  claimClassification(): HybridClaimClassification {
    const frozen = requireEncoder(this.encoder).frozenFeatures;
    return frozen !== undefined && frozen.textAligned
      ? 'weakened-text-aligned-features'
      : 'strict-ungrounded';
  }

  async observe(observation: Observation): Promise<void> {
    const state = this.requireState();
    const parsed = ObservationSchema.parse(observation);
    this.observation = parseObservationPayload(
      parsed.payload,
      state.shape.attributeCount,
      state.shape.valuesPerAttribute,
    );
    return Promise.resolve();
  }

  async act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    const state = this.requireState();
    return turnBudget.role === 'sender'
      ? this.actAsSender(state, turnBudget)
      : this.actAsReceiver(state, turnBudget);
  }

  private async actAsSender(
    state: AdapterState,
    turnBudget: TurnBudget,
  ): Promise<TurnProposalEnvelope> {
    requireAction(turnBudget, 'emit_symbols');
    const memory = this.senderTurn(state, turnBudget.turn);
    const symbols = memory.messageSymbolIndices.map((index) =>
      at(state.symbols, index),
    );

    const proposal = {
      kind: 'emit_symbols' as const,
      publicArtifact: { symbols },
    };

    await this.recordFirstUse(
      state,
      turnBudget.turn,
      symbols,
      'term.first_emitted',
      this.emitted,
    );

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: `symbol:${at(symbols, 0)}`,
      turn: turnBudget.turn,
      content: {
        artifactRef: memory.primaryEvidenceRef,
        symbols,
        targetTypeCode: memory.actedTypeCode,
        encoderCode: memory.actedCode,
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.probs, 6),
        partnerMessagePrediction: roundAll(
          requireWorld(this.world).symbolProbabilities(0, memory.actedCode),
          6,
        ),
      },
      evidenceRefs: [memory.primaryEvidenceRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The sender action for `turn`, drawn once (the tabular track's retry
   * semantics: a SPEC §14.5 retry must replay the draw rather than advance the
   * private stream and break §14.3 seeded replay).
   */
  private senderTurn(state: AdapterState, turn: number): HybridUpdateRecord {
    const cached = this.pending.get(turn);
    if (cached !== undefined && cached.role === 'sender') {
      return cached;
    }
    const observation = this.requireObservation();
    if (observation.targetIndex === null) {
      throw new LearnerStateError(
        'A sender turn requires an observation with a target row',
      );
    }
    const { codes, typeCodes } = this.encodeCandidates(observation);
    const targetIndex = observation.targetIndex;
    const actedCode = at(codes, targetIndex);
    const actedTypeCode = at(typeCodes, targetIndex);

    const probs = this.senderDistribution(state, actedCode);
    const symbolIndices: number[] = [];
    let confidence = 1;
    for (let position = 0; position < state.shape.messageLength; position += 1) {
      const index = state.actionStream.sampleIndex(probs);
      symbolIndices.push(index);
      confidence *= at(probs, index);
    }
    const symbols = symbolIndices.map((index) => at(state.symbols, index));
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
      kind: 'emit_symbols' as const,
      publicArtifact: { symbols },
    })}`;

    const record: HybridUpdateRecord = {
      turn,
      role: 'sender',
      candidateCodes: codes,
      candidateTypeCodes: typeCodes,
      messageSymbolIndices: symbolIndices,
      targetIndexIfSender: targetIndex,
      probs,
      confidence,
      primaryEvidenceRef: artifactRef,
      actedCode,
      actedTypeCode,
    };
    this.remember(record);
    return record;
  }

  private async actAsReceiver(
    state: AdapterState,
    turnBudget: TurnBudget,
  ): Promise<TurnProposalEnvelope> {
    requireAction(turnBudget, 'select_object');
    const candidateRefs = turnBudget.candidateRefs;
    if (candidateRefs === undefined || candidateRefs.length === 0) {
      throw new LearnerStateError('A receiver turn requires candidateRefs');
    }
    const received = this.receivedFor(turnBudget.turn);
    const memory = this.receiverTurn(
      state,
      turnBudget.turn,
      received,
      candidateRefs,
    );
    const objectRef = at(candidateRefs, requireIndex(memory.actionIndex));

    const proposal = {
      kind: 'select_object' as const,
      publicArtifact: { objectRef },
    };
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`;
    const channelRef =
      received.channelEventHash === null
        ? undefined
        : `channel:${received.channelEventHash}`;

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: `candidate:${objectRef}`,
      turn: turnBudget.turn,
      content: {
        artifactRef,
        symbols: [...received.symbols],
        selection: objectRef,
        targetTypeCode: memory.actedTypeCode,
        encoderCode: memory.actedCode,
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.probs, 6),
      },
      evidenceRefs:
        channelRef === undefined ? [artifactRef] : [artifactRef, channelRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The receiver action for `turn`, drawn once. Scores come from the
   * communication policy's receiver tables over encoder codes; with nothing
   * delivered (the §9.6 `disabled` control) the score vector is all zeros and
   * the softmax is exactly uniform — no symbol, no information.
   */
  private receiverTurn(
    state: AdapterState,
    turn: number,
    received: ReceivedMessage,
    candidateRefs: readonly string[],
  ): HybridUpdateRecord {
    const cached = this.pending.get(turn);
    if (cached !== undefined && cached.role === 'receiver') {
      return cached;
    }
    const observation = this.requireObservation();
    if (observation.view !== 'receiver') {
      throw new LearnerStateError(
        'A receiver turn requires a receiver-view observation',
      );
    }
    if (observation.typeCodes.length !== candidateRefs.length) {
      throw new LearnerStateError(
        `Observation has ${String(observation.typeCodes.length)} candidate rows but ${String(candidateRefs.length)} candidateRefs`,
      );
    }
    const { codes, typeCodes } = this.encodeCandidates(observation);
    const probs = softmax(
      this.candidateScores(received.symbolIndices, codes),
      state.options.temperature,
    );
    const actionIndex = state.actionStream.sampleIndex(probs);

    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
      kind: 'select_object' as const,
      publicArtifact: { objectRef: at(candidateRefs, actionIndex) },
    })}`;

    const record: HybridUpdateRecord = {
      turn,
      role: 'receiver',
      candidateCodes: codes,
      candidateTypeCodes: typeCodes,
      messageSymbolIndices: [...received.symbolIndices],
      actionIndex,
      probs,
      confidence: at(probs, actionIndex),
      primaryEvidenceRef:
        received.channelEventHash === null
          ? artifactRef
          : `channel:${received.channelEventHash}`,
      actedCode: at(codes, actionIndex),
      actedTypeCode: at(typeCodes, actionIndex),
    };
    this.remember(record);
    return record;
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const world = requireWorld(this.world);
    const symbols = extractSymbols(delivery);
    const scored = symbols.slice(0, state.shape.messageLength);
    const symbolIndices = scored.map((symbol) => {
      const index = state.symbolIndex.get(symbol);
      if (index === undefined) {
        throw new LearnerStateError(`Symbol ${symbol} is not in the inventory`);
      }
      return index;
    });
    this.lastReceived = {
      turn: delivery.turn,
      symbols,
      symbolIndices,
      channelEventHash: delivery.channelEventHash,
    };

    await this.recordFirstUse(
      state,
      delivery.turn,
      symbols,
      'term.first_received',
      this.received,
    );

    const observation = this.observation;
    const codes =
      observation?.view === 'receiver'
        ? this.encodeCandidates(observation).codes
        : [];
    const typeCodes =
      observation?.view === 'receiver' ? [...observation.typeCodes] : [];
    const inferredDistribution =
      codes.length > 0
        ? softmax(
            this.candidateScores(symbolIndices, codes),
            state.options.temperature,
          )
        : [];
    const argmaxCandidateIndex = lowestArgmax(inferredDistribution);
    // The world model's own read of the same delivery: how probable this
    // message was for each offered candidate. Recorded alongside the policy's
    // distribution so E21 can compare the two heads of the hybrid.
    const worldPosterior =
      codes.length > 0 ? world.candidatePosterior(codes, symbolIndices) : [];

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'interpretation.recorded',
      subjectId: `symbol:${at(symbols, 0)}`,
      turn: delivery.turn,
      content: {
        artifactRef: delivery.channelEventHash,
        symbols,
        candidateTypeCodes: typeCodes,
        candidateEncoderCodes: codes,
        inferredDistribution: roundAll(inferredDistribution, 6),
        worldModelDistribution: roundAll(worldPosterior, 6),
        argmaxCandidateIndex,
        confidence: roundTo(
          argmaxCandidateIndex < 0
            ? 0
            : at(inferredDistribution, argmaxCandidateIndex),
          6,
        ),
      },
      evidenceRefs: [`channel:${delivery.channelEventHash}`],
    });

    return {
      channelEventHash: delivery.channelEventHash,
      privateLedgerDraft: draft,
    };
  }

  /**
   * Stores the turn's task reward (`extrinsic-task` only), folds the approved
   * nonverbal outcome payload into the world model's payload head, and appends
   * this Baby's hypothesis events.
   *
   * The reward is computed at most once per turn, as in the tabular track, so
   * a SPEC §14.5 retry of a crashed adapter call cannot move it. The
   * `intrinsic-prediction-progress` reward is not computed here at all: it is
   * defined as the change the world-model update produces, so it is computed
   * inside `updatePolicy` where that update happens.
   */
  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    const state = this.requireState();
    const record = this.pending.get(outcome.turn);
    if (record === undefined) {
      return;
    }

    if (state.rewardMode === 'extrinsic-task' && record.reward === undefined) {
      record.reward = outcome.reward ?? successBitOf(outcome);
    }
    requirePayload(this.payload).update(
      payloadKey(record),
      outcome.payload.length > 0 ? outcome.payload : [successBitOf(outcome)],
    );

    await this.recordHypotheses(state, record, successBitOf(outcome));
  }

  /**
   * One update of all three components, per buffered turn, in turn order:
   *
   * 1. the world model's message head folds the turn's `(code, message)` pair
   *    and reports the increase in that pair's log-likelihood — the
   *    `intrinsic-prediction-progress` reward
   *    (`PREDICTION_PROGRESS_REWARD_DEFINITION`);
   * 2. the communication policy takes one REINFORCE step with a
   *    moving-average baseline,
   *    `theta[state][a] += lr * (r - b) * (onehot(a) - probs)`, on whichever
   *    half produced the turn; the `1/temperature` factor of the softmax
   *    Jacobian is folded into the learning rate;
   * 3. the encoder is not updated: it is frozen after random initialization by
   *    design, which is what keeps its component hash stable.
   *
   * Only this Baby's own buffered records are read: no partner buffer, no
   * shared gradients, no optimizer state outside this object (SPEC §6.2,
   * §10.4).
   */
  async updatePolicy(batch: UpdateBatch): Promise<PolicyCheckpointRef> {
    const state = this.requireState();
    const world = requireWorld(this.world);
    if (!isHybridLearningSignal(batch.learningSignal)) {
      throw new UnsupportedLearningSignalError(
        batch.learningSignal,
        HYBRID_LEARNING_SIGNALS,
      );
    }
    if (batch.learningSignal !== state.rewardMode) {
      throw new UnsupportedLearningSignalError(batch.learningSignal, [
        state.rewardMode,
      ]);
    }

    const learningRate = state.options.learningRate;
    const progress: number[] = [];
    let highestTurn = 0;

    for (const turn of [...batch.turns].sort((left, right) => left - right)) {
      highestTurn = Math.max(highestTurn, turn);
      const record = this.pending.get(turn);
      if (record === undefined) {
        continue;
      }
      if (state.options.consolidating) {
        // A consolidation stage genuinely freezes every component: the turn is
        // discarded rather than deferred, so the interval is a pause and not a
        // delay (E22).
        this.pending.delete(turn);
        continue;
      }

      const before = world.messageLogProbability(
        record.actedCode,
        record.messageSymbolIndices,
      );
      world.observe(record.actedCode, record.messageSymbolIndices);
      const after = world.messageLogProbability(
        record.actedCode,
        record.messageSymbolIndices,
      );
      const predictionProgress = roundTo(after - before, POLICY_DECIMALS);
      progress.push(predictionProgress);

      const reward =
        state.rewardMode === 'extrinsic-task'
          ? record.reward
          : predictionProgress;
      if (reward === undefined) {
        // No outcome has arrived for this turn yet under `extrinsic-task`;
        // leave it buffered so its update is not silently skipped.
        continue;
      }

      if (record.role === 'receiver' && record.messageSymbolIndices.length === 0) {
        // §9.6 `disabled`: no symbol row to credit, and the baseline is left
        // alone so an empty-message turn cannot move the policy hash.
        this.pending.delete(turn);
        continue;
      }

      const advantage = reward - this.baseline;
      if (record.role === 'sender') {
        const logits = row(this.thetaSender, record.actedCode);
        for (const chosen of record.messageSymbolIndices) {
          for (let index = 0; index < logits.length; index += 1) {
            const indicator = index === chosen ? 1 : 0;
            logits[index] =
              at(logits, index) +
              learningRate * advantage * (indicator - at(record.probs, index));
          }
        }
      } else {
        const actionIndex = requireIndex(record.actionIndex);
        record.candidateCodes.forEach((code, candidate) => {
          const indicator = candidate === actionIndex ? 1 : 0;
          const delta =
            learningRate * advantage * (indicator - at(record.probs, candidate));
          record.messageSymbolIndices.forEach((symbolIndex, position) => {
            const logits = row(this.receiverTable(position), symbolIndex);
            logits[code] = at(logits, code) + delta;
          });
        });
      }

      this.baseline =
        state.options.baselineDecay * this.baseline +
        (1 - state.options.baselineDecay) * reward;
      this.pending.delete(turn);
    }

    this.lastProgress = progress;
    this.registryCheckpoint = this.snapshotRegistries(state);
    const policy = this.exportPolicy();
    const policyHash = hashCanonical(HASH_DOMAINS.policyCheckpoint, policy);
    return Promise.resolve({
      policyCheckpointRef: `policy:${policyHash}`,
      policyHash,
      turn: highestTurn,
    });
  }

  /**
   * Apply one pre-registered developmental stage (E22, SPEC §18
   * `curriculumMode: fixed-schedule`). Unsupported knobs are refused, never
   * ignored:
   *
   * - `learningRate`, `temperature` and `explorationRate` are honoured;
   * - `consolidation` freezes all three components for the stage's duration;
   * - `memoryCapacity` is refused — every component here is a fixed-size table
   *     with no capacity knob;
   * - `maxSymbolsPerMessage` is refused unless it equals the message length the
   *     receiver tables were built for.
   */
  async applyCurriculumStage(stage: CurriculumStage): Promise<void> {
    const state = this.requireState();
    const knobs = stage.learnerOptions;

    if (knobs?.memoryCapacity !== undefined) {
      throw new LearnerConfigurationError(
        'curriculum knob memoryCapacity is not supported by the hybrid track',
      );
    }
    if (
      stage.maxSymbolsPerMessage !== undefined &&
      stage.maxSymbolsPerMessage !== state.options.messageLength
    ) {
      throw new LearnerConfigurationError(
        `curriculum knob maxSymbolsPerMessage ${String(stage.maxSymbolsPerMessage)} does not match the configured messageLength ${String(state.options.messageLength)}`,
      );
    }
    if (knobs?.learningRate !== undefined) {
      state.options.learningRate = knobs.learningRate;
    }
    if (knobs?.temperature !== undefined) {
      state.options.temperature = knobs.temperature;
    }
    if (knobs?.explorationRate !== undefined) {
      state.options.explorationRate = knobs.explorationRate;
    }
    state.options.consolidating = stage.consolidation === true;
    return Promise.resolve();
  }

  /**
   * SPEC §6.5 / ALD-047 cb 1 and cb 3: the self-declared provenance and hash
   * of every component. `textAlignedEncoderPresent` is the field SPEC §6.5
   * item 3 reclassifies a run on, and it is reported exactly as the injected
   * frozen feature bank declares it — a claim the ALD-057 battery must check
   * independently, never a proof.
   */
  describeProvenance(): LearnerProvenance {
    const state = this.requireState();
    const frozen = requireEncoder(this.encoder).frozenFeatures;
    return {
      track: 'hybrid',
      modelRef: modelRefFor(state.context),
      textTokenizerPresent: false,
      textAlignedEncoderPresent: frozen !== undefined && frozen.textAligned,
      weightUpdatePath: 'private-buffers-only',
      components: this.componentRecords(),
    };
  }

  /** ALD-047 cb 1: provenance and hash of every component, in a fixed order. */
  componentRecords(): LearnerComponentRecord[] {
    const state = this.requireState();
    const encoder = requireEncoder(this.encoder);
    const world = requireWorld(this.world);
    const payload = requirePayload(this.payload);
    const frozen = encoder.frozenFeatures;

    const records: LearnerComponentRecord[] = [
      {
        name: 'seeded-random-projection-encoder',
        kind: 'sensory-encoder',
        provenance: 'random-init',
        hash: encoder.hash(),
        textAligned: false,
      },
      {
        name: 'predictive-message-model',
        kind: 'world-model',
        provenance: 'random-init',
        hash: world.hash(),
        textAligned: false,
      },
      {
        name: 'outcome-payload-model',
        kind: 'world-model',
        provenance: 'random-init',
        hash: payload.hash(),
        textAligned: false,
      },
      {
        name: 'tabular-reinforce-communication-policy',
        kind: 'communication-policy',
        provenance: 'random-init',
        hash: hashCanonical(HASH_DOMAINS.policyCheckpoint, {
          component: 'communication-policy',
          thetaSender: roundMatrix(this.thetaSender, POLICY_DECIMALS),
          thetaReceiver: this.thetaReceiver.map((table) =>
            roundMatrix(table, POLICY_DECIMALS),
          ),
          baseline: roundTo(this.baseline, POLICY_DECIMALS),
          temperature: state.options.temperature,
          explorationRate: state.options.explorationRate,
          learningRate: state.options.learningRate,
          baselineDecay: state.options.baselineDecay,
        }),
        textAligned: false,
      },
    ];

    if (frozen !== undefined) {
      records.push({
        name: frozen.name,
        kind: 'sensory-encoder',
        provenance: 'frozen-visual-features',
        hash: frozen.hash,
        textAligned: frozen.textAligned,
      });
    }
    return records;
  }

  exportPolicy(): ExportedHybridPolicy {
    const state = this.requireState();
    const encoder = requireEncoder(this.encoder);
    const world = requireWorld(this.world);
    const payload = requirePayload(this.payload);
    return {
      version: EXPORTED_HYBRID_POLICY_VERSION,
      track: 'hybrid',
      learningSignal: state.rewardMode,
      lossDefinition: PREDICTIVE_LOSS_DEFINITION,
      pairingRule: PREDICTIVE_PAIRING_RULE,
      ...(state.rewardMode === 'intrinsic-prediction-progress'
        ? { intrinsicRewardDefinition: PREDICTION_PROGRESS_REWARD_DEFINITION }
        : {}),
      seedHash: state.seedHash,
      options: { ...state.options },
      components: this.componentRecords(),
      claimClassification: this.claimClassification(),
      encoder: encoder.export(),
      world: { message: world.export(), payload: payload.export() },
      policy: {
        thetaSender: roundMatrix(this.thetaSender, POLICY_DECIMALS),
        thetaReceiver: this.thetaReceiver.map((table) =>
          roundMatrix(table, POLICY_DECIMALS),
        ),
        baseline: roundTo(this.baseline, POLICY_DECIMALS),
      },
      registries: cloneRegistries(
        this.registryCheckpoint ?? this.snapshotRegistries(state),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Encoder codes and object type codes of one observation's candidate rows.
   * Only the attribute prefix is projected, so the sender's own target flag
   * never changes a candidate's code, and the tally that lets a hybrid ledger
   * event quote a comparable `argmaxTypeCode` is advanced here.
   */
  private encodeCandidates(observation: ParsedObservation): {
    codes: number[];
    typeCodes: number[];
  } {
    const encoder = requireEncoder(this.encoder);
    const codes = observation.candidates.map((attributes) =>
      encoder.encode(attributes),
    );
    const typeCodes = [...observation.typeCodes];
    codes.forEach((code, index) => {
      const typeCode = at(typeCodes, index);
      const byType = this.codeTypeTally.get(code) ?? new Map<number, number>();
      byType.set(typeCode, (byType.get(typeCode) ?? 0) + 1);
      this.codeTypeTally.set(code, byType);
    });
    return { codes, typeCodes };
  }

  /** Sender action distribution: softmax logits, mixed with the uniform. */
  private senderDistribution(state: AdapterState, code: number): number[] {
    const probs = softmax(
      row(this.thetaSender, code),
      state.options.temperature,
    );
    const rate = state.options.explorationRate;
    if (rate === 0) {
      return probs;
    }
    const uniform = 1 / probs.length;
    return probs.map((value) => (1 - rate) * value + rate * uniform);
  }

  private candidateScores(
    symbolIndices: readonly number[],
    candidateCodes: readonly number[],
  ): number[] {
    return candidateCodes.map((code) => {
      let score = 0;
      symbolIndices.forEach((symbolIndex, position) => {
        score += at(row(this.receiverTable(position), symbolIndex), code);
      });
      return score;
    });
  }

  private receiverTable(position: number): number[][] {
    const table = this.thetaReceiver[position];
    if (table === undefined) {
      throw new LearnerStateError(
        `No receiver table for position ${String(position)}`,
      );
    }
    return table;
  }

  /**
   * CONCEPT-IDEA.md §11.2 rules 1, 3 and 5. The association is the receiver
   * tables' own logits for the symbol, marginalized over the positions it
   * occupied and softmaxed over encoder codes, then mapped back to object type
   * codes through this Baby's own observed tally so a hybrid hypothesis event
   * is readable next to a tabular one.
   */
  private async recordHypotheses(
    state: AdapterState,
    record: HybridUpdateRecord,
    successBit: number,
  ): Promise<void> {
    const positionsBySymbol = new Map<number, number[]>();
    record.messageSymbolIndices.forEach((symbolIndex, position) => {
      const positions = positionsBySymbol.get(symbolIndex) ?? [];
      positions.push(position);
      positionsBySymbol.set(symbolIndex, positions);
    });

    for (const [symbolIndex, positions] of positionsBySymbol) {
      const symbol = at(state.symbols, symbolIndex);
      const association = softmax(
        this.associationRow(symbolIndex, positions),
        state.options.temperature,
      );
      const argmaxCode = this.highestAssociationObservedCode(association);
      if (argmaxCode === undefined) {
        // A hypothesis must name a type this Baby has actually observed.
        // Absence is the honest representation until an encoder code can be
        // grounded through the Baby's own observation tally.
        continue;
      }
      const confidence = at(association, argmaxCode);
      const argmaxTypeCode = this.dominantTypeCode(argmaxCode);
      if (argmaxTypeCode === undefined) {
        continue;
      }
      const evidenceRefs = [
        record.primaryEvidenceRef,
        `outcome:${String(record.turn)}`,
      ];
      const shared = {
        termRef: `symbol:${symbol}`,
        associationOverEncoderCodes: roundAll(association, 6),
        argmaxEncoderCode: argmaxCode,
        argmaxTypeCode,
        confidence: roundTo(confidence, 6),
        evidenceRefs,
      };
      const previous = this.hypotheses.get(symbol);

      if (previous === undefined) {
        const hypothesisRef = `hyp:${symbol}:1`;
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.created',
            subjectId: `symbol:${symbol}`,
            turn: record.turn,
            content: { ...shared, hypothesisRef },
            evidenceRefs,
          }),
        );
        this.hypotheses.set(symbol, {
          version: 1,
          hypothesisRef,
          argmaxTypeCode,
        });
        continue;
      }

      if (previous.argmaxTypeCode !== argmaxTypeCode) {
        const version = previous.version + 1;
        const hypothesisRef = `hyp:${symbol}:${String(version)}`;
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.revised',
            subjectId: `symbol:${symbol}`,
            turn: record.turn,
            content: {
              ...shared,
              hypothesisRef,
              priorHypothesisRef: previous.hypothesisRef,
            },
            evidenceRefs,
          }),
        );
        this.hypotheses.set(symbol, { version, hypothesisRef, argmaxTypeCode });
        continue;
      }

      if (successBit === 0 && confidence > CONTRADICTION_CONFIDENCE) {
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.contradicted',
            subjectId: `symbol:${symbol}`,
            turn: record.turn,
            content: {
              ...shared,
              hypothesisRef: previous.hypothesisRef,
              evidenceRef: `outcome:${String(record.turn)}`,
            },
            evidenceRefs,
          }),
        );
      }
    }
  }

  /** Receiver logits for one symbol, summed over the positions it occupied. */
  private associationRow(symbolIndex: number, positions: number[]): number[] {
    const encoder = requireEncoder(this.encoder);
    const used = positions.length > 0 ? positions : [0];
    const association = new Array<number>(encoder.codeCount).fill(0);
    for (const position of used) {
      if (position >= this.thetaReceiver.length) {
        continue;
      }
      const logits = row(this.receiverTable(position), symbolIndex);
      for (let code = 0; code < association.length; code += 1) {
        association[code] = at(association, code) + at(logits, code);
      }
    }
    return association;
  }

  /**
   * The object type code this Baby has most often seen behind one encoder
   * code, ties resolving to the lowest type code. An unobserved encoder code
   * has no type-code mapping and therefore returns `undefined` rather than an
   * out-of-schema sentinel. Bookkeeping uses this Baby's own observations only.
   */
  private dominantTypeCode(code: number): number | undefined {
    const byType = this.codeTypeTally.get(code);
    if (byType === undefined) {
      return undefined;
    }
    let best = -1;
    let bestCount = 0;
    for (const [typeCode, count] of [...byType.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      if (count > bestCount) {
        bestCount = count;
        best = typeCode;
      }
    }
    return best < 0 ? undefined : best;
  }

  /** Highest-association encoder code this Baby has actually observed. */
  private highestAssociationObservedCode(
    association: readonly number[],
  ): number | undefined {
    const observed = [...this.codeTypeTally.keys()].sort((left, right) => left - right);
    let best: number | undefined;
    for (const code of observed) {
      if (best === undefined || at(association, code) > at(association, best)) {
        best = code;
      }
    }
    return best;
  }

  private remember(record: HybridUpdateRecord): void {
    if (this.pending.size >= MAX_PENDING_TURNS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(record.turn, record);
  }

  private async recordFirstUse(
    state: AdapterState,
    turn: number,
    symbols: readonly string[],
    eventType: 'term.first_emitted' | 'term.first_received',
    seen: Set<string>,
  ): Promise<void> {
    for (const symbol of symbols) {
      if (seen.has(symbol)) {
        continue;
      }
      const draft: LedgerEventDraft = buildNoncedDraft(state.nonces, {
        eventType,
        subjectId: `symbol:${symbol}`,
        turn,
        content: {
          termRef: `symbol:${symbol}`,
          firstUse: eventType === 'term.first_emitted' ? 'emitted' : 'received',
        },
      });
      await state.ledger.append(draft);
      seen.add(symbol);
    }
  }

  /**
   * Resume from a recorded checkpoint (SPEC §7.3 recovery, §7.4 derived run).
   *
   * The *encoder is restored from the checkpoint*, not rebuilt from this run's
   * seed. It is a frozen component: the loaded world model and policy tables
   * are indexed by the parent's code space, so rebuilding a different encoder
   * from a different private seed would silently reinterpret every row of the
   * inherited policy. A derived run therefore inherits the parent's sensory
   * encoder — which is also why its component hash is unchanged in the child's
   * bundle — and any difference from what this run's own seed would have built
   * is reported in `policyLoadDiagnostics` rather than hidden.
   *
   * The *attribute space* is still compared, and refused on mismatch, for the
   * reason the tabular track compares it: two spaces can share a cardinality
   * while decoding the same integer to different objects.
   */
  private loadPolicy(value: unknown): void {
    const state = this.requireState();
    const encoder = requireEncoder(this.encoder);
    const world = requireWorld(this.world);
    const payload = requirePayload(this.payload);
    const policy = ExportedHybridPolicySchema.parse(value);

    const mismatches: string[] = [];
    for (const [name, left, right] of [
      ['attributeCount', policy.options.attributeCount, state.options.attributeCount],
      [
        'valuesPerAttribute',
        policy.options.valuesPerAttribute,
        state.options.valuesPerAttribute,
      ],
      ['messageLength', policy.options.messageLength, state.options.messageLength],
      ['codeBits', policy.options.codeBits, state.options.codeBits],
      ['encoderCodeCount', policy.encoder.codeCount, encoder.codeCount],
      ['encoderRowDimension', policy.encoder.rowDimension, encoder.rowDimension],
    ] as const) {
      if (left !== right) {
        mismatches.push(`${name} ${String(left)} != ${String(right)}`);
      }
    }
    if (mismatches.length > 0) {
      throw new LearnerConfigurationError(
        `initialPolicy shape does not match this run configuration: ${mismatches.join(', ')}`,
      );
    }

    this.diagnostics = [];
    for (const [name, left, right] of [
      ['learningRate', policy.options.learningRate, state.options.learningRate],
      ['temperature', policy.options.temperature, state.options.temperature],
      [
        'baselineDecay',
        policy.options.baselineDecay,
        state.options.baselineDecay,
      ],
      [
        'explorationRate',
        policy.options.explorationRate,
        state.options.explorationRate,
      ],
      ['encoderMode', policy.encoder.mode, encoder.mode],
      ['encoderSeedHash', policy.encoder.seedHash, encoder.export().seedHash],
    ] as const) {
      if (left !== right) {
        this.diagnostics.push(`${name} ${String(left)} != ${String(right)}`);
      }
    }

    this.encoder = SeededSensoryEncoder.load(
      policy.encoder,
      this.options.frozenVisualFeatures,
    );
    world.restore(policy.world.message);
    payload.restore(policy.world.payload);
    this.thetaSender = policy.policy.thetaSender.map((logits) => [...logits]);
    this.thetaReceiver = policy.policy.thetaReceiver.map((table) =>
      table.map((logits) => [...logits]),
    );
    this.baseline = policy.policy.baseline;
    this.restoreRegistries(policy.registries);
  }

  private restoreRegistries(registries: HybridRegistries | undefined): void {
    const state = this.requireState();
    this.hypotheses.clear();
    this.emitted.clear();
    this.received.clear();
    this.codeTypeTally.clear();

    if (
      registries !== undefined &&
      registries.runId === state.context.runId &&
      registries.babyId === state.context.babyId
    ) {
      for (const symbol of registries.emitted) {
        this.emitted.add(symbol);
      }
      for (const symbol of registries.received) {
        this.received.add(symbol);
      }
      for (const record of registries.hypotheses) {
        this.hypotheses.set(record.symbol, {
          version: record.version,
          hypothesisRef: record.hypothesisRef,
          argmaxTypeCode: record.argmaxTypeCode,
        });
      }
      for (const entry of registries.encoderCodeTypeTally) {
        const byType =
          this.codeTypeTally.get(entry.code) ?? new Map<number, number>();
        byType.set(entry.typeCode, entry.count);
        this.codeTypeTally.set(entry.code, byType);
      }
    }

    this.registryCheckpoint = this.snapshotRegistries(state);
  }

  private snapshotRegistries(state: AdapterState): HybridRegistries {
    const tally: HybridRegistries['encoderCodeTypeTally'] = [];
    for (const [code, byType] of this.codeTypeTally) {
      for (const [typeCode, count] of byType) {
        tally.push({ code, typeCode, count });
      }
    }
    return {
      runId: state.context.runId,
      babyId: state.context.babyId,
      emitted: [...this.emitted].sort(compareStrings),
      received: [...this.received].sort(compareStrings),
      hypotheses: [...this.hypotheses.entries()]
        .map(([symbol, record]) => ({ symbol, ...record }))
        .sort((left, right) => compareStrings(left.symbol, right.symbol)),
      encoderCodeTypeTally: tally.sort(
        (left, right) =>
          left.code - right.code || left.typeCode - right.typeCode,
      ),
    };
  }

  private requireState(): AdapterState {
    if (this.state === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.state;
  }

  private requireObservation(): ParsedObservation {
    if (this.observation === undefined) {
      throw new LearnerStateError('observe() must be called before act()');
    }
    return this.observation;
  }

  private receivedFor(turn: number): ReceivedMessage {
    const received = this.lastReceived;
    return received !== undefined && received.turn === turn
      ? received
      : { turn, symbols: [], symbolIndices: [], channelEventHash: null };
  }
}

function isHybridLearningSignal(value: string): value is HybridRewardMode {
  return (HYBRID_LEARNING_SIGNALS as readonly string[]).includes(value);
}

/**
 * `intrinsicMode` and `RunConfig.learningSignal` are one contract, not two
 * independent switches (SPEC §11.1: "`hybrid` must declare whether it uses an
 * RL-compatible or self-supervised signal"). `updatePolicy` requires
 * `batch.learningSignal === state.rewardMode`, so any combination where they
 * disagree would initialize cleanly and then reject every update; refusing at
 * `init()` surfaces the misconfiguration once.
 */
function resolveRewardMode(
  config: Pick<RunConfig, 'learningSignal'>,
  options: HybridAdapterOptions,
): HybridRewardMode {
  const intrinsicModeSet = options.intrinsicMode === 'prediction-progress';
  const intrinsicSignal =
    config.learningSignal === 'intrinsic-prediction-progress';
  if (intrinsicModeSet !== intrinsicSignal) {
    throw new LearnerConfigurationError(
      intrinsicModeSet
        ? `intrinsicMode "prediction-progress" requires learningSignal "intrinsic-prediction-progress", got "${config.learningSignal}"`
        : 'learningSignal "intrinsic-prediction-progress" requires intrinsicMode "prediction-progress" to be configured',
    );
  }
  if (intrinsicSignal) {
    return 'intrinsic-prediction-progress';
  }
  if (isHybridLearningSignal(config.learningSignal)) {
    return config.learningSignal;
  }
  throw new UnsupportedLearningSignalError(
    config.learningSignal,
    HYBRID_LEARNING_SIGNALS,
  );
}

/**
 * The approved nonverbal outcome payload is the outcome channel a reward-free
 * mode may read (SPEC §8.1 step 7); `outcome.reward` is not touched here.
 */
function successBitOf(outcome: OutcomeEvent): number {
  const bit = outcome.payload[0];
  if (bit !== undefined) {
    return bit === 1 ? 1 : 0;
  }
  return outcome.success ? 1 : 0;
}

/** Key of the world model's outcome-payload head for one turn. */
function payloadKey(record: HybridUpdateRecord): string {
  return `${record.role}:${String(record.actedCode)}:${record.messageSymbolIndices.join('.')}`;
}

function modelRefFor(context: LearnerInitContext): string {
  return context.role === 'baby-a'
    ? context.config.babyA.modelRef
    : context.config.babyB.modelRef;
}

function requireIndex(value: number | undefined): number {
  if (value === undefined) {
    throw new LearnerStateError('This turn record requires an action index');
  }
  return value;
}

function requireEncoder(
  encoder: SeededSensoryEncoder | undefined,
): SeededSensoryEncoder {
  if (encoder === undefined) {
    throw new LearnerStateError('init() must be called before any other method');
  }
  return encoder;
}

function requireWorld(
  world: PredictiveCountModel | undefined,
): PredictiveCountModel {
  if (world === undefined) {
    throw new LearnerStateError('init() must be called before any other method');
  }
  return world;
}

function requirePayload(
  payload: PayloadMeanModel | undefined,
): PayloadMeanModel {
  if (payload === undefined) {
    throw new LearnerStateError('init() must be called before any other method');
  }
  return payload;
}

function cloneRegistries(registries: HybridRegistries): HybridRegistries {
  return {
    runId: registries.runId,
    babyId: registries.babyId,
    emitted: [...registries.emitted],
    received: [...registries.received],
    hypotheses: registries.hypotheses.map((record) => ({ ...record })),
    encoderCodeTypeTally: registries.encoderCodeTypeTally.map((entry) => ({
      ...entry,
    })),
  };
}

export function createHybridAdapterFactory(
  options: HybridAdapterOptions = {},
): LearnerAdapterFactory {
  return {
    track: 'hybrid',
    create: () => new HybridAdapter(options),
  };
}
