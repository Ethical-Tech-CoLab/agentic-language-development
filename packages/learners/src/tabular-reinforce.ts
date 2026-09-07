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
 * The sender half of such a turn is updated normally.
 *
 * Initialization is all-zero logits, i.e. an exactly uniform policy. That is a
 * deliberate substitute for random initialization: it is reproducible, its
 * hash is recorded in the evidence bundle like any other checkpoint, and it
 * removes an uncontrolled source of seed-to-seed variance from the E11
 * baseline. Symmetry is broken by sampling, not by initialization.
 */
import {
  HASH_DOMAINS,
  ObservationSchema,
  type DeliveredChannelArtifact,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LearnerInitContext,
  type LedgerDraftEnvelope,
  type LedgerEventDraft,
  type Observation,
  type OutcomeEvent,
  type PolicyCheckpointRef,
  type PrivateLedgerClient,
  type RunConfig,
  type TurnBudget,
  type TurnProposalEnvelope,
  type UpdateBatch,
} from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';

import { BlindingNonceSource, buildAgentNativeDraft } from './drafts.js';
import {
  LearnerConfigurationError,
  LearnerStateError,
  UnsupportedLearningSignalError,
} from './errors.js';
import {
  argmaxIndex,
  extractSymbols,
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  roundMatrix,
  roundTo,
  softmax,
  zeroMatrix,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';
import {
  POLICY_DECIMALS,
  parseExportedTabularPolicy,
  tabularPolicyShape,
  type ExportedTabularPolicy,
  type TabularPolicyOptions,
} from './policy.js';

/** Learning signals this adapter can consume (SPEC §11.1, `learningSignal`). */
export const SUPPORTED_LEARNING_SIGNALS = [
  'extrinsic-task',
  'intrinsic-prediction-progress',
] as const;

export interface TabularReinforceOptions extends GameShapeOptions {
  /** REINFORCE step size (default `0.3`). */
  learningRate?: number;
  /** Moving-average baseline decay (default `0.9`). */
  baselineDecay?: number;
  /** Softmax temperature for action sampling (default `1.0`). */
  temperature?: number;
  /**
   * The single intrinsic reward this reference track implements. When set (or
   * when `RunConfig.learningSignal` is `intrinsic-prediction-progress`) the
   * task reward is never read.
   */
  intrinsicMode?: 'prediction-progress';
}

type RewardMode = 'extrinsic-task' | 'intrinsic-prediction-progress';

interface SenderTurnMemory {
  role: 'sender';
  turn: number;
  symbols: string[];
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
  symbols: string[];
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
  symbols: string[];
  symbolIndices: number[];
  channelEventHash: string | null;
}

/** The empty message a receiver holds when nothing was delivered (§9.6). */
function emptyMessage(turn: number): ReceivedMessage {
  return { turn, symbols: [], symbolIndices: [], channelEventHash: null };
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
  symbols: string[];
  symbolIndex: Map<string, number>;
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

export class TabularReinforceAdapter implements LearnerAdapter {
  readonly track = 'scratch-rl' as const;

  private state: AdapterState | undefined;
  private thetaSender: number[][] = [];
  private thetaReceiver: number[][][] = [];
  private baseline = 0;
  private observation: ParsedObservation | undefined;
  private lastReceived: ReceivedMessage | undefined;
  private readonly pending = new Map<number, TurnMemory>();
  private readonly hypotheses = new Map<string, HypothesisRecord>();
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  /** Private partner/outcome prediction model used only by the intrinsic mode. */
  private readonly predictor = new Map<string, number>();

  constructor(private readonly options: TabularReinforceOptions = {}) {}

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
      learningRate: this.options.learningRate ?? 0.3,
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
      symbols: [...context.symbolInventory],
      symbolIndex: new Map(
        context.symbolInventory.map((symbol, index) => [symbol, index]),
      ),
      actionStream: prng.derive('scratch-rl/action'),
      nonces: new BlindingNonceSource(prng.derive('blinding-nonce')),
    };

    const symbolCount = context.symbolInventory.length;
    this.thetaSender = zeroMatrix(shape.typeCount, symbolCount);
    this.thetaReceiver = Array.from({ length: shape.messageLength }, () =>
      zeroMatrix(symbolCount, shape.typeCount),
    );
    this.baseline = 0;
    this.observation = undefined;
    this.lastReceived = undefined;
    this.pending.clear();
    this.hypotheses.clear();
    this.emitted.clear();
    this.received.clear();
    this.predictor.clear();

    if (context.initialPolicy !== undefined) {
      this.loadPolicy(context.initialPolicy);
    }
    return Promise.resolve();
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
    const observation = this.requireObservation();
    if (observation.targetIndex === null) {
      throw new LearnerStateError(
        'A sender turn requires an observation with a target row',
      );
    }
    const typeCode = at(observation.typeCodes, observation.targetIndex);
    const logits = row(this.thetaSender, typeCode);
    const probs = softmax(logits, state.options.temperature);

    const symbolIndices: number[] = [];
    let confidence = 1;
    for (let position = 0; position < state.shape.messageLength; position += 1) {
      const index = state.actionStream.sampleIndex(probs);
      symbolIndices.push(index);
      confidence *= at(probs, index);
    }
    const symbols = symbolIndices.map((index) => at(state.symbols, index));

    const proposal = {
      kind: 'emit_symbols' as const,
      publicArtifact: { symbols },
    };
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`;

    await this.recordFirstUse(state, symbols, 'term.first_emitted', this.emitted);

    const draft = buildAgentNativeDraft({
      eventType: 'intention.recorded',
      subjectId: `symbol:${at(symbols, 0)}`,
      content: {
        artifactRef,
        symbols,
        targetTypeCode: typeCode,
        probability: roundTo(confidence, 6),
        associationWeights: roundAll(probs, 6),
      },
      blindingNonce: state.nonces.next(),
      evidenceRefs: [artifactRef],
    });

    this.remember({
      role: 'sender',
      turn: turnBudget.turn,
      symbols,
      symbolIndices,
      typeCode,
      probs,
      confidence,
      primaryEvidenceRef: artifactRef,
    });

    return { proposal, privateLedgerDraft: draft };
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
    // SPEC §9.6 `disabled`: no artifact is delivered, so the receiver acts
    // with an empty message. `candidateScores` then sums over no symbol rows
    // and the softmax is exactly uniform over the candidates: no symbol, no
    // information, chance behavior — which is what the control measures.
    const received = this.receivedFor(turnBudget.turn);
    const candidateTypeCodes = this.receiverCandidateTypeCodes(
      candidateRefs.length,
    );
    const probs = softmax(
      this.candidateScores(received.symbolIndices, candidateTypeCodes),
      state.options.temperature,
    );
    const actionIndex = state.actionStream.sampleIndex(probs);
    const objectRef = at(candidateRefs, actionIndex);

    const proposal = {
      kind: 'select_object' as const,
      publicArtifact: { objectRef },
    };
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`;
    const channelRef =
      received.channelEventHash === null
        ? undefined
        : `channel:${received.channelEventHash}`;

    const draft = buildAgentNativeDraft({
      eventType: 'intention.recorded',
      subjectId: `candidate:${objectRef}`,
      content: {
        artifactRef,
        symbols: [...received.symbols],
        selection: objectRef,
        /** The type code of the candidate this Baby intends to refer to. */
        targetTypeCode: at(candidateTypeCodes, actionIndex),
        probability: roundTo(at(probs, actionIndex), 6),
        associationWeights: roundAll(probs, 6),
      },
      blindingNonce: state.nonces.next(),
      evidenceRefs:
        channelRef === undefined ? [artifactRef] : [artifactRef, channelRef],
    });

    this.remember({
      role: 'receiver',
      turn: turnBudget.turn,
      symbols: [...received.symbols],
      symbolIndices: [...received.symbolIndices],
      candidateTypeCodes,
      actionIndex,
      probs,
      confidence: at(probs, actionIndex),
      primaryEvidenceRef: channelRef ?? artifactRef,
    });

    return { proposal, privateLedgerDraft: draft };
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const symbols = extractSymbols(delivery);
    if (symbols.length !== state.shape.messageLength) {
      throw new LearnerStateError(
        `Expected ${state.shape.messageLength} symbol(s), received ${symbols.length}`,
      );
    }
    const symbolIndices = symbols.map((symbol) => {
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

    await this.recordFirstUse(state, symbols, 'term.first_received', this.received);

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

    const draft = buildAgentNativeDraft({
      eventType: 'interpretation.recorded',
      subjectId: `symbol:${at(symbols, 0)}`,
      content: {
        artifactRef: delivery.channelEventHash,
        symbols,
        candidateTypeCodes,
        inferredDistribution: roundAll(inferredDistribution, 6),
        argmaxCandidateIndex,
        confidence: roundTo(
          argmaxCandidateIndex < 0 ? 0 : at(inferredDistribution, argmaxCandidateIndex),
          6,
        ),
      },
      blindingNonce: state.nonces.next(),
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
    memory.reward =
      state.rewardMode === 'extrinsic-task'
        ? (outcome.reward ?? successBit)
        : this.predictionProgressReward(state, memory, successBit);

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

    const policy = this.exportPolicy();
    const policyHash = hashCanonical(HASH_DOMAINS.policyCheckpoint, policy);
    return Promise.resolve({
      policyCheckpointRef: `policy:${policyHash}`,
      policyHash,
      turn: highestTurn,
    });
  }

  exportPolicy(): ExportedTabularPolicy {
    const state = this.requireState();
    return {
      version: 1,
      thetaSender: roundMatrix(this.thetaSender, POLICY_DECIMALS),
      thetaReceiver: this.thetaReceiver.map((table) =>
        roundMatrix(table, POLICY_DECIMALS),
      ),
      baseline: roundTo(this.baseline, POLICY_DECIMALS),
      options: { ...state.options },
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
      const symbol = at(state.symbols, symbolIndex);
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
        termRef: `symbol:${symbol}`,
        associationOverTypeCodes: roundAll(association, 6),
        argmaxTypeCode,
        confidence: roundTo(confidence, 6),
        evidenceRefs,
      };
      const previous = this.hypotheses.get(symbol);

      if (previous === undefined) {
        const hypothesisRef = `hyp:${symbol}:1`;
        this.hypotheses.set(symbol, {
          version: 1,
          hypothesisRef,
          argmaxTypeCode,
        });
        await state.ledger.append(
          buildAgentNativeDraft({
            eventType: 'hypothesis.created',
            subjectId: `symbol:${symbol}`,
            content: { ...shared, hypothesisRef },
            blindingNonce: state.nonces.next(),
            evidenceRefs,
          }),
        );
        continue;
      }

      if (previous.argmaxTypeCode !== argmaxTypeCode) {
        const version = previous.version + 1;
        const hypothesisRef = `hyp:${symbol}:${version}`;
        this.hypotheses.set(symbol, { version, hypothesisRef, argmaxTypeCode });
        await state.ledger.append(
          buildAgentNativeDraft({
            eventType: 'hypothesis.revised',
            subjectId: `symbol:${symbol}`,
            content: {
              ...shared,
              hypothesisRef,
              priorHypothesisRef: previous.hypothesisRef,
            },
            blindingNonce: state.nonces.next(),
            evidenceRefs,
          }),
        );
        continue;
      }

      if (successBit === 0 && confidence > 0.5) {
        await state.ledger.append(
          buildAgentNativeDraft({
            eventType: 'hypothesis.contradicted',
            subjectId: `symbol:${symbol}`,
            content: {
              ...shared,
              hypothesisRef: previous.hypothesisRef,
              evidenceRef: `outcome:${memory.turn}`,
            },
            blindingNonce: state.nonces.next(),
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

  private async recordFirstUse(
    state: AdapterState,
    symbols: readonly string[],
    eventType: 'term.first_emitted' | 'term.first_received',
    seen: Set<string>,
  ): Promise<void> {
    for (const symbol of symbols) {
      if (seen.has(symbol)) {
        continue;
      }
      seen.add(symbol);
      const draft: LedgerEventDraft = buildAgentNativeDraft({
        eventType,
        subjectId: `symbol:${symbol}`,
        content: {
          termRef: `symbol:${symbol}`,
          firstUse: eventType === 'term.first_emitted' ? 'emitted' : 'received',
        },
        blindingNonce: state.nonces.next(),
      });
      await state.ledger.append(draft);
    }
  }

  /** Derived runs (SPEC §7.4): resume from a recorded policy checkpoint. */
  private loadPolicy(value: unknown): void {
    const state = this.requireState();
    const policy = parseExportedTabularPolicy(value);
    const shape = tabularPolicyShape(policy);
    if (
      shape.typeCount !== state.shape.typeCount ||
      shape.symbolCount !== state.symbols.length ||
      shape.messageLength !== state.shape.messageLength
    ) {
      throw new LearnerConfigurationError(
        'initialPolicy shape does not match this run configuration',
      );
    }
    this.thetaSender = policy.thetaSender.map((logits) => [...logits]);
    this.thetaReceiver = policy.thetaReceiver.map((table) =>
      table.map((logits) => [...logits]),
    );
    this.baseline = policy.baseline;
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

function resolveRewardMode(
  config: RunConfig,
  options: TabularReinforceOptions,
): RewardMode {
  if (options.intrinsicMode === 'prediction-progress') {
    if (
      config.learningSignal !== 'intrinsic-prediction-progress' &&
      config.learningSignal !== 'extrinsic-task'
    ) {
      throw new LearnerConfigurationError(
        `learningSignal ${config.learningSignal} cannot drive intrinsicMode prediction-progress`,
      );
    }
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
