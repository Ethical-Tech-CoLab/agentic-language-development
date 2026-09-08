/**
 * `self-supervised` reference adapter: reward-free mutual prediction
 * (ALD-046, EXPERIMENT-NOTEBOOK.md E12).
 *
 * SPEC §6.1: "Randomly initialized encoder/policy trained only to predict
 * observations/partner behavior, no scalar reward"; claim boundary "tests
 * emergence without external or intrinsic reward signal". SPEC §6.7 asks for
 * the same backbone as `scratch-rl` with a "predictive/contrastive loss in
 * place of a scalar reward", and SPEC §6.2 requires the tracks to differ only
 * in the reward/update-rule fields of `UpdateBatch`. This adapter is the
 * tabular instance of that: it shares `game.ts`'s observation parsing, type
 * codes and turn protocol with `tabular-reinforce.ts`, shares `drafts.ts`'s
 * ledger conventions, and replaces REINFORCE with the single pre-registered
 * predictive loss named by `PREDICTIVE_LOSS_DEFINITION`.
 *
 * Coordination, where it appears at all, comes only from prediction:
 *
 * - as receiver, the adapter selects the candidate under which the message it
 *   actually received is most probable (`candidatePosterior` argmax);
 * - as sender, it reads the same model as "what message would a partner
 *   produce for these features" and samples from it under a temperature and a
 *   pre-registered exploration rate.
 *
 * E12's hypothesis is explicitly that this "may produce weaker task-directed
 * coordination than RL". Nothing here is tuned to make it look otherwise, and
 * this module makes no claim about what it achieves; the tests assert
 * determinism and contract behaviour, and the observed success rate is
 * reported as a measurement.
 *
 * Reward-freeness is enforced three ways, which is what ALD-046 cb 1 and
 * cb 3 ask for:
 *
 * 1. `init` refuses any run whose `learningSignal` is not `self-supervised`,
 *    and `updatePolicy` refuses any batch whose signal is not
 *    `self-supervised`;
 * 2. `onOutcome` refuses a non-null `OutcomeEvent.reward`
 *    (`ScalarRewardRefusedError`) and reads nothing else off the outcome — not
 *    `success`, not `payload`. The `reward` field is examined as a property
 *    *descriptor* and never through an accessor, so the conformance harness's
 *    `rewardVisibility: 'forbidden'` probe (a getter that throws when read)
 *    passes: the value is compared against `null` and never stored, used or
 *    logged;
 * 3. the private update buffer holds exactly
 *    `{ turn, role, candidateTypeCodes, messageSymbolIndices,
 *    targetIndexIfSender? }` and the exported policy holds only the predictive
 *    model, its options and this Baby's episodic registries. No `success`,
 *    `reward` or `outcome` key exists in either, which
 *    `__tests__/self-supervised.test.ts` asserts structurally.
 *
 * Initialization is a seeded random draw (`priorNoise`), not all-zero: SPEC
 * §6.1 says "randomly initialized", and ALD-046 cb 1 requires the initial
 * state to be recorded. `initialPolicyHash()` is the hash of `exportPolicy()`
 * taken at the end of `init()`; the runtime records it in the evidence bundle
 * (see this task's integrator notes for the exact seam). Two Babies with
 * different private seeds therefore start from different, recorded points.
 *
 * As in the tabular track, every private draw is bound to its turn rather
 * than to a stream position: `act()` caches the action it drew, so a SPEC
 * §14.5 retry of a crashed adapter call replays the same draw instead of
 * advancing the private stream and breaking §14.3 seeded replay.
 */
