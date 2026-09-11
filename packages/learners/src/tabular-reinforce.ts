/**
 * `scratch-rl` reference adapter: tabular REINFORCE with a moving-average
 * baseline (ALD-045, EXPERIMENT-NOTEBOOK.md E11).
 *
 * E11 asks whether independently initialized agents can learn a grounded
 * one-symbol referential protocol from task outcomes alone. This adapter is
 * the smallest honest instance of that claim: two tabular softmax policies —
 * one sender, one receiver — held privately by each Baby, updated only by that
 * Baby's own trajectories, with no shared gradients, no centralized hidden
 * state, and no text tokenizer or pretrained embedding anywhere in the
 * observation-to-action path (SPEC §6.5 items 1 and 3 hold trivially).
 *
 * SPEC §6.7 names a GRU/LSTM actor-critic with PPO-style updates as the
 * default reference implementation for this track. This package ships the
 * tabular special case: it is exactly the same interface, the same update
 * plumbing, and the same policy-checkpoint contract, but its state is small
 * enough to canonicalize, hash, diff, and reason about in evidence — which is
 * what the integrity claim needs first. A recurrent backbone can replace the
 * tables behind the identical `LearnerAdapter` seam.
 *
 * Both roles live in one adapter: roles reverse on `roleReversalPeriod`
 * (SPEC §8.1 step 9), so each Baby must hold a sender policy and a receiver
 * policy privately and update whichever it used on a given turn.
 *
 * A receiver turn may arrive with no delivered message at all: SPEC §9.6's
 * `disabled` control delivers nothing, and §8.2 forbids an interpretation
 * event when there is no channel event to reference. The receiver then acts on
 * the empty message — a uniform choice over the offered candidates, because no
 * symbol means no information — records `symbols: []` in its intention event,
 * and contributes no REINFORCE update, since there is no symbol row to credit.
 * The sender half of such a turn is updated normally. A receiver turn may
 * equally arrive with *more* symbols than this adapter emits: SPEC §9.6's
 * `random` control draws a message of any length in
 * `[1, maxSymbolsPerMessage]`, and §9.6 requires all six conditions to run
 * over the same learner interfaces. Any delivered length is therefore scored
 * on the prefix the receiver holds tables for and recorded verbatim; it is
 * never an adapter error.
 *
 * Every private draw is bound to its turn rather than to a stream position:
 * `act()` caches the action it drew and `onOutcome()` the reward it computed,
 * so a SPEC §14.5 retry of a crashed adapter call replays the same draw
 * instead of advancing the private streams and breaking §14.3 seeded replay.
 *
 * Initialization uses small, independently seeded random logits. The seed is
 * private per Baby and the resulting policy hash is recorded before the first
 * turn, satisfying E11's random-initialization requirement without exposing
 * parameters through a Baby-visible surface.
 */