import {
  HASH_DOMAINS,
  ObservationSchema,
  type CurriculumStage,
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
  extractSymbols,
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  roundTo,
  softmax,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';
import { HypothesisRecordSchema } from './policy.js';
import {
  ExportedPredictiveModelSchema,
  PREDICTIVE_LOSS_DEFINITION,
  PREDICTIVE_PAIRING_RULE,
  PredictiveCountModel,
  at,
  compareStrings,
  lowestArgmax,
  mixWithUniform,
} from './predictive-model.js';

/** The only learning signal this track can consume (SPEC §11.1). */
export const SELF_SUPERVISED_LEARNING_SIGNAL = 'self-supervised' as const;

/**
 * A scalar reward reached the reward-free update path.
 *
 * BACKLOG ALD-046 acceptance criterion 1: the track "rejects any scalar reward
 * supplied to its update path". Declared here rather than in `errors.ts`
 * because this workstream does not own that module; the integrator should move
 * it there and add its name to that file's closed error-name set.
 */
export class ScalarRewardRefusedError extends Error {
  override readonly name = 'ScalarRewardRefusedError';

  constructor(readonly where: string) {
    super(
      `A scalar reward reached the self-supervised update path at ${where}; ` +
        'this track consumes no scalar reward (SPEC §6.1, BACKLOG ALD-046 ' +
        'acceptance criterion 1)',
    );
  }
}

export interface SelfSupervisedAdapterOptions extends GameShapeOptions {
  /** Softmax temperature for the sender's predictive sampling (default `1`). */
  temperature?: number;
  /** Uniform mixing applied to the sender's distribution (default `0.1`). */
  explorationRate?: number;
  /** Laplace pseudo-count in the predictive model (default `1`). */
  smoothing?: number;
  /** Magnitude of the seeded random initialization (default `0.25`). */
  priorNoise?: number;
  /**
   * Weight added to the predictive model per folded pair (default `1`). Named
   * `learningRate` because that is the knob `CurriculumStage.learnerOptions`
   * exposes (SPEC §18 `curriculumMode`); for a count model it is the count
   * increment, and the mapping is documented in `applyCurriculumStage`.
   */
  learningRate?: number;
}

export const SelfSupervisedPolicyOptionsSchema = z
  .object({
    valuesPerAttribute: z.number().int().positive(),
    attributeCount: z.number().int().positive(),
    messageLength: z.number().int().positive(),
    temperature: z.number().positive(),
    explorationRate: z.number().min(0).max(1),
    smoothing: z.number().positive(),
    priorNoise: z.number().min(0),
    learningRate: z.number().positive(),
    /** True while a consolidation stage is active (E22). */
    consolidating: z.boolean(),
  })
  .strict();

export type SelfSupervisedPolicyOptions = z.infer<
  typeof SelfSupervisedPolicyOptionsSchema
>;

/**
 * The per-run, per-Baby registries this adapter must not lose when SPEC §7.3
 * recovery re-initializes it against a ledger chain it has already written to.
 * Same role as `EpisodicRegistriesSchema` in `policy.ts`, minus that schema's
 * `predictor` field, which belongs to the tabular track's intrinsic mode.
 */
export const SelfSupervisedRegistriesSchema = z
  .object({
    runId: z.string().min(1),
    babyId: z.string().min(1),
    emitted: z.array(z.string().min(1)),
    received: z.array(z.string().min(1)),
    hypotheses: z.array(HypothesisRecordSchema),
  })
  .strict();

export type SelfSupervisedRegistries = z.infer<
  typeof SelfSupervisedRegistriesSchema
>;

export const EXPORTED_SELF_SUPERVISED_POLICY_VERSION = 1 as const;

export const ExportedSelfSupervisedPolicySchema = z
  .object({
    version: z.literal(EXPORTED_SELF_SUPERVISED_POLICY_VERSION),
    track: z.literal('self-supervised'),
    /** ALD-046 cb 3: the bundle records the loss definition. */
    lossDefinition: z.literal(PREDICTIVE_LOSS_DEFINITION),
    pairingRule: z.literal(PREDICTIVE_PAIRING_RULE),
    /** Domain-separated hash of the private seed; never the seed. */
    seedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    options: SelfSupervisedPolicyOptionsSchema,
    model: ExportedPredictiveModelSchema,
    registries: SelfSupervisedRegistriesSchema,
  })
  .strict();

export type ExportedSelfSupervisedPolicy = z.infer<
  typeof ExportedSelfSupervisedPolicySchema
>;

/**
 * One record of the private update buffer.
 *
 * ALD-046 cb 3: this is the *whole* record. There is no outcome field, so a
 * `self-supervised` update batch structurally cannot carry an outcome label.
 * A receiver record carries no interpretation index either: the pairing rule
 * (`PREDICTIVE_PAIRING_RULE`) recomputes it from the model at update time,
 * which keeps the buffer free of anything the receiver was not entitled to
 * know.
 */
export interface SelfSupervisedUpdateRecord {
  turn: number;
  role: 'sender' | 'receiver';
  /** Type codes of this Baby's own observed candidate rows, in its own order. */
  candidateTypeCodes: number[];
  /** Inventory indices of the message emitted or delivered on this turn. */
  messageSymbolIndices: number[];
  /** Index into `candidateTypeCodes` of the sender's target row. */
  targetIndexIfSender?: number;
}

/** The exact key set of a buffer record, asserted by this package's tests. */
export const SELF_SUPERVISED_UPDATE_RECORD_KEYS = [
  'candidateTypeCodes',
  'messageSymbolIndices',
  'role',
  'targetIndexIfSender',
  'turn',
] as const;

/**
 * What the adapter holds for one turn: the update record plus the presentation
 * values its ledger drafts quote. Every field is either the record itself or a
 * probability the adapter computed from its own model — never an outcome.
 */
interface SelfSupervisedTurnMemory {
  record: SelfSupervisedUpdateRecord;
  /** Symbols emitted or delivered, verbatim, for the ledger (SPEC §8.2). */
  symbols: string[];
  /** The distribution the action was drawn from, for the intention event. */
  distribution: number[];
  confidence: number;
  primaryEvidenceRef: string;
  /** Type code this Baby bound to the message on this turn. */
  actedTypeCode: number;
  /** Receiver only: index into `candidateTypeCodes` it selected. */
  actionIndex?: number;
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
  options: SelfSupervisedPolicyOptions;
  symbols: string[];
  symbolIndex: Map<string, number>;
  actionStream: SeededPrng;
  nonces: BlindingNonceSource;
  seedHash: string;
}

/** Bound so a long run cannot grow the private buffer without limit. */
const MAX_PENDING_TURNS = 4_096;

/** Confidence above which a disagreeing interpretation is worth preserving. */
const CONTRADICTION_CONFIDENCE = 0.5;

export class SelfSupervisedAdapter implements LearnerAdapter {
  readonly track = 'self-supervised' as const;

  private state: AdapterState | undefined;
  private model: PredictiveCountModel | undefined;
  private observation: ParsedObservation | undefined;
  private lastReceived: ReceivedMessage | undefined;
  private readonly pending = new Map<number, SelfSupervisedTurnMemory>();
  private readonly hypotheses = new Map<string, HypothesisRecord>();
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  private registryCheckpoint: SelfSupervisedRegistries | undefined;
  private initialHash: Sha256Hash | undefined;
  private diagnostics: string[] = [];

  constructor(private readonly options: SelfSupervisedAdapterOptions = {}) {}

  /**
   * The private update buffer, in turn order. Researcher-facing: it is never
   * delivered to the other Baby and never written to a ledger. Exposed so
   * ALD-046 cb 3 can be asserted on the real structure rather than on a
   * projection of it.
   */
  get updateBuffer(): readonly SelfSupervisedUpdateRecord[] {
    return [...this.pending.keys()]
      .sort((left, right) => left - right)
      .map((turn) => requireMemory(this.pending, turn).record);
  }

  /**
   * Differences between a loaded checkpoint's hyperparameters and this run's,
   * in `name checkpointValue != runValue` form. Researcher-facing only.
   */
  get policyLoadDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  async init(context: LearnerInitContext): Promise<void> {
    if (context.symbolInventory.length === 0) {
      throw new LearnerConfigurationError('symbolInventory must not be empty');
    }
    if (context.config.learningSignal !== SELF_SUPERVISED_LEARNING_SIGNAL) {
      throw new UnsupportedLearningSignalError(context.config.learningSignal, [
        SELF_SUPERVISED_LEARNING_SIGNAL,
      ]);
    }

    const shape = resolveGameShape(
      this.options,
      context.config.maxSymbolsPerMessage,
    );
    const options = SelfSupervisedPolicyOptionsSchema.parse({
      valuesPerAttribute: shape.valuesPerAttribute,
      attributeCount: shape.attributeCount,
      messageLength: shape.messageLength,
      temperature: this.options.temperature ?? 1,
      explorationRate: this.options.explorationRate ?? 0.1,
      smoothing: this.options.smoothing ?? 1,
      priorNoise: this.options.priorNoise ?? 0.25,
      learningRate: this.options.learningRate ?? 1,
      consolidating: false,
    });

    const prng = new SeededPrng(context.seed);
    this.state = {
      context,
      ledger: context.ledger,
      shape,
      options,
      symbols: [...context.symbolInventory],
      symbolIndex: new Map(
        context.symbolInventory.map((symbol, index) => [symbol, index]),
      ),
      actionStream: prng.derive('self-supervised/action'),
      nonces: new BlindingNonceSource({
        seed: context.seed,
        runId: context.runId,
        babyId: context.babyId,
      }),
      seedHash: domainHash(HASH_DOMAINS.seed, context.seed),
    };

    this.model = new PredictiveCountModel({
      messageLength: shape.messageLength,
      featureCount: shape.typeCount,
      symbolCount: context.symbolInventory.length,
      smoothing: options.smoothing,
      priorNoise: options.priorNoise,
      countIncrement: options.learningRate,
      seed: context.seed,
    });

    this.observation = undefined;
    this.lastReceived = undefined;
    this.pending.clear();
    this.diagnostics = [];
    this.restoreRegistries(undefined);

    if (context.initialPolicy !== undefined) {
      this.loadPolicy(context.initialPolicy);
    }

    // ALD-046 cb 1 / ALD-045 cb 1: the initial (randomly initialized) state
    // has a recorded hash, taken before any turn has run.
    this.initialHash = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      this.exportPolicy(),
    );
    return Promise.resolve();
  }

  /**
   * Hash of `exportPolicy()` as of the end of `init()`.
   *
   * ALD-046 cb 1 ("starts from recorded random initialization") and the
   * pattern ALD-045 cb 1 asks the runtime to record as `initialPolicyHash` in
   * the evidence bundle. It is a plain policy-checkpoint hash, so a reviewer
   * verifies it exactly like any other checkpoint hash in the bundle.
   */
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
    requireAction(turnBudget, 'emit_symbols');
    const memory = this.senderTurn(state, turnBudget.turn);
    const symbols = [...memory.symbols];

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
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.distribution, 6),
      },
      evidenceRefs: [memory.primaryEvidenceRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The sender action for `turn`, drawn once.
   *
   * The distribution is the model's own P(message | target features) — read as
   * "what message would a partner produce for this" — temperature-scaled and
   * mixed with the uniform distribution at the pre-registered exploration
   * rate. Nothing about the task outcome enters it.
   */
  private senderTurn(
    state: AdapterState,
    turn: number,
  ): SelfSupervisedTurnMemory {
    const cached = this.pending.get(turn);
    if (cached !== undefined && cached.record.role === 'sender') {
      return cached;
    }
    const model = this.requireModel();
    const observation = this.requireObservation();
    if (observation.targetIndex === null) {
      throw new LearnerStateError(
        'A sender turn requires an observation with a target row',
      );
    }
    const candidateTypeCodes = [...observation.typeCodes];
    const targetIndex = observation.targetIndex;
    const featureCode = at(candidateTypeCodes, targetIndex);

    const symbolIndices: number[] = [];
    let confidence = 1;
    let firstDistribution: number[] = [];
    for (let position = 0; position < state.shape.messageLength; position += 1) {
      const predicted = model.symbolProbabilities(position, featureCode);
      const distribution = mixWithUniform(
        softmax(
          predicted.map((probability) => Math.log(probability)),
          state.options.temperature,
        ),
        state.options.explorationRate,
      );
      const index = state.actionStream.sampleIndex(distribution);
      symbolIndices.push(index);
      confidence *= at(distribution, index);
      if (position === 0) {
        firstDistribution = distribution;
      }
    }

    const symbols = symbolIndices.map((index) => at(state.symbols, index));
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
      kind: 'emit_symbols' as const,
      publicArtifact: { symbols },
    })}`;

    const memory: SelfSupervisedTurnMemory = {
      record: {
        turn,
        role: 'sender',
        candidateTypeCodes,
        messageSymbolIndices: symbolIndices,
        targetIndexIfSender: targetIndex,
      },
      symbols,
      distribution: firstDistribution,
      confidence,
      primaryEvidenceRef: artifactRef,
      actedTypeCode: featureCode,
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
        symbols: [...memory.symbols],
        selection: objectRef,
        targetTypeCode: memory.actedTypeCode,
        probability: roundTo(memory.confidence, 6),
        associationWeights: roundAll(memory.distribution, 6),
      },
      evidenceRefs:
        channelRef === undefined ? [artifactRef] : [artifactRef, channelRef],
    });

    return { proposal, privateLedgerDraft: draft };
  }

  /**
   * The receiver action for `turn`, decided once.
   *
   * Mutual prediction: the selected candidate is the one under which the
   * delivered message is most probable, ties resolving to the lowest index, so
   * the choice is reproducible from a checkpoint alone. When nothing was
   * delivered — the SPEC §9.6 `disabled` control — the posterior is exactly
   * uniform and the adapter draws uniformly from its private stream instead of
   * always taking index 0: no symbol, no information, chance behaviour, which
   * is what the control measures.
   */
  private receiverTurn(
    state: AdapterState,
    turn: number,
    received: ReceivedMessage,
    candidateRefs: readonly string[],
  ): SelfSupervisedTurnMemory {
    const cached = this.pending.get(turn);
    if (cached !== undefined && cached.record.role === 'receiver') {
      return cached;
    }
    const model = this.requireModel();
    const candidateTypeCodes = this.receiverCandidateTypeCodes(
      candidateRefs.length,
    );

    let posterior: number[];
    let actionIndex: number;
    if (received.symbolIndices.length === 0) {
      posterior = candidateTypeCodes.map(() => 1 / candidateTypeCodes.length);
      actionIndex = state.actionStream.sampleIndex(posterior);
    } else {
      posterior = model.candidatePosterior(
        candidateTypeCodes,
        received.symbolIndices,
      );
      actionIndex = lowestArgmax(posterior);
    }

    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
      kind: 'select_object' as const,
      publicArtifact: { objectRef: at(candidateRefs, actionIndex) },
    })}`;

    const memory: SelfSupervisedTurnMemory = {
      record: {
        turn,
        role: 'receiver',
        candidateTypeCodes,
        messageSymbolIndices: [...received.symbolIndices],
      },
      symbols: [...received.symbols],
      distribution: posterior,
      confidence: at(posterior, actionIndex),
      primaryEvidenceRef:
        received.channelEventHash === null
          ? artifactRef
          : `channel:${received.channelEventHash}`,
      actedTypeCode: at(candidateTypeCodes, actionIndex),
      actionIndex,
    };
    this.remember(memory);
    return memory;
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const model = this.requireModel();
    const symbols = extractSymbols(delivery);
    // As in the tabular track: SPEC §9.6 `random` may deliver a message of any
    // length in `[1, maxSymbolsPerMessage]`, so a delivered length that
    // differs from this adapter's `messageLength` is a legal artifact. The
    // model scores the prefix it holds tables for; everything delivered is
    // recorded verbatim in the interpretation event (SPEC §8.2).
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

    const candidateTypeCodes =
      this.observation?.view === 'receiver' ? [...this.observation.typeCodes] : [];
    const inferredDistribution =
      candidateTypeCodes.length > 0
        ? model.candidatePosterior(candidateTypeCodes, symbolIndices)
        : [];
    const argmaxCandidateIndex = lowestArgmax(inferredDistribution);

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'interpretation.recorded',
      subjectId: `symbol:${at(symbols, 0)}`,
      turn: delivery.turn,
      content: {
        artifactRef: delivery.channelEventHash,
        symbols,
        candidateTypeCodes,
        inferredDistribution: roundAll(inferredDistribution, 6),
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
   * End-of-turn hook. Nothing on the outcome is read beyond the reward guard:
   * this track has no reward, no success bit, and no use for the nonverbal
   * outcome payload, so the only work here is the hypothesis lifecycle, which
   * is derived entirely from the adapter's own predictive model
   * (CONCEPT-IDEA.md §11.2 rules 1, 3 and 5).
   */
  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    const state = this.requireState();
    assertRewardFree(outcome, 'onOutcome');
    const memory = this.pending.get(outcome.turn);
    if (memory === undefined) {
      // An outcome for a turn this Baby did not act on (a rejected proposal,
      // or a deferred interpretation under `ledgerLagTurns`). Nothing to bind.
      return;
    }
    await this.recordHypotheses(state, memory);
  }

  /**
   * Fold the buffered turns into the predictive model.
   *
   * This is the only update path, and it consumes `PREDICTIVE_LOSS_DEFINITION`
   * alone: a batch that names any other learning signal is refused rather
   * than reinterpreted (SPEC §6.2, ALD-046 cb 1). Only this Baby's own
   * buffered records are read — no partner buffer, no shared gradients, no
   * optimizer state outside this object (SPEC §10.4).
   */
  async updatePolicy(batch: UpdateBatch): Promise<PolicyCheckpointRef> {
    const state = this.requireState();
    const model = this.requireModel();
    if (batch.learningSignal !== SELF_SUPERVISED_LEARNING_SIGNAL) {
      throw new UnsupportedLearningSignalError(batch.learningSignal, [
        SELF_SUPERVISED_LEARNING_SIGNAL,
      ]);
    }

    let highestTurn = 0;
    for (const turn of [...batch.turns].sort((left, right) => left - right)) {
      highestTurn = Math.max(highestTurn, turn);
      const memory = this.pending.get(turn);
      if (memory === undefined) {
        continue;
      }
      if (!state.options.consolidating) {
        foldPair(model, memory.record);
      }
      this.pending.delete(turn);
    }

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
   * `curriculumMode: fixed-schedule`).
   *
   * SPEC §11.1/§18 require an adapter to reject a knob it cannot honour rather
   * than ignore it silently, so every unsupported knob raises
   * `LearnerConfigurationError` naming the knob:
   *
   * - `learningRate` maps to the predictive model's count increment;
   * - `temperature` and `explorationRate` shape the sender's sampling;
   * - `consolidation` freezes the model: while the stage is active
   *   `updatePolicy` folds nothing and *discards* the turns it covers, so the
   *   interval is a real pause rather than a deferral;
   * - `memoryCapacity` is refused — this track's model is a fixed-size table
   *   with no capacity knob to honour;
   * - `maxSymbolsPerMessage` is refused unless it equals the message length
   *   the model was built for, because the table shape is per-position.
   */
  async applyCurriculumStage(stage: CurriculumStage): Promise<void> {
    const state = this.requireState();
    const model = this.requireModel();
    const knobs = stage.learnerOptions;

    if (knobs?.memoryCapacity !== undefined) {
      throw new LearnerConfigurationError(
        'curriculum knob memoryCapacity is not supported by the self-supervised track',
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
      model.setCountIncrement(knobs.learningRate);
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
   * SPEC §6.5: the self-declared provenance the ALD-057 battery checks. Every
   * component of this track is randomly initialized from the Baby's private
   * seed; there is no tokenizer, no vocabulary table, and no pretrained
   * parameter anywhere in the observation-to-action path, so items 1 and 3 of
   * the battery hold by construction. The battery treats these as claims to be
   * re-derived independently, never as proof.
   */
  describeProvenance(): LearnerProvenance {
    const state = this.requireState();
    const model = this.requireModel();
    const modelHash = model.hash();
    return {
      track: 'self-supervised',
      modelRef: modelRefFor(state.context),
      textTokenizerPresent: false,
      textAlignedEncoderPresent: false,
      weightUpdatePath: 'private-buffers-only',
      components: [
        {
          name: 'predictive-message-model',
          kind: 'world-model',
          provenance: 'random-init',
          hash: modelHash,
          textAligned: false,
        },
        {
          name: 'mutual-prediction-policy',
          kind: 'communication-policy',
          provenance: 'random-init',
          hash: hashCanonical(HASH_DOMAINS.policyCheckpoint, {
            component: 'communication-policy',
            rule: PREDICTIVE_LOSS_DEFINITION,
            pairingRule: PREDICTIVE_PAIRING_RULE,
            temperature: state.options.temperature,
            explorationRate: state.options.explorationRate,
            modelHash,
          }),
          textAligned: false,
        },
      ],
    };
  }

  /**
   * The canonicalizable checkpoint: the predictive model, its options and this
   * Baby's episodic registries.
   *
   * As in the tabular track the registry half is the snapshot taken by the
   * last `updatePolicy`, not the live registries, so the policy hash cannot
   * move during an evaluation phase in which `updatePolicy` is disabled (SPEC
   * §7.2) merely because a new symbol arrived.
   */
  exportPolicy(): ExportedSelfSupervisedPolicy {
    const state = this.requireState();
    const model = this.requireModel();
    return {
      version: EXPORTED_SELF_SUPERVISED_POLICY_VERSION,
      track: 'self-supervised',
      lossDefinition: PREDICTIVE_LOSS_DEFINITION,
      pairingRule: PREDICTIVE_PAIRING_RULE,
      seedHash: state.seedHash,
      options: { ...state.options },
      model: model.export(),
      registries: cloneRegistries(
        this.registryCheckpoint ?? this.snapshotRegistries(state),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * CONCEPT-IDEA.md §11.2 rules 1, 3 and 5, driven entirely by the predictive
   * model: the first use of a term is recorded, a changed argmax appends a
   * revision that references the prior hypothesis rather than overwriting it,
   * and a confident hypothesis that disagrees with the type code this Baby
   * actually bound to the symbol this turn is preserved as its own
   * `hypothesis.contradicted` event.
   *
   * The contradiction test uses no outcome label — it compares the model's own
   * argmax with the adapter's own action — and no ledger content here ever
   * references the outcome event, because this track never reads one.
   *
   * Bookkeeping advances only after the append resolves, so a SPEC §14.5 retry
   * re-emits the event it lost instead of leaving a `priorHypothesisRef` that
   * resolves to nothing (LEDGER §5).
   */
  private async recordHypotheses(
    state: AdapterState,
    memory: SelfSupervisedTurnMemory,
  ): Promise<void> {
    const model = this.requireModel();
    const positionsBySymbol = new Map<number, number[]>();
    memory.record.messageSymbolIndices.forEach((symbolIndex, position) => {
      const positions = positionsBySymbol.get(symbolIndex) ?? [];
      positions.push(position);
      positionsBySymbol.set(symbolIndex, positions);
    });

    for (const [symbolIndex, positions] of positionsBySymbol) {
      const symbol = at(state.symbols, symbolIndex);
      const association = model.featurePosteriorForSymbol(
        symbolIndex,
        positions,
      );
      const argmaxTypeCode = lowestArgmax(association);
      const confidence = at(association, argmaxTypeCode);
      const evidenceRefs = [memory.primaryEvidenceRef];
      const shared = {
        termRef: `symbol:${symbol}`,
        associationOverTypeCodes: roundAll(association, 6),
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
            turn: memory.record.turn,
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
            turn: memory.record.turn,
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

      if (
        confidence > CONTRADICTION_CONFIDENCE &&
        argmaxTypeCode !== memory.actedTypeCode
      ) {
        await state.ledger.append(
          buildNoncedDraft(state.nonces, {
            eventType: 'hypothesis.contradicted',
            subjectId: `symbol:${symbol}`,
            turn: memory.record.turn,
            content: {
              ...shared,
              hypothesisRef: previous.hypothesisRef,
              evidenceRef: memory.primaryEvidenceRef,
            },
            evidenceRefs,
          }),
        );
      }
    }
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
        `Observation has ${String(observation.typeCodes.length)} candidate rows but ${String(expected)} candidateRefs`,
      );
    }
    return [...observation.typeCodes];
  }

  private remember(memory: SelfSupervisedTurnMemory): void {
    if (this.pending.size >= MAX_PENDING_TURNS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(memory.record.turn, memory);
  }

  /** CONCEPT-IDEA.md §11.2 rule 1, with the tabular track's retry semantics. */
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
   * Resume from a recorded checkpoint: a derived run (SPEC §7.4) or a crash
   * recovery that re-initializes this adapter mid-run (SPEC §7.3).
   *
   * The *attribute space* is compared, not only the table cardinality: a
   * 2-value/4-attribute space and a 4-value/2-attribute space both give 16
   * type codes and `typeCodeFromAttributes` decodes the same integer to
   * different objects in the two, so loading across that boundary would index
   * the parent's model by the child's meanings while the lineage fields assert
   * an unbroken derivation. Hyperparameter differences are a legitimate
   * experiment and are only reported.
   */
  private loadPolicy(value: unknown): void {
    const state = this.requireState();
    const model = this.requireModel();
    const policy = ExportedSelfSupervisedPolicySchema.parse(value);

    const mismatches: string[] = [];
    for (const [name, left, right] of [
      ['attributeCount', policy.options.attributeCount, state.options.attributeCount],
      [
        'valuesPerAttribute',
        policy.options.valuesPerAttribute,
        state.options.valuesPerAttribute,
      ],
      ['messageLength', policy.options.messageLength, state.options.messageLength],
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
      ['temperature', policy.options.temperature, state.options.temperature],
      [
        'explorationRate',
        policy.options.explorationRate,
        state.options.explorationRate,
      ],
      ['smoothing', policy.options.smoothing, state.options.smoothing],
      ['priorNoise', policy.options.priorNoise, state.options.priorNoise],
      ['learningRate', policy.options.learningRate, state.options.learningRate],
    ] as const) {
      if (left !== right) {
        this.diagnostics.push(`${name} ${String(left)} != ${String(right)}`);
      }
    }

    model.restore(policy.model);
    this.restoreRegistries(policy.registries);
  }

  /**
   * Reset the episodic registries, restoring them only when the checkpoint
   * describes *this* run and this Baby: a §7.3 recovery must not re-record
   * first uses on a chain that already has them, and a §7.4 derived run starts
   * a fresh chain on which no term has one yet.
   */
  private restoreRegistries(
    registries: SelfSupervisedRegistries | undefined,
  ): void {
    const state = this.requireState();
    this.hypotheses.clear();
    this.emitted.clear();
    this.received.clear();

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
    }

    this.registryCheckpoint = this.snapshotRegistries(state);
  }

  /** The live registries in canonical (sorted) form. */
  private snapshotRegistries(state: AdapterState): SelfSupervisedRegistries {
    return {
      runId: state.context.runId,
      babyId: state.context.babyId,
      emitted: [...this.emitted].sort(compareStrings),
      received: [...this.received].sort(compareStrings),
      hypotheses: [...this.hypotheses.entries()]
        .map(([symbol, record]) => ({ symbol, ...record }))
        .sort((left, right) => compareStrings(left.symbol, right.symbol)),
    };
  }

  private requireState(): AdapterState {
    if (this.state === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.state;
  }

  private requireModel(): PredictiveCountModel {
    if (this.model === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.model;
  }

  private requireObservation(): ParsedObservation {
    if (this.observation === undefined) {
      throw new LearnerStateError('observe() must be called before act()');
    }
    return this.observation;
  }

  /** The message this Baby is answering on `turn`; empty when none (§9.6). */
  private receivedFor(turn: number): ReceivedMessage {
    const received = this.lastReceived;
    return received !== undefined && received.turn === turn
      ? received
      : { turn, symbols: [], symbolIndices: [], channelEventHash: null };
  }
}

/**
 * The pre-registered pairing rule (`PREDICTIVE_PAIRING_RULE`) applied to one
 * buffered record.
 *
 * A sender knows the features it meant. A receiver does not, and is never
 * told: its pair uses the candidate its own current model scores highest,
 * which is why the buffer needs no interpretation field. A receiver record
 * with an empty message (the §9.6 `disabled` control) carries no pair at all.
 */
function foldPair(
  model: PredictiveCountModel,
  record: SelfSupervisedUpdateRecord,
): void {
  if (record.messageSymbolIndices.length === 0) {
    return;
  }
  if (record.role === 'sender') {
    model.observe(
      at(record.candidateTypeCodes, requireIndex(record.targetIndexIfSender)),
      record.messageSymbolIndices,
    );
    return;
  }
  const posterior = model.candidatePosterior(
    record.candidateTypeCodes,
    record.messageSymbolIndices,
  );
  model.observe(
    at(record.candidateTypeCodes, lowestArgmax(posterior)),
    record.messageSymbolIndices,
  );
}

/**
 * ALD-046 cb 1: refuse a scalar reward on the reward-free path.
 *
 * `reward` is inspected as a property *descriptor*, so an accessor that the
 * conformance harness installs to prove the field is never read is never
 * invoked. For a plain data property the value is compared against `null` and
 * `undefined` and is neither stored, used, nor logged.
 */
function assertRewardFree(outcome: OutcomeEvent, where: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(outcome, 'reward');
  if (descriptor === undefined || descriptor.get !== undefined) {
    return;
  }
  if (descriptor.value !== null && descriptor.value !== undefined) {
    throw new ScalarRewardRefusedError(where);
  }
}

function modelRefFor(context: LearnerInitContext): string {
  return context.role === 'baby-a'
    ? context.config.babyA.modelRef
    : context.config.babyB.modelRef;
}

function requireIndex(value: number | undefined): number {
  if (value === undefined) {
    throw new LearnerStateError('A sender record requires targetIndexIfSender');
  }
  return value;
}

function requireMemory(
  pending: Map<number, SelfSupervisedTurnMemory>,
  turn: number,
): SelfSupervisedTurnMemory {
  const memory = pending.get(turn);
  if (memory === undefined) {
    throw new LearnerStateError(`No buffered turn ${String(turn)}`);
  }
  return memory;
}

/** Defensive copy: `exportPolicy()` hands its result to callers that keep it. */
function cloneRegistries(
  registries: SelfSupervisedRegistries,
): SelfSupervisedRegistries {
  return {
    runId: registries.runId,
    babyId: registries.babyId,
    emitted: [...registries.emitted],
    received: [...registries.received],
    hypotheses: registries.hypotheses.map((record) => ({ ...record })),
  };
}

export function createSelfSupervisedAdapterFactory(
  options: SelfSupervisedAdapterOptions = {},
): LearnerAdapterFactory {
  return {
    track: 'self-supervised',
    create: () => new SelfSupervisedAdapter(options),
  };
}