import {
  HASH_DOMAINS,
  ObservationSchema,
  type DeliveredChannelArtifact,
  type LearnerAdapter,
  type LearnerAdapterFactory,
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
import { SeededPrng, hashCanonical } from '@ald/hashing';

import {
  carrierProposal,
  createCarrierSupport,
  hypothesisRefFor,
  markKey,
  messageFields,
  requireCarrierAction,
  subjectIdFor,
  termFields,
  type CarrierAdapterSupport,
  type CarrierSupportOptions,
  type DeliveredMark,
} from './carrier-support.js';
import { BlindingNonceSource, buildNoncedDraft } from './drafts.js';
import {
  LearnerConfigurationError,
  LearnerStateError,
  UnsupportedLearningSignalError,
} from './errors.js';
import {
  argmaxIndex,
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
import {
  EXPORTED_TABULAR_POLICY_VERSION,
  POLICY_DECIMALS,
  parseExportedTabularPolicy,
  tabularPolicyShape,
  type ExportedEpisodicRegistries,
  type ExportedTabularPolicy,
  type TabularPolicyOptions,
} from './policy.js';
import {
  RECURRENT_ARCHITECTURE,
  RecurrentCommunicationModel,
  type RecurrentModelOptions,
} from './recurrent-model.js';
import {
  RECURRENT_SCRATCH_POLICY_VERSION,
  parseExportedRecurrentScratchPolicy,
  type ExportedRecurrentScratchPolicy,
} from './recurrent-scratch-policy.js';

/** Learning signals this adapter can consume (SPEC §11.1, `learningSignal`). */
export const SUPPORTED_LEARNING_SIGNALS = [
  'extrinsic-task',
  'intrinsic-prediction-progress',
] as const;

export interface TabularReinforceOptions
  extends GameShapeOptions,
    CarrierSupportOptions {
  /** REINFORCE step size (default `0.3`). */
  learningRate?: number;
  /** Moving-average baseline decay (default `0.9`). */
  baselineDecay?: number;
  /** Softmax temperature for action sampling (default `1.0`). */
  temperature?: number;
  /**
   * The single intrinsic reward this reference track implements. Setting
   * this to `'prediction-progress'` and configuring
   * `RunConfig.learningSignal: 'intrinsic-prediction-progress'` are two
   * halves of one contract, not two independent switches: `init()` throws
   * `LearnerConfigurationError` unless both are set together or both are
   * left unset (SPEC §11.1 `learningSignal`). When both are set, the task
   * reward is never read.
   */
  intrinsicMode?: 'prediction-progress';
  /** Explicit scientific backbone; omit for the tabular qualification control. */
  backbone?: 'tabular-reference' | typeof RECURRENT_ARCHITECTURE;
  /** Fixed GRU/PPO parameters recorded in recurrent checkpoints. */
  recurrent?: Omit<
    RecurrentModelOptions,
    'typeCount' | 'symbolCount' | 'messageLength' | 'learningRate'
  >;
}

type RewardMode = 'extrinsic-task' | 'intrinsic-prediction-progress';

interface SenderTurnMemory {
  role: 'sender';
  turn: number;
  /** The marks emitted, in message order (SPEC §9.1/§9.2). */
  marks: DeliveredMark[];
  symbolIndices: number[];
  typeCode: number;
  /** Sender action distribution over the symbol inventory at action time. */
  probs: number[];
  /** Probability the policy assigned to the emitted message. */
  confidence: number;
  primaryEvidenceRef: string;
  reward?: number;
}

interface ReceiverTurnMemory {
  role: 'receiver';
  turn: number;
  /** Every delivered mark, verbatim, for the intention event (SPEC §8.2). */
  marks: DeliveredMark[];
  /** Form indices of the scored prefix: at most `marksPerMessage` of them. */
  symbolIndices: number[];
  candidateTypeCodes: number[];
  actionIndex: number;
  /** Receiver action distribution over candidates at action time. */
  probs: number[];
  confidence: number;
  primaryEvidenceRef: string;
  reward?: number;
}

type TurnMemory = SenderTurnMemory | ReceiverTurnMemory;

/**
 * What this Baby holds in hand for one receiver turn.
 *
 * `turn` binds the message to the turn it was delivered on:
 * `ledgerLagTurns: 0` (SPEC §8.2) means an interpretation belongs to the turn
 * that delivered it, so a message from an earlier turn is never carried into a
 * later one. A turn with no delivery — the §9.6 `disabled` control — has no
 * symbols and no channel event to reference.
 */
interface ReceivedMessage {
  turn: number;
  /** Every mark delivered, verbatim, however many arrived (SPEC §9.6). */
  marks: DeliveredMark[];
  /** Form indices of the scored prefix: at most `marksPerMessage` of them. */
  symbolIndices: number[];
  channelEventHash: string | null;
}

/** The empty message a receiver holds when nothing was delivered (§9.6). */
function emptyMessage(turn: number): ReceivedMessage {
  return { turn, marks: [], symbolIndices: [], channelEventHash: null };
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
  options: TabularPolicyOptions;
  rewardMode: RewardMode;
  /** SPEC §9.1/§9.2: how a form index becomes a public artifact (ALD-031). */
  support: CarrierAdapterSupport;
  actionStream: SeededPrng;
  nonces: BlindingNonceSource;
}

/**
 * How many completed-but-unupdated turns are retained. Bounded so a long run
 * cannot grow the adapter's private buffer without limit; the orchestrator
 * calls `updatePolicy` far more often than this in practice.
 */
const MAX_PENDING_TURNS = 4_096;

const PROBABILITY_EPSILON = 1e-6;
const INITIAL_LOGIT_SCALE = 0.01;

export class TabularReinforceAdapter implements LearnerAdapter {
  readonly track = 'scratch-rl' as const;

  private state: AdapterState | undefined;
  private thetaSender: number[][] = [];
  private thetaReceiver: number[][][] = [];
  private recurrentModel: RecurrentCommunicationModel | undefined;
  private baseline = 0;
  private observation: ParsedObservation | undefined;
  private lastReceived: ReceivedMessage | undefined;
  private readonly pending = new Map<number, TurnMemory>();
  private readonly hypotheses = new Map<string, HypothesisRecord>();
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  /** Private partner/outcome prediction model used only by the intrinsic mode. */
  private readonly predictor = new Map<string, number>();
  /**
   * The registries as of the last `updatePolicy`, i.e. the snapshot an
   * exported checkpoint carries. See `exportPolicy` for why the export lags
   * the live registries.
   */
  private registryCheckpoint: ExportedEpisodicRegistries | undefined;
  /** Hash of the initialized policy before any turn or update. */
  private initialHash: Sha256Hash | undefined;
  /** Non-fatal findings from the last `initialPolicy` load (SPEC §7.4). */
  private diagnostics: string[] = [];

  constructor(private readonly options: TabularReinforceOptions = {}) {}

  /**
   * Differences between the loaded checkpoint's hyperparameters and this
   * run's, in `name checkpointValue != runValue` form. Empty when no
   * checkpoint was loaded or when the two agree. Researcher-facing only: it is
   * never written to a ledger and never reaches a Baby's observation.
   */
  get policyLoadDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  async init(context: LearnerInitContext): Promise<void> {
    if (context.symbolInventory.length === 0) {
      throw new LearnerConfigurationError('symbolInventory must not be empty');
    }
    const shape = resolveGameShape(
      this.options,
      context.config.maxSymbolsPerMessage,
    );
    const resolved: TabularPolicyOptions = {
      valuesPerAttribute: shape.valuesPerAttribute,
      attributeCount: shape.attributeCount,
      messageLength: shape.messageLength,
      learningRate:
        this.options.learningRate ??
        (this.options.backbone === RECURRENT_ARCHITECTURE ? 0.003 : 0.3),
      baselineDecay: this.options.baselineDecay ?? 0.9,
      temperature: this.options.temperature ?? 1,
      ...(this.options.intrinsicMode === undefined
        ? {}
        : { intrinsicMode: this.options.intrinsicMode }),
    };
    if (!(resolved.learningRate > 0)) {
      throw new LearnerConfigurationError('learningRate must be positive');
    }
    if (!(resolved.temperature > 0)) {
      throw new LearnerConfigurationError('temperature must be positive');
    }
    if (resolved.baselineDecay < 0 || resolved.baselineDecay > 1) {
      throw new LearnerConfigurationError('baselineDecay must be within [0, 1]');
    }

    const prng = new SeededPrng(context.seed);
    this.state = {
      context,
      ledger: context.ledger,
      shape,
      options: resolved,
      rewardMode: resolveRewardMode(context.config, this.options),
      support: createCarrierSupport(context, shape, this.options),
      actionStream: prng.derive('scratch-rl/action'),
      nonces: new BlindingNonceSource({
        seed: context.seed,
        runId: context.runId,
        babyId: context.babyId,
      }),
    };

    const symbolCount = this.state.support.formCount;
    const policyStream = prng.derive('scratch-rl/policy-init');
    const draw = (): number =>
      roundTo(
        (policyStream.nextFloat() * 2 - 1) * INITIAL_LOGIT_SCALE,
        POLICY_DECIMALS,
      );
    this.thetaSender = Array.from({ length: shape.typeCount }, () =>
      Array.from({ length: symbolCount }, draw),
    );
    this.thetaReceiver = Array.from(
      { length: this.state.support.marksPerMessage },
      () =>
        Array.from({ length: symbolCount }, () =>
          Array.from({ length: shape.typeCount }, draw),
        ),
    );
    this.recurrentModel =
      this.options.backbone === RECURRENT_ARCHITECTURE
        ? new RecurrentCommunicationModel(context.seed, {
            typeCount: shape.typeCount,
            symbolCount,
            messageLength: this.state.support.marksPerMessage,
            learningRate: resolved.learningRate,
            ...this.options.recurrent,
          })
        : undefined;
    this.baseline = 0;
    this.observation = undefined;
    this.lastReceived = undefined;
    this.pending.clear();
    this.diagnostics = [];
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

  /** Hash of the initialized parameters before the first turn (ALD-045). */
  initialPolicyHash(): Sha256Hash {
    if (this.initialHash === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.initialHash;
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
    requireCarrierAction(turnBudget, state.support.emitKind);
    const memory = this.senderTurn(state, turnBudget.turn);
    const marks = [...memory.marks];

    const proposal = carrierProposal(state.support, memory.symbolIndices);
    const artifactRef = memory.primaryEvidenceRef;

    await this.recordFirstUse(
      state,
      turnBudget.turn,
      marks,
      'term.first_emitted',
      this.emitted,
    );

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: subjectIdFor(state.support, at(marks, 0)),
      turn: turnBudget.turn,
      content: {
        artifactRef,
        ...messageFields(state.support, marks),
        targetTypeCode: memory.typeCode,
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.probs, 6),
      },
      evidenceRefs: [artifactRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The sender action for `turn`, drawn once.
   *
   * SPEC §14.5 retries a crashed adapter call, and §14.3 requires the run to
   * replay from its recorded seed. Both hold only if the retry re-uses the
   * draw the first attempt made: a second `sampleIndex` would advance the
   * private action stream, change every later symbol, and — through the
   * event-derived nonces (LEDGER §12) — every later entry hash. The draw is
   * therefore recorded in the turn buffer *before* any ledger append, so a
   * call that fails part-way still replays identically.
   */
  private senderTurn(state: AdapterState, turn: number): SenderTurnMemory {
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
    const typeCode = at(observation.typeCodes, observation.targetIndex);
    const recurrent = this.recurrentModel;
    const distributions =
      recurrent === undefined
        ? [softmax(row(this.thetaSender, typeCode), state.options.temperature)]
        : recurrent.sender(turn, typeCode, state.options.temperature)
            .distributions;
    const probs = at(distributions, 0);

    const symbolIndices: number[] = [];
    let confidence = 1;
    for (
      let position = 0;
      position < state.support.marksPerMessage;
      position += 1
    ) {
      const distribution =
        recurrent === undefined ? probs : at(distributions, position);
      const index = state.actionStream.sampleIndex(distribution);
      symbolIndices.push(index);
      confidence *= at(distribution, index);
    }
    recurrent?.recordActions(turn, symbolIndices);
    const marks = state.support.parseDelivery(
      state.support.artifactForForms(symbolIndices),
    ).marks;
    const artifactRef = `proposal:${hashCanonical(
      HASH_DOMAINS.babyProposal,
      carrierProposal(state.support, symbolIndices),
    )}`;

    const memory: SenderTurnMemory = {
      role: 'sender',
      turn,
      marks,
      symbolIndices,
      typeCode,
      probs,
      confidence,
      primaryEvidenceRef: artifactRef,
    };
    this.remember(memory);
    return memory;
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
    const memory = this.receiverTurn(state, turnBudget.turn, received, candidateRefs);
    const objectRef = at(candidateRefs, memory.actionIndex);

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
        ...messageFields(state.support, memory.marks),
        selection: objectRef,
        /** The type code of the candidate this Baby intends to refer to. */
        targetTypeCode: at(memory.candidateTypeCodes, memory.actionIndex),
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.probs, 6),
      },
      evidenceRefs:
        channelRef === undefined ? [artifactRef] : [artifactRef, channelRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The receiver action for `turn`, drawn once (see `senderTurn` for why the
   * draw is cached rather than repeated).
   *
   * SPEC §9.6 `disabled`: no artifact is delivered, so the receiver acts with
   * an empty message. `candidateScores` then sums over no symbol rows and the
   * softmax is exactly uniform over the candidates: no symbol, no information,
   * chance behavior — which is what the control measures.
   */
  private receiverTurn(
    state: AdapterState,
    turn: number,
    received: ReceivedMessage,
    candidateRefs: readonly string[],
  ): ReceiverTurnMemory {
    const cached = this.pending.get(turn);
    if (cached !== undefined && cached.role === 'receiver') {
      return cached;
    }
    const candidateTypeCodes = this.receiverCandidateTypeCodes(
      candidateRefs.length,
    );
    const recurrent = this.recurrentModel;
    const probs =
      recurrent === undefined
        ? softmax(
            this.candidateScores(received.symbolIndices, candidateTypeCodes),
            state.options.temperature,
          )
        : at(
            recurrent.receiver(
              turn,
              received.symbolIndices,
              candidateTypeCodes,
              state.options.temperature,
            ).distributions,
            0,
          );
    const actionIndex = state.actionStream.sampleIndex(probs);
    recurrent?.recordActions(turn, [actionIndex]);
    // The hypothesis events of this turn are evidenced by the delivered
    // channel event where there was one, and by this Baby's own proposal
    // otherwise (§8.2: no channel event, no channel reference).
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
      kind: 'select_object' as const,
      publicArtifact: { objectRef: at(candidateRefs, actionIndex) },
    })}`;

    const memory: ReceiverTurnMemory = {
      role: 'receiver',
      turn,
      marks: [...received.marks],
      symbolIndices: [...received.symbolIndices],
      candidateTypeCodes,
      actionIndex,
      probs,
      confidence: at(probs, actionIndex),
      primaryEvidenceRef:
        received.channelEventHash === null
          ? artifactRef
          : `channel:${received.channelEventHash}`,
    };
    this.remember(memory);
    return memory;
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const delivered = state.support.observeDelivery(
      delivery.publicArtifact,
      delivery.turn,
    );
    const marks = delivered.marks;
    const unknownSymbol = marks.find((mark) => mark.formIndex === null);
    if (state.support.symbolic && unknownSymbol !== undefined) {
      throw new LearnerStateError(
        `Symbol ${unknownSymbol.formId} is not in the inventory`,
      );
    }
    // SPEC §9.6 `random` delivers a uniformly drawn message of any length in
    // `[1, maxSymbolsPerMessage]`, and §9.6 requires every condition to run
    // over the same scenarios and learner interfaces — so a delivered length
    // that differs from this adapter's configured `messageLength` is a legal
    // artifact, not a protocol error. The policy scores the delivered prefix
    // it holds receiver tables for; a shorter message simply leaves the
    // trailing positions absent, and any symbol past `messageLength` is
    // unscored but still recorded verbatim in the interpretation event (§8.2).
    const scored = marks.slice(0, state.support.marksPerMessage);
    const symbolIndices = scored.flatMap((mark) =>
      mark.formIndex === null ? [] : [mark.formIndex],
    );
    this.lastReceived = {
      turn: delivery.turn,
      marks,
      symbolIndices,
      channelEventHash: delivery.channelEventHash,
    };

    await this.recordFirstUse(
      state,
      delivery.turn,
      marks,
      'term.first_received',
      this.received,
    );

    const candidateTypeCodes = this.observation?.view === 'receiver'
      ? [...this.observation.typeCodes]
      : [];
    const inferredDistribution = candidateTypeCodes.length > 0
      ? softmax(
          this.candidateScores(symbolIndices, candidateTypeCodes),
          state.options.temperature,
        )
      : [];
    const argmaxCandidateIndex = argmaxIndex(inferredDistribution);

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'interpretation.recorded',
      subjectId: subjectIdFor(state.support, at(marks, 0)),
      turn: delivery.turn,
      content: {
        artifactRef: delivery.channelEventHash,
        ...messageFields(state.support, marks),
        candidateTypeCodes,
        inferredDistribution: roundAll(inferredDistribution, 6),
        argmaxCandidateIndex,
        confidence: roundTo(
          argmaxCandidateIndex < 0 ? 0 : at(inferredDistribution, argmaxCandidateIndex),
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
   * Stores the turn's reward and appends this Baby's hypothesis events. The
   * association weights written here are read from the pre-update tables, so a
   * hypothesis event always describes the state that produced the behavior it
   * is evidence about.
   *
   * The reward is computed at most once per turn. SPEC §14.5 retries a crashed
   * adapter call, and in `intrinsic-prediction-progress` mode computing the
   * reward *is* a state change — `predictionProgressReward` steps the private
   * predictor — so a second computation for the same turn would return a
   * different reward, move the checkpoint hash, and make the run
   * irreproducible from its seed (§14.3).
   */
  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    const state = this.requireState();
    const memory = this.pending.get(outcome.turn);
    if (memory === undefined) {
      // An outcome for a turn this Baby did not act on (a rejected proposal,
      // or a deferred interpretation under `ledgerLagTurns`). Nothing to bind.
      return;
    }

    const successBit = successBitOf(outcome);
    if (memory.reward === undefined) {
      memory.reward =
        state.rewardMode === 'extrinsic-task'
          ? (outcome.reward ?? successBit)
          : this.predictionProgressReward(state, memory, successBit);
    }
    if (
      this.recurrentModel !== undefined &&
      !(memory.role === 'receiver' && memory.symbolIndices.length === 0)
    ) {
      this.recurrentModel.recordReward(outcome.turn, memory.reward);
    }

    await this.recordHypotheses(state, memory, successBit);
  }

  /**
   * REINFORCE with a moving-average baseline:
   * `theta[state][a] += lr * (r - b) * (onehot(a) - probs)`, applied to
   * whichever policy produced each turn in the batch. The `1/temperature`
   * factor of the softmax Jacobian is folded into the learning rate.
   *
   * Only this Baby's own recorded trajectories are read: no partner buffer, no
   * shared gradients, no optimizer state outside this object (SPEC §6.2,
   * §10.4).
   */
  async updatePolicy(batch: UpdateBatch): Promise<PolicyCheckpointRef> {
    const state = this.requireState();
    if (!isSupportedLearningSignal(batch.learningSignal)) {
      throw new UnsupportedLearningSignalError(
        batch.learningSignal,
        SUPPORTED_LEARNING_SIGNALS,
      );
    }
    if (batch.learningSignal !== state.rewardMode) {
      throw new UnsupportedLearningSignalError(
        batch.learningSignal,
        [state.rewardMode],
      );
    }

    state.support.commitObservedForms(batch.turns);

    if (this.recurrentModel !== undefined) {
      const highestTurn = batch.turns.reduce(
        (highest, turn) => Math.max(highest, turn),
        0,
      );
      this.recurrentModel.updateReinforcement(batch.turns);
      for (const turn of batch.turns) this.pending.delete(turn);
      this.registryCheckpoint = this.snapshotRegistries(state);
      const policy = this.exportPolicy();
      const policyHash = hashCanonical(HASH_DOMAINS.policyCheckpoint, policy);
      return {
        policyCheckpointRef: `policy:${policyHash}`,
        policyHash,
        turn: highestTurn,
      };
    }

    const learningRate = state.options.learningRate;
    let highestTurn = 0;

    for (const turn of [...batch.turns].sort((left, right) => left - right)) {
      highestTurn = Math.max(highestTurn, turn);
      const memory = this.pending.get(turn);
      if (memory === undefined || memory.reward === undefined) {
        continue;
      }
      if (memory.role === 'receiver' && memory.symbolIndices.length === 0) {
        // SPEC §9.6 `disabled`: nothing was delivered, so there is no symbol
        // row to credit and no receiver trajectory to reinforce. The baseline
        // is left alone as well — an empty-message turn carries no evidence
        // about the policy, and moving the baseline would change the exported
        // policy hash for a turn the policy did not act on.
        this.pending.delete(turn);
        continue;
      }
      const reward = memory.reward;
      const advantage = reward - this.baseline;

      if (memory.role === 'sender') {
        const logits = row(this.thetaSender, memory.typeCode);
        for (const chosen of memory.symbolIndices) {
          for (let index = 0; index < logits.length; index += 1) {
            const indicator = index === chosen ? 1 : 0;
            logits[index] =
              at(logits, index) +
              learningRate * advantage * (indicator - at(memory.probs, index));
          }
        }
      } else {
        memory.candidateTypeCodes.forEach((typeCode, candidate) => {
          const indicator = candidate === memory.actionIndex ? 1 : 0;
          const delta =
            learningRate * advantage * (indicator - at(memory.probs, candidate));
          memory.symbolIndices.forEach((symbolIndex, position) => {
            const table = this.receiverTable(position);
            const logits = row(table, symbolIndex);
            logits[typeCode] = at(logits, typeCode) + delta;
          });
        });
      }

      this.baseline =
        state.options.baselineDecay * this.baseline +
        (1 - state.options.baselineDecay) * reward;
      this.pending.delete(turn);
    }

    // The checkpoint advances the episodic registries in lock-step with the
    // learned tables (see `exportPolicy`).
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
   * The canonicalizable checkpoint: the learned tables plus the episodic
   * registries this Baby needs to keep writing to the same ledger chain after
   * a SPEC §7.3 re-initialization.
   *
   * The registry half is the snapshot taken by the last `updatePolicy`, not
   * the live registries. That is what keeps the policy-checkpoint hash
   * constant across an evaluation phase: SPEC §7.2 disables `updatePolicy`
   * once evaluation starts, so nothing in the export can move — while a
   * *live* registry would still grow the first time an evaluation turn
   * received a symbol this Baby had never seen, silently changing the policy
   * hash of a policy that did not change. The cost is that a recovery loses
   * the registry entries added after the last checkpoint, which is exactly
   * the checkpoint semantics of SPEC §7.3 and, in the runtime, at most one
   * turn's worth (`NurseryRuntime` calls `updatePolicy` every training turn).
   */
  exportPolicy(): ExportedTabularPolicy | ExportedRecurrentScratchPolicy {
    const state = this.requireState();
    if (this.recurrentModel !== undefined) {
      return {
        version: RECURRENT_SCRATCH_POLICY_VERSION,
        track: 'scratch-rl',
        architecture: RECURRENT_ARCHITECTURE,
        updateRule: this.recurrentModel.export().rlObjective,
        options: {
          valuesPerAttribute: state.options.valuesPerAttribute,
          attributeCount: state.options.attributeCount,
          messageLength: state.options.messageLength,
          temperature: state.options.temperature,
          learningRate: state.options.learningRate,
          baselineDecay: state.options.baselineDecay,
          ...(state.options.intrinsicMode === undefined
            ? {}
            : { intrinsicMode: state.options.intrinsicMode }),
        },
        model: this.recurrentModel.export(),
        registries: cloneRegistries(
          this.registryCheckpoint ?? this.snapshotRegistries(state),
        ),
        carrierState: state.support.exportLearningState(),
      };
    }
    return {
      version: EXPORTED_TABULAR_POLICY_VERSION,
      thetaSender: roundMatrix(this.thetaSender, POLICY_DECIMALS),
      thetaReceiver: this.thetaReceiver.map((table) =>
        roundMatrix(table, POLICY_DECIMALS),
      ),
      baseline: roundTo(this.baseline, POLICY_DECIMALS),
      options: { ...state.options },
      registries: cloneRegistries(
        this.registryCheckpoint ?? this.snapshotRegistries(state),
      ),
      carrierState: state.support.exportLearningState(),
    };
  }

  /** Self-declared, hash-bound inputs for the independent §6.5 battery. */
  describeProvenance(): LearnerProvenance {
    const state = this.requireState();
    const recurrent = this.recurrentModel;
    const componentName =
      recurrent === undefined
        ? 'tabular-communication-policy'
        : RECURRENT_ARCHITECTURE;
    return {
      track: 'scratch-rl',
      modelRef:
        state.context.role === 'baby-a'
          ? state.context.config.babyA.modelRef
          : state.context.config.babyB.modelRef,
      textTokenizerPresent: false,
      textAlignedEncoderPresent: false,
      weightUpdatePath: 'private-buffers-only',
      components: [
        {
          name: componentName,
          kind: 'communication-policy',
          provenance:
            state.context.initialPolicy === undefined
              ? 'random-init'
              : 'derived-run-policy',
          hash: this.initialPolicyHash(),
          textAligned: false,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * `intrinsic-prediction-progress` (a researcher-chosen inductive bias, not a
   * discovered mechanism — SPEC §18 lists `learningSignal` as an experiment
   * variable and CONCEPT-IDEA.md §19.4 as an explicit design choice).
   *
   * The adapter keeps a private prediction model `q(key)` of the probability
   * that the episode's approved nonverbal outcome bit is 1. The key is the
   * agent-native state that produced the action — the received symbol indices
   * for a receiver turn, the target type code for a sender turn — and `q` is
   * seeded with the policy's own confidence in the action it chose, which is
   * exactly "the receiver predicts which candidate it would pick, before
   * seeing the outcome". When the outcome bit `o` arrives, `q` takes one
   * moving-average step toward `o` with rate `1 - baselineDecay`, and the
   * reward is the reduction in surprise:
   *
   *   `r = log q_after(o) - log q_before(o) >= 0`
   *
   * i.e. learning progress about the partner, never the task reward. The task
   * reward field is not read in this mode at all; the outcome bit comes from
   * the nonverbal `payload` both Babies receive (SPEC §8.1 step 7), which is
   * the same information a reward-free learner is allowed to observe.
   * Prediction progress is largest where the model was most wrong, so the
   * baseline-centered advantage reinforces actions that reduce uncertainty
   * rather than actions that succeed.
   */
  private predictionProgressReward(
    state: AdapterState,
    memory: TurnMemory,
    successBit: number,
  ): number {
    const key =
      memory.role === 'sender'
        ? `sender:${memory.typeCode}`
        : `receiver:${memory.symbolIndices.join('.')}`;
    const before = clampProbability(
      this.predictor.get(key) ?? memory.confidence,
    );
    const rate = 1 - state.options.baselineDecay;
    const after = clampProbability(before + rate * (successBit - before));
    this.predictor.set(key, after);

    const likelihoodBefore = successBit === 1 ? before : 1 - before;
    const likelihoodAfter = successBit === 1 ? after : 1 - after;
    return Math.log(likelihoodAfter) - Math.log(likelihoodBefore);
  }

  /**
   * CONCEPT-IDEA.md §11.2 rules 1, 3 and 5: the first use of a term is
   * recorded, a changed argmax appends a revision that references the prior
   * hypothesis rather than overwriting it, and contradictory evidence against
   * a confident hypothesis is preserved as its own event.
   *
   * The bookkeeping is only advanced *after* the corresponding append
   * resolves. SPEC §14.5 retries a failed adapter call, and a retry must be
   * able to re-emit the event it lost: mutating first would leave the map
   * claiming a `hypothesis.created` that was never written, and every later
   * revision would then name a `priorHypothesisRef` that resolves to nothing
   * (LEDGER §5). Re-emitting a duplicate is recoverable for an auditor;
   * a dangling reference is not. The nonce is derived from the event itself
   * (LEDGER §12), so a retry that re-appends an already-committed event
   * reproduces it byte for byte rather than forking it.
   */
  private async recordHypotheses(
    state: AdapterState,
    memory: TurnMemory,
    successBit: number,
  ): Promise<void> {
    const positionsBySymbol = new Map<number, number[]>();
    memory.symbolIndices.forEach((symbolIndex, position) => {
      const positions = positionsBySymbol.get(symbolIndex) ?? [];
      positions.push(position);
      positionsBySymbol.set(symbolIndex, positions);
    });

    for (const [symbolIndex, positions] of positionsBySymbol) {
      const mark = memory.marks.find(
        (candidate) => candidate.formIndex === symbolIndex,
      );
      if (mark === undefined) {
        throw new LearnerStateError(
          `No delivered mark corresponds to form index ${String(symbolIndex)}`,
        );
      }
      const key = markKey(state.support, mark);
      const association = softmax(
        this.associationRow(symbolIndex, positions),
        state.options.temperature,
      );
      const argmaxTypeCode = argmaxIndex(association);
      const confidence = at(association, argmaxTypeCode);
      const evidenceRefs = [
        memory.primaryEvidenceRef,
        `outcome:${memory.turn}`,
      ];
      const shared = {
        ...termFields(state.support, mark),
        associationOverTypeCodes: roundAll(association, 6),
        argmaxTypeCode,
        confidence: roundTo(confidence, 6),
        evidenceRefs,
      };
      const previous = this.hypotheses.get(key);

      if (previous === undefined) {
        const hypothesisRef = hypothesisRefFor(state.support, mark.formId, 1);
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.created',
            subjectId: subjectIdFor(state.support, mark),
            turn: memory.turn,
            content: { ...shared, hypothesisRef },
            evidenceRefs,
          }),
        );
        this.hypotheses.set(key, {
          version: 1,
          hypothesisRef,
          argmaxTypeCode,
        });
        continue;
      }

      if (previous.argmaxTypeCode !== argmaxTypeCode) {
        const version = previous.version + 1;
        const hypothesisRef = hypothesisRefFor(
          state.support,
          mark.formId,
          version,
        );
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.revised',
            subjectId: subjectIdFor(state.support, mark),
            turn: memory.turn,
            content: {
              ...shared,
              hypothesisRef,
              priorHypothesisRef: previous.hypothesisRef,
            },
            evidenceRefs,
          }),
        );
        this.hypotheses.set(key, { version, hypothesisRef, argmaxTypeCode });
        continue;
      }

      if (successBit === 0 && confidence > 0.5) {
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.contradicted',
            subjectId: subjectIdFor(state.support, mark),
            turn: memory.turn,
            content: {
              ...shared,
              hypothesisRef: previous.hypothesisRef,
              evidenceRef: `outcome:${memory.turn}`,
            },
            evidenceRefs,
          }),
        );
      }
    }
  }

  /**
   * The receiver-side association logits for one symbol, summed over the
   * message positions it occupied in the episode being recorded.
   */
  private associationRow(symbolIndex: number, positions: number[]): number[] {
    const state = this.requireState();
    const used = positions.length > 0 ? positions : [0];
    if (this.recurrentModel !== undefined) {
      const symbols = Array.from(
        { length: Math.max(...used) + 1 },
        () => symbolIndex,
      );
      return this.recurrentModel
        .predictCandidates(
          symbols,
          Array.from({ length: state.shape.typeCount }, (_, index) => index),
        )
        .map((probability) => Math.log(Math.max(1e-12, probability)));
    }
    const association = new Array<number>(state.shape.typeCount).fill(0);
    for (const position of used) {
      const logits = row(this.receiverTable(position), symbolIndex);
      for (let typeCode = 0; typeCode < association.length; typeCode += 1) {
        association[typeCode] = at(association, typeCode) + at(logits, typeCode);
      }
    }
    return association;
  }

  private candidateScores(
    symbolIndices: readonly number[],
    candidateTypeCodes: readonly number[],
  ): number[] {
    if (this.recurrentModel !== undefined) {
      return this.recurrentModel
        .predictCandidates(symbolIndices, candidateTypeCodes)
        .map((probability) => Math.log(Math.max(1e-12, probability)));
    }
    return candidateTypeCodes.map((typeCode) => {
      let score = 0;
      symbolIndices.forEach((symbolIndex, position) => {
        score += at(row(this.receiverTable(position), symbolIndex), typeCode);
      });
      return score;
    });
  }

  private receiverTable(position: number): number[][] {
    const table = this.thetaReceiver[position];
    if (table === undefined) {
      throw new LearnerStateError(`No receiver table for position ${position}`);
    }
    return table;
  }

  private receiverCandidateTypeCodes(expected: number): number[] {
    const observation = this.requireObservation();
    if (observation.view !== 'receiver') {
      throw new LearnerStateError(
        'A receiver turn requires a receiver-view observation',
      );
    }
    if (observation.typeCodes.length !== expected) {
      throw new LearnerStateError(
        `Observation has ${observation.typeCodes.length} candidate rows but ${expected} candidateRefs`,
      );
    }
    return [...observation.typeCodes];
  }

  private remember(memory: TurnMemory): void {
    if (this.pending.size >= MAX_PENDING_TURNS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(memory.turn, memory);
  }

  /**
   * CONCEPT-IDEA.md §11.2 rule 1. The symbol is marked as seen only once its
   * `term.first_*` event is durable, so a SPEC §14.5 retry of a failed
   * `act`/`receive` re-emits the event it lost instead of silently swallowing
   * the only record of that term's first use.
   */
  private async recordFirstUse(
    state: AdapterState,
    turn: number,
    marks: readonly DeliveredMark[],
    eventType: 'term.first_emitted' | 'term.first_received',
    seen: Set<string>,
  ): Promise<void> {
    for (const mark of marks) {
      const key = markKey(state.support, mark);
      if (seen.has(key)) {
        continue;
      }
      const draft: LedgerEventDraft = buildNoncedDraft(state.nonces, {
        eventType,
        subjectId: subjectIdFor(state.support, mark),
        turn,
        content: {
          ...termFields(state.support, mark),
          firstUse: eventType === 'term.first_emitted' ? 'emitted' : 'received',
        },
      });
      await state.ledger.append(draft);
      seen.add(key);
    }
  }

  /**
   * Resume from a recorded policy checkpoint: a derived run (SPEC §7.4) or a
   * crash recovery that re-initializes this adapter mid-run (SPEC §7.3).
   *
   * The checkpoint's *attribute space* is compared, not only its table
   * dimensions. Two different game shapes can share a cardinality — a 2-value,
   * 4-attribute space and a 4-value, 2-attribute space both give 16 type codes
   * — and `typeCodeFromAttributes` decodes the same integer to entirely
   * different objects in the two, so a checkpoint loaded across that boundary
   * would silently index the parent's logits by the child's meanings while
   * `parentRunId`/`derivedFromCheckpointHash` assert an unbroken lineage
   * (SPEC §7.4). Refusing here is the only place the mismatch is visible
   * before the derived run's evidence is sealed.
   *
   * Hyperparameters are a weaker case: re-tuning `learningRate`,
   * `temperature`, or `baselineDecay` for a derived run is a legitimate
   * experiment, not a lineage error. A difference is recorded in
   * `policyLoadDiagnostics` for the researcher rather than refused.
   */
  private loadPolicy(value: unknown): void {
    const state = this.requireState();
    if (this.recurrentModel !== undefined) {
      const policy = parseExportedRecurrentScratchPolicy(value);
      const mismatches: string[] = [];
      for (const [name, checkpointValue, runValue] of [
        [
          'attributeCount',
          policy.options.attributeCount,
          state.shape.attributeCount,
        ],
        [
          'valuesPerAttribute',
          policy.options.valuesPerAttribute,
          state.shape.valuesPerAttribute,
        ],
        [
          'messageLength',
          policy.options.messageLength,
          state.support.marksPerMessage,
        ],
        [
          'symbolCount',
          policy.model.options.symbolCount,
          state.support.formCount,
        ],
      ] as const) {
        if (checkpointValue !== runValue) {
          mismatches.push(`${name} ${checkpointValue} != ${runValue}`);
        }
      }
      if (mismatches.length > 0) {
        throw new LearnerConfigurationError(
          `initialPolicy shape does not match this run configuration: ${mismatches.join(', ')}`,
        );
      }
      this.recurrentModel.restore(policy.model);
      if (policy.version === RECURRENT_SCRATCH_POLICY_VERSION) {
        state.support.restoreLearningState(policy.carrierState);
      }
      this.restoreRegistries(policy.registries);
      this.diagnostics = [];
      for (const [name, checkpointValue, runValue] of [
        [
          'learningRate',
          policy.options.learningRate,
          state.options.learningRate,
        ],
        ['temperature', policy.options.temperature, state.options.temperature],
        [
          'baselineDecay',
          policy.options.baselineDecay,
          state.options.baselineDecay,
        ],
      ] as const) {
        if (checkpointValue !== runValue) {
          this.diagnostics.push(`${name} ${checkpointValue} != ${runValue}`);
        }
      }
      return;
    }
    const policy = parseExportedTabularPolicy(value);
    const shape = tabularPolicyShape(policy);
    const mismatches: string[] = [];
    for (const [name, checkpointValue, runValue] of [
      ['typeCount', shape.typeCount, state.shape.typeCount],
      ['symbolCount', shape.symbolCount, state.support.formCount],
      ['messageLength', shape.messageLength, state.support.marksPerMessage],
      [
        'attributeCount',
        policy.options.attributeCount,
        state.shape.attributeCount,
      ],
      [
        'valuesPerAttribute',
        policy.options.valuesPerAttribute,
        state.shape.valuesPerAttribute,
      ],
    ] as const) {
      if (checkpointValue !== runValue) {
        mismatches.push(`${name} ${checkpointValue} != ${runValue}`);
      }
    }
    if (mismatches.length > 0) {
      throw new LearnerConfigurationError(
        `initialPolicy shape does not match this run configuration: ${mismatches.join(', ')}`,
      );
    }

    this.diagnostics = [];
    for (const [name, checkpointValue, runValue] of [
      ['learningRate', policy.options.learningRate, state.options.learningRate],
      ['temperature', policy.options.temperature, state.options.temperature],
      ['baselineDecay', policy.options.baselineDecay, state.options.baselineDecay],
    ] as const) {
      if (checkpointValue !== runValue) {
        this.diagnostics.push(`${name} ${checkpointValue} != ${runValue}`);
      }
    }

    this.thetaSender = policy.thetaSender.map((logits) => [...logits]);
    this.thetaReceiver = policy.thetaReceiver.map((table) =>
      table.map((logits) => [...logits]),
    );
    this.baseline = policy.baseline;
    if (policy.version === EXPORTED_TABULAR_POLICY_VERSION) {
      state.support.restoreLearningState(policy.carrierState);
    }
    this.restoreRegistries(policy.registries);
  }

  /**
   * Reset the episodic registries, restoring them from a checkpoint when that
   * checkpoint describes *this* run and this Baby.
   *
   * The scoping is the difference between the two ways a checkpoint is
   * loaded. SPEC §7.3 recovery re-initializes the adapter against the ledger
   * chain it has already written to, so the registries must come back or the
   * Baby re-records first uses and re-issues `hyp:<symbol>:1` for a different
   * hypothesis. A derived run (SPEC §7.4) inherits the same learned tables but
   * starts a *fresh* chain under a new `runId`, where no term has a first-use
   * event yet and no hypothesis reference exists to revise — so it must start
   * empty. A version 1 checkpoint carries no registries and is treated as the
   * derived-run case.
   */
  private restoreRegistries(
    registries: ExportedEpisodicRegistries | undefined,
  ): void {
    const state = this.requireState();
    this.hypotheses.clear();
    this.emitted.clear();
    this.received.clear();
    this.predictor.clear();

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
      for (const entry of registries.predictor) {
        this.predictor.set(entry.key, entry.value);
      }
    }

    this.registryCheckpoint = this.snapshotRegistries(state);
  }

  /**
   * The live registries in canonical (sorted) form, so the exported checkpoint
   * hashes identically however the entries were discovered.
   */
  private snapshotRegistries(state: AdapterState): ExportedEpisodicRegistries {
    return {
      runId: state.context.runId,
      babyId: state.context.babyId,
      emitted: [...this.emitted].sort(compareStrings),
      received: [...this.received].sort(compareStrings),
      hypotheses: [...this.hypotheses.entries()]
        .map(([symbol, record]) => ({ symbol, ...record }))
        .sort((left, right) => compareStrings(left.symbol, right.symbol)),
      predictor: [...this.predictor.entries()]
        .map(([key, value]) => ({ key, value: roundTo(value, POLICY_DECIMALS) }))
        .sort((left, right) => compareStrings(left.key, right.key)),
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

  /**
   * The message this Baby is answering on `turn`.
   *
   * A receiver turn without a delivery is legitimate — the §9.6 `disabled`
   * control delivers nothing at all — so the absence of a message is not an
   * error, it is the empty message. Binding the lookup to the turn keeps
   * `ledgerLagTurns: 0` honest: a message delivered on an earlier turn is
   * never reused as if it had just arrived.
   */
  private receivedFor(turn: number): ReceivedMessage {
    const received = this.lastReceived;
    return received !== undefined && received.turn === turn
      ? received
      : emptyMessage(turn);
  }
}

function isSupportedLearningSignal(value: string): value is RewardMode {
  return (SUPPORTED_LEARNING_SIGNALS as readonly string[]).includes(value);
}

/**
 * `intrinsicMode` and `RunConfig.learningSignal` are one contract, not two
 * independent switches (SPEC §11.1 `learningSignal`; §6.2 — tracks differ
 * only in the reward/update-rule fields of `UpdateBatch`). `updatePolicy`
 * requires `batch.learningSignal === state.rewardMode`, and the batch signal
 * a caller can supply is always `RunConfig.learningSignal` — so any
 * combination where the resolved reward mode disagrees with the configured
 * signal would initialize cleanly and then reject every `updatePolicy` call.
 * Rejecting the mismatch here, at `init()`, surfaces the misconfiguration
 * once instead of mid-run.
 */
function resolveRewardMode(
  config: Pick<RunConfig, 'learningSignal'>,
  options: TabularReinforceOptions,
): RewardMode {
  const intrinsicModeSet = options.intrinsicMode === 'prediction-progress';
  const intrinsicSignal = config.learningSignal === 'intrinsic-prediction-progress';
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
  if (isSupportedLearningSignal(config.learningSignal)) {
    return config.learningSignal;
  }
  throw new UnsupportedLearningSignalError(
    config.learningSignal,
    SUPPORTED_LEARNING_SIGNALS,
  );
}

/**
 * The approved nonverbal outcome payload is the only outcome channel a
 * reward-free learner may read (SPEC §8.1 step 7). `outcome.reward` is never
 * touched here.
 */
function successBitOf(outcome: OutcomeEvent): number {
  const bit = outcome.payload[0];
  if (bit !== undefined) {
    return bit === 1 ? 1 : 0;
  }
  return outcome.success ? 1 : 0;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, value));
}

/** Code-unit ordering, so a canonical snapshot does not depend on a locale. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Defensive copy: `exportPolicy()` hands its result to callers that keep it. */
function cloneRegistries(
  registries: ExportedEpisodicRegistries,
): ExportedEpisodicRegistries {
  return {
    runId: registries.runId,
    babyId: registries.babyId,
    emitted: [...registries.emitted],
    received: [...registries.received],
    hypotheses: registries.hypotheses.map((record) => ({ ...record })),
    predictor: registries.predictor.map((entry) => ({ ...entry })),
  };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`Index ${index} is outside the table`);
  }
  return value;
}

function row(matrix: number[][], index: number): number[] {
  const value = matrix[index];
  if (value === undefined) {
    throw new LearnerStateError(`Row ${index} is outside the table`);
  }
  return value;
}

export function createTabularReinforceAdapterFactory(
  options: TabularReinforceOptions = {},
): LearnerAdapterFactory {
  return {
    track: 'scratch-rl',
    create: () => new TabularReinforceAdapter(options),
  };
}

/** Scientific E11 factory: fixed GRU actor-critic with PPO-style updates. */
export function createRecurrentActorCriticAdapterFactory(
  options: Omit<TabularReinforceOptions, 'backbone'> = {},
): LearnerAdapterFactory {
  return createTabularReinforceAdapterFactory({
    ...options,
    backbone: RECURRENT_ARCHITECTURE,
  });
}
