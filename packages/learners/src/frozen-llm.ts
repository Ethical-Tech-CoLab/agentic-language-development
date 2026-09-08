/**
 * `frozen-llm` learner track (BACKLOG ALD-044; SPECIFICATION.md §6.1, §6.2,
 * §6.3, §6.4, §6.6, §6.7, §9.1, §9.4, §10.1-§10.3, §11.3;
 * EXPERIMENT-NOTEBOOK.md E10).
 *
 * A locally deployed, frozen open-weight instruction model (3B-8B by default,
 * §6.7) driving one Baby through the ordinary `LearnerAdapter` seam. The
 * weights never move: the only thing that changes across a run is this
 * adapter's private episodic memory over its *own* ledger drafts (§6.1 "adapts
 * only via private memory/ledger", §10.4 `weightUpdatePath: 'none'`). There is
 * no `updatePolicy` member at all — ALD-044 criterion 3 asks for a track that
 * "exposes no weight-update path", and the absence is structural rather than a
 * method that refuses.
 *
 * **Claim boundary (SPEC §6.1, verbatim in force here).** This track MUST NOT
 * be described as first-language acquisition. What it studies is new external
 * protocol invention by a model that already has a language. Nothing in this
 * file, its errors, or its exported policy may be read as evidence about
 * language acquisition, and §6.5's semantic-leakage battery does not apply:
 * §6.5's closing paragraph exempts `frozen-llm` explicitly *because* the track
 * is never claimed to be language-naive. `describeProvenance()` therefore
 * declares a text tokenizer and a text-aligned path openly rather than
 * claiming an ungrounded one.
 *
 * **Violations are forwarded, never repaired.** SPEC §9.4 makes every
 * rejection evidence and §10.2 forbids prohibited content being "sanitized and
 * passed through"; E10 measures "Prohibited attempts" as a headline metric. So
 * when the model emits prose, free text alongside a valid tool call, an
 * off-inventory mark, an over-long message, or an extra artifact field, this
 * adapter forwards exactly what the model produced and lets the Symbol Gateway
 * reject it under §9.1 and record a `channel.rejected` event carrying a reason
 * code and a payload hash. `llm-prompt.ts` documents the complete
 * completion-shape → reason-code mapping, and
 * `__tests__/frozen-llm-gateway.test.ts` asserts every row of it against a
 * real `SymbolGatewayImpl`.
 *
 * A model *fault* is different from model *content*: an unreachable endpoint, a
 * completion that never arrives inside the turn's model budget, or a client
 * that returns a malformed envelope throws (`llm-errors.ts`) so the Nursery
 * Controller's §8.3 deadline and §14.5 retry-then-pause paths classify it.
 * Nothing about a fault, and nothing about a rejection, is ever written back
 * into the prompt: no human-readable error text reaches this Baby's context
 * (§10.1).
 *
 * **What never leaves this object.** The prompt (contract text plus digest
 * plus observation) and every raw completion stay inside the adapter. The
 * private ledger receives numeric summaries and opaque references only
 * (§11.4, CONCEPT-IDEA.md §20.6) — never model output, never an off-inventory
 * mark, never a selection the run did not offer — and `exportPolicy()` carries
 * no prompt text and no raw output.
 */
import {
  HASH_DOMAINS,
  ObservationSchema,
  type DeliveredChannelArtifact,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LearnerContract,
  type LearnerInitContext,
  type LearnerProvenance,
  type LedgerDraftEnvelope,
  type LedgerEventDraft,
  type Observation,
  type OutcomeEvent,
  type PrivateLedgerClient,
  type Sha256Hash,
  type TurnBudget,
  type TurnProposalEnvelope,
} from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';

import { BlindingNonceSource, buildNoncedDraft } from './drafts.js';
import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import {
  argmaxIndex,
  extractSymbols,
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  roundTo,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';
import {
  formatModelRef,
  parseCompletionResponse,
  REFERENCE_MODEL_REF_PREFIX,
  type FrozenLlmToolKind,
  type LocalModelClient,
  type LocalModelDescription,
  type PromptObservation,
  type ToolDefinition,
} from './llm-client.js';
import { LocalModelTimeoutError } from './llm-errors.js';
import { FrozenLlmMemory, type ExportedFrozenLlmMemory } from './llm-memory.js';
import {
  buildForwardedProposal,
  buildToolDefinitions,
  classifyModelOutput,
  type ClassifiedModelOutput,
  type ModelOutputClass,
} from './llm-prompt.js';

/** Version of `exportPolicy()`'s shape. */
export const EXPORTED_FROZEN_LLM_POLICY_VERSION = 1;

/** Decimals kept in exported and ledger-written numbers. */
const POLICY_DECIMALS = 6;

/** Completed-but-unfolded turns retained, bounding the private buffer. */
const MAX_PENDING_TURNS = 4_096;

/**
 * Opaque policy label written into every draft this adapter produces. It is a
 * short hyphenated identifier, so the SPEC §10.1 language scan applied to
 * `agent-native-ledger` content reads it as a code rather than as prose.
 */
const POLICY_LABEL = 'frozen-llm';

/** Policy label of the memory-derived interpretation distribution. */
const INTERPRETATION_LABEL = 'memory-argmax';

export interface FrozenLlmAdapterOptions extends GameShapeOptions {
  /**
   * The frozen local model. Required: there is no default and no built-in
   * fallback, because SPEC §6.1 forbids silently substituting another track's
   * behavior and a stand-in model would misrepresent the run's provenance.
   * Production wiring builds this from `ALD_LOCAL_LLM_URL` /
   * `ALD_LOCAL_LLM_MODEL` / `ALD_LOCAL_LLM_WEIGHTS` (see the package notes).
   */
  client?: LocalModelClient;
  /** Hard cap on generated tokens per turn; default `256`. */
  maxOutputTokens?: number;
  /** Sampling temperature; default `0` (greedy, reproducible). */
  temperature?: number;
  /**
   * Share of `TurnBudget.responseBudgetMs` given to the model, leaving the
   * remainder for this adapter's own bookkeeping and ledger appends inside the
   * §8.3 deadline; default `0.8`.
   */
  modelBudgetFraction?: number;
  /** Absolute ceiling on the model time budget in ms; default `120_000`. */
  maxModelTimeBudgetMs?: number;
  /** Symbol records the private memory retains; default `64`. */
  maxTrackedSymbols?: number;
  /** Records placed in the prompt digest; default `12`. */
  maxDigestEntries?: number;
  /** Evidence references kept per symbol; default `3`. */
  maxEvidenceRefsPerSymbol?: number;
}

/** Shape of {@link FrozenLlmAdapter.exportPolicy}. */
export interface ExportedFrozenLlmPolicy {
  version: number;
  track: 'frozen-llm';
  modelId: string;
  weightsHash: Sha256Hash;
  weightsHashSource: LocalModelDescription['weightsHashSource'];
  toolCallingMode: LocalModelDescription['toolCallingMode'];
  contractVersion: string;
  /** Bounded, canonicalizable memory summary. No prompt text, no raw output. */
  memory: ExportedFrozenLlmMemory;
}

interface AdapterState {
  context: LearnerInitContext;
  ledger: PrivateLedgerClient;
  shape: ResolvedGameShape;
  symbols: string[];
  symbolSet: Set<string>;
  maxSymbolsPerMessage: number;
  contract: LearnerContract;
  description: LocalModelDescription;
  modelRef: string;
  nonces: BlindingNonceSource;
}

/** What one completed turn contributes to the memory and the ledger. */
interface TurnMemory {
  turn: number;
  role: 'sender' | 'receiver';
  outputClass: ModelOutputClass;
  classified: ClassifiedModelOutput;
  /** Marks of this turn that are in the declared inventory. */
  symbols: string[];
  /**
   * How many values the model named that the run did not declare — marks
   * outside the inventory on a sender turn, a selection outside
   * `candidateRefs` on a receiver turn. Counted, never stored: the value
   * itself is model output.
   */
  offInventoryCount: number;
  /** The object type code this Baby acted on, or `-1`. */
  typeCode: number;
  /** Opaque reference to this turn's own evidence. */
  evidenceRef: string;
  /** True once the emission counters have been advanced for this turn. */
  emissionNoted: boolean;
  /** True once `onOutcome` has folded the turn in. */
  folded: boolean;
}

interface ReceivedMessage {
  turn: number;
  symbols: string[];
  channelEventHash: Sha256Hash;
}

export class FrozenLlmAdapter implements LearnerAdapter {
  readonly track = 'frozen-llm' as const;

  private state: AdapterState | undefined;
  private memory: FrozenLlmMemory | undefined;
  private observation: ParsedObservation | undefined;
  private lastReceived: ReceivedMessage | undefined;
  private readonly pending = new Map<number, TurnMemory>();
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  private modelCalls = 0;

  constructor(private readonly options: FrozenLlmAdapterOptions = {}) {}

  /**
   * Completions requested so far. Researcher-side only: it is never written to
   * a ledger, never delivered to the other Baby, and never put in a prompt.
   */
  get modelCallCount(): number {
    return this.modelCalls;
  }

  /** The `<modelId>@<weightsHash>` this adapter was initialized against. */
  get modelRef(): string {
    return this.requireState().modelRef;
  }

  async init(context: LearnerInitContext): Promise<void> {
    const client = this.options.client;
    if (client === undefined) {
      throw new LearnerConfigurationError(
        'The frozen-llm track requires a LocalModelClient (ALD-044): configure a loopback inference endpoint or inject a client',
      );
    }
    if (context.symbolInventory.length === 0) {
      throw new LearnerConfigurationError('symbolInventory must not be empty');
    }

    const learner =
      context.role === 'baby-a' ? context.config.babyA : context.config.babyB;
    if (learner.track !== 'frozen-llm') {
      throw new LearnerConfigurationError(
        `This adapter serves the frozen-llm track but ${context.role} is configured as ${learner.track}`,
      );
    }
    // SPEC §11.1 cross-check, enforced again here rather than trusted from the
    // schema: a frozen model consumes no learning signal at all (§6.2:
    // `updatePolicy` is absent for this track).
    if (context.config.learningSignal !== 'none') {
      throw new LearnerConfigurationError(
        `The frozen-llm track requires learningSignal "none", got "${context.config.learningSignal}"`,
      );
    }
    if (context.learnerContract.text.trim().length === 0) {
      throw new LearnerConfigurationError(
        'The frozen-llm track requires the versioned learner contract text (SPEC §6.4, §6.6)',
      );
    }
    if (
      context.learnerContract.track !== undefined &&
      context.learnerContract.track !== 'frozen-llm'
    ) {
      throw new LearnerConfigurationError(
        `The supplied learner contract governs ${context.learnerContract.track}, not frozen-llm`,
      );
    }

    const description = client.describe();
    const modelRef = this.verifyModelRef(context, description, learner.modelRef);
    const shape = resolveGameShape(
      this.options,
      context.config.maxSymbolsPerMessage,
    );

    this.state = {
      context,
      ledger: context.ledger,
      shape,
      symbols: [...context.symbolInventory],
      symbolSet: new Set(context.symbolInventory),
      maxSymbolsPerMessage: context.config.maxSymbolsPerMessage ?? 4,
      contract: context.learnerContract,
      description,
      modelRef,
      nonces: new BlindingNonceSource({
        seed: context.seed,
        runId: context.runId,
        babyId: context.babyId,
      }),
    };
    this.memory = new FrozenLlmMemory({
      typeCount: shape.typeCount,
      ...(this.options.maxTrackedSymbols === undefined
        ? {}
        : { maxTrackedSymbols: this.options.maxTrackedSymbols }),
      ...(this.options.maxDigestEntries === undefined
        ? {}
        : { maxDigestEntries: this.options.maxDigestEntries }),
      ...(this.options.maxEvidenceRefsPerSymbol === undefined
        ? {}
        : { maxEvidenceRefsPerSymbol: this.options.maxEvidenceRefsPerSymbol }),
    });
    this.observation = undefined;
    this.lastReceived = undefined;
    this.pending.clear();
    this.emitted.clear();
    this.received.clear();
    this.modelCalls = 0;
    return Promise.resolve();
  }

  /**
   * ALD-044 criterion 1: the run records the exact model and weight hashes, so
   * the configured `modelRef` must be the one derived from the client the
   * adapter was actually handed.
   *
   * One narrow exemption: the deterministic `ScriptedModelClient`
   * (`weightsHashSource: 'scripted-double'`) also accepts the conformance
   * harness's `reference:frozen-llm` namespace, and only in `prototype`
   * deployment mode. A double has no weights, so a `<modelId>@<weightsHash>`
   * claim about it would be meaningless; a research-grade run and any real
   * client are held to the exact form.
   */
  private verifyModelRef(
    context: LearnerInitContext,
    description: LocalModelDescription,
    configured: string,
  ): string {
    const expected = formatModelRef(
      description.modelId,
      description.weightsHash,
    );
    if (configured === expected) {
      return expected;
    }
    const referenceForm = `${REFERENCE_MODEL_REF_PREFIX}frozen-llm`;
    if (
      description.weightsHashSource === 'scripted-double' &&
      context.config.deploymentMode === 'prototype' &&
      configured === referenceForm
    ) {
      return configured;
    }
    throw new LearnerConfigurationError(
      `Configured modelRef "${configured}" does not identify the frozen model in use; expected "${expected}"`,
    );
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
    const role = turnBudget.role;
    requireAction(turnBudget, role === 'sender' ? 'emit_symbols' : 'select_object');

    const memory = await this.turnMemory(state, turnBudget);
    const proposal = buildForwardedProposal(
      memory.classified,
      role === 'sender' ? 'emit_symbols' : 'select_object',
    );

    if (role === 'sender') {
      // First-use events are recorded only for marks the run actually
      // declares: an off-inventory mark is model output, and model output
      // never enters the ledger (§11.4). Each mark is flagged as seen only
      // after its append resolves, so a §14.5 retry re-emits the event it
      // lost; the emission counters are guarded by the cached turn buffer so
      // the same retry does not count the turn twice.
      await this.recordFirstUse(
        state,
        turnBudget.turn,
        memory.symbols,
        'term.first_emitted',
        this.emitted,
      );
      if (!memory.emissionNoted) {
        for (const symbol of memory.symbols) {
          this.requireMemory().noteEmitted(symbol);
        }
        memory.emissionNoted = true;
      }
    }

    const draft = this.intentionDraft(state, turnBudget, memory, proposal);
    return { proposal, privateLedgerDraft: draft } as TurnProposalEnvelope;
  }

  /**
   * The completion for this turn, requested once.
   *
   * SPEC §14.5 retries a crashed adapter call and §14.3 requires the run to
   * replay from its recorded seed, so a retry must reuse the completion the
   * first attempt obtained rather than paying for — and possibly getting a
   * different answer from — a second one.
   */
  private async turnMemory(
    state: AdapterState,
    turnBudget: TurnBudget,
  ): Promise<TurnMemory> {
    const cached = this.pending.get(turnBudget.turn);
    if (cached !== undefined && cached.role === turnBudget.role) {
      return cached;
    }

    const client = this.options.client as LocalModelClient;
    const primary: FrozenLlmToolKind =
      turnBudget.role === 'sender' ? 'emit_symbols' : 'select_object';
    const tools = orderPrimaryFirst(
      buildToolDefinitions(turnBudget, {
        symbolInventory: state.symbols,
        maxSymbolsPerMessage: state.maxSymbolsPerMessage,
        ...(turnBudget.candidateRefs === undefined
          ? {}
          : { candidateRefs: turnBudget.candidateRefs }),
      }),
      primary,
    );

    const observation = this.promptObservation(turnBudget);
    const timeBudgetMs = this.modelTimeBudget(turnBudget);
    const response = parseCompletionResponse(
      await withModelDeadline(
        client.complete({
          systemPrompt: state.contract.text,
          memoryDigest: this.requireMemory().digest(),
          observation,
          tools,
          maxOutputTokens: this.options.maxOutputTokens ?? 256,
          timeBudgetMs,
          samplingSeed: this.samplingSeed(state, turnBudget),
          temperature: this.options.temperature ?? 0,
        }),
        timeBudgetMs,
      ),
    );
    this.modelCalls += 1;

    const classified = classifyModelOutput(response, tools);
    const memory = this.summarize(state, turnBudget, classified, primary);
    this.remember(memory);
    return memory;
  }

  /** Fold one classified completion into the turn's private bookkeeping. */
  private summarize(
    state: AdapterState,
    turnBudget: TurnBudget,
    classified: ClassifiedModelOutput,
    primary: FrozenLlmToolKind,
  ): TurnMemory {
    const proposal = buildForwardedProposal(classified, primary);
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`;

    let symbols: string[] = [];
    let offInventoryCount = 0;
    let typeCode = -1;

    if (turnBudget.role === 'sender') {
      const observation = this.observation;
      if (observation === undefined || observation.targetIndex === null) {
        throw new LearnerStateError(
          'A sender turn requires an observation with a target row',
        );
      }
      typeCode = observation.typeCodes[observation.targetIndex] ?? -1;
      const marks = readMarks(classified, 'symbols');
      for (const mark of marks) {
        if (state.symbolSet.has(mark)) {
          symbols.push(mark);
        } else {
          offInventoryCount += 1;
        }
      }
    } else {
      const delivered = this.receivedFor(turnBudget.turn);
      symbols = delivered.symbols.filter((symbol) =>
        state.symbolSet.has(symbol),
      );
      const selection = readSelection(classified);
      const candidateRefs = turnBudget.candidateRefs ?? [];
      const index = selection === null ? -1 : candidateRefs.indexOf(selection);
      if (index < 0) {
        offInventoryCount += selection === null ? 0 : 1;
      } else {
        typeCode = this.observation?.typeCodes[index] ?? -1;
      }
    }

    return {
      turn: turnBudget.turn,
      role: turnBudget.role,
      outputClass: classified.outputClass,
      classified,
      symbols,
      offInventoryCount,
      typeCode,
      evidenceRef:
        turnBudget.role === 'receiver' &&
        this.lastReceived?.turn === turnBudget.turn
          ? `channel:${this.lastReceived.channelEventHash}`
          : artifactRef,
      emissionNoted: false,
      folded: false,
    };
  }

  private promptObservation(turnBudget: TurnBudget): PromptObservation {
    const observation = this.observation;
    if (observation === undefined) {
      throw new LearnerStateError('observe() must be called before act()');
    }
    if (turnBudget.role === 'sender') {
      return {
        candidates: observation.candidates.map((row) => [...row]),
        targetIndex: observation.targetIndex,
      };
    }
    const delivered = this.receivedFor(turnBudget.turn);
    return {
      candidates: observation.candidates.map((row) => [...row]),
      targetIndex: null,
      candidateRefs: [...(turnBudget.candidateRefs ?? [])],
      deliveredSymbols: [...delivered.symbols],
    };
  }

  /**
   * The private intention event (SPEC §6.3: every public tool call commits
   * with one). It records what the adapter *did* in agent-native form —
   * opaque references, inventory marks, type codes, counts, and a short
   * classification code — and never the model's text, an off-inventory mark,
   * or a selection the run did not offer.
   */
  private intentionDraft(
    state: AdapterState,
    turnBudget: TurnBudget,
    memory: TurnMemory,
    proposal: unknown,
  ): LedgerEventDraft {
    const artifactRef = `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`;
    const firstSymbol = memory.symbols[0];
    const content: Record<string, unknown> = {
      artifactRef,
      symbols: [...memory.symbols],
      targetTypeCode: memory.typeCode,
      outputClass: memory.outputClass,
      offInventoryCount: memory.offInventoryCount,
      policy: POLICY_LABEL,
      contractVersion: state.contract.version,
    };

    if (turnBudget.role === 'receiver') {
      const selection = readSelection(memory.classified);
      const candidateRefs = turnBudget.candidateRefs ?? [];
      if (selection !== null && candidateRefs.includes(selection)) {
        content.selection = selection;
        content.probability = roundTo(
          this.selectionProbability(memory, candidateRefs.indexOf(selection)),
          POLICY_DECIMALS,
        );
      }
      const channel = this.lastReceived;
      if (channel !== undefined && channel.turn === turnBudget.turn) {
        return buildNoncedDraft(state.nonces, {
          eventType: 'intention.recorded',
          subjectId: firstSymbol === undefined ? artifactRef : `symbol:${firstSymbol}`,
          turn: turnBudget.turn,
          content,
          evidenceRefs: [artifactRef, `channel:${channel.channelEventHash}`],
        });
      }
    }

    return buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: firstSymbol === undefined ? artifactRef : `symbol:${firstSymbol}`,
      turn: turnBudget.turn,
      content,
      evidenceRefs: [artifactRef],
    });
  }

  /** Memory-derived mass on the candidate the model chose. */
  private selectionProbability(memory: TurnMemory, index: number): number {
    const candidateTypeCodes = this.observation?.typeCodes ?? [];
    const scores = this.requireMemory().scoreCandidates(
      memory.symbols,
      candidateTypeCodes,
    );
    const total = scores.reduce((sum, score) => sum + score, 0);
    if (total <= 0) {
      return candidateTypeCodes.length === 0 ? 0 : 1 / candidateTypeCodes.length;
    }
    return (scores[index] ?? 0) / total;
  }

  /**
   * The delivered artifact (SPEC §8.2). The model is not consulted here: the
   * interpretation this event records is the private memory's reading of the
   * marks, and the model's own reading is expressed in the selection it makes
   * on the same turn's `act()`. One completion per turn keeps the §8.3 budget
   * meaningful and the record unambiguous about which call produced what.
   */
  async receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const memory = this.requireMemory();
    const symbols = extractSymbols(delivery);
    const isNewTurn = this.lastReceived?.turn !== delivery.turn;
    this.lastReceived = {
      turn: delivery.turn,
      symbols,
      channelEventHash: delivery.channelEventHash,
    };

    await this.recordFirstUse(
      state,
      delivery.turn,
      symbols.filter((symbol) => state.symbolSet.has(symbol)),
      'term.first_received',
      this.received,
    );
    if (isNewTurn) {
      // Guarded by turn so a §14.5 retry of the same delivery does not
      // double-count it in the memory.
      for (const symbol of symbols) {
        if (state.symbolSet.has(symbol)) {
          memory.noteReceived(symbol, `channel:${delivery.channelEventHash}`);
        }
      }
    }

    const candidateTypeCodes =
      this.observation?.view === 'receiver' ? [...this.observation.typeCodes] : [];
    const scores = memory.scoreCandidates(symbols, candidateTypeCodes);
    const total = scores.reduce((sum, score) => sum + score, 0);
    const inferredDistribution =
      candidateTypeCodes.length === 0
        ? []
        : total > 0
          ? scores.map((score) => score / total)
          : scores.map(() => 1 / candidateTypeCodes.length);
    const argmaxCandidateIndex = argmaxIndex(inferredDistribution);

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'interpretation.recorded',
      subjectId: `symbol:${symbols[0] as string}`,
      turn: delivery.turn,
      content: {
        artifactRef: delivery.channelEventHash,
        symbols,
        candidateTypeCodes,
        inferredDistribution: roundAll(inferredDistribution, POLICY_DECIMALS),
        argmaxCandidateIndex,
        confidence: roundTo(
          argmaxCandidateIndex < 0
            ? 0
            : (inferredDistribution[argmaxCandidateIndex] ?? 0),
          POLICY_DECIMALS,
        ),
        policy: INTERPRETATION_LABEL,
      },
      evidenceRefs: [`channel:${delivery.channelEventHash}`],
    });

    return { channelEventHash: delivery.channelEventHash, privateLedgerDraft: draft };
  }

  /**
   * Fold the turn's outcome into the private memory and append this Baby's
   * hypothesis events (CONCEPT-IDEA.md §11.2 rules 1, 3 and 5).
   *
   * `OutcomeEvent.reward` is never read. This track's configured
   * `learningSignal` is `none`, and the only outcome information a frozen model
   * may observe is the approved nonverbal payload both Babies receive
   * (SPEC §8.1 step 7).
   *
   * The hypothesis event is written from the memory *as revised by this turn*,
   * because in this track the memory is the whole adaptive state and the
   * outcome is what revises it. The pre-outcome state that produced the
   * behavior is already on the chain: it is the intention and interpretation
   * events of the same turn.
   */
  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    const state = this.requireState();
    const memory = this.pending.get(outcome.turn);
    if (memory === undefined || memory.folded) {
      return;
    }
    const successBit = successBitOf(outcome);
    const store = this.requireMemory();

    store.fold(
      memory.symbols.map((symbol) => ({
        symbol,
        typeCode: memory.typeCode,
        successBit,
        evidenceRef: memory.evidenceRef,
      })),
    );
    memory.folded = true;

    for (const symbol of memory.symbols) {
      await this.recordHypothesis(state, store, symbol, memory, successBit);
    }
  }

  private async recordHypothesis(
    state: AdapterState,
    store: FrozenLlmMemory,
    symbol: string,
    memory: TurnMemory,
    successBit: number,
  ): Promise<void> {
    const distribution = store.distributionFor(symbol);
    const argmaxTypeCode = argmaxIndex(distribution);
    const confidence = distribution[argmaxTypeCode] ?? 0;
    const evidenceRefs = [memory.evidenceRef, `outcome:${memory.turn}`];
    const shared = {
      termRef: `symbol:${symbol}`,
      associationOverTypeCodes: roundAll(distribution, POLICY_DECIMALS),
      argmaxTypeCode,
      confidence: roundTo(confidence, POLICY_DECIMALS),
      evidenceRefs,
      policy: POLICY_LABEL,
    };
    const previous = store.hypothesisFor(symbol);

    if (previous === undefined) {
      await state.ledger.append(
        buildNoncedDraft(state.nonces, {
          eventType: 'hypothesis.created',
          subjectId: `symbol:${symbol}`,
          turn: memory.turn,
          content: { ...shared, hypothesisRef: `hyp:${symbol}:1` },
          evidenceRefs,
        }),
      );
      store.setHypothesis(symbol, 1, argmaxTypeCode);
      return;
    }

    if (previous.argmaxTypeCode !== argmaxTypeCode) {
      const version = previous.version + 1;
      await state.ledger.append(
        buildNoncedDraft(state.nonces, {
          eventType: 'hypothesis.revised',
          subjectId: `symbol:${symbol}`,
          turn: memory.turn,
          content: {
            ...shared,
            hypothesisRef: `hyp:${symbol}:${version}`,
            priorHypothesisRef: previous.hypothesisRef,
          },
          evidenceRefs,
        }),
      );
      store.setHypothesis(symbol, version, argmaxTypeCode);
      return;
    }

    if (successBit === 0 && confidence > 0.5) {
      // Contradictory evidence against a confident hypothesis is preserved as
      // its own event rather than overwriting the hypothesis (SPEC §6.4's
      // contract requirement, CONCEPT-IDEA.md §11.2 rule 5).
      await state.ledger.append(
        buildNoncedDraft(state.nonces, {
          eventType: 'hypothesis.contradicted',
          subjectId: `symbol:${symbol}`,
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

  exportPolicy(): ExportedFrozenLlmPolicy {
    const state = this.requireState();
    return {
      version: EXPORTED_FROZEN_LLM_POLICY_VERSION,
      track: 'frozen-llm',
      modelId: state.description.modelId,
      weightsHash: state.description.weightsHash,
      weightsHashSource: state.description.weightsHashSource,
      toolCallingMode: state.description.toolCallingMode,
      contractVersion: state.contract.version,
      memory: this.requireMemory().snapshot(),
    };
  }

  /**
   * Self-declared provenance for SPEC §6.5 / ALD-057. This track declares its
   * text tokenizer and its text-aligned path openly: the observation is
   * rendered as tokens for a language model, so the sensory-to-policy path is
   * text-aligned by construction. That is not a leak to be hidden — §6.5's
   * closing paragraph exempts `frozen-llm` from the semantic-leakage battery
   * *because* the track is never claimed to be language-naive, and §6.1
   * forbids describing it as first-language acquisition. `weightUpdatePath` is
   * `none`: the only state that changes is the private memory.
   */
  describeProvenance(): LearnerProvenance {
    const state = this.requireState();
    return {
      track: 'frozen-llm',
      modelRef: state.modelRef,
      textTokenizerPresent: true,
      textAlignedEncoderPresent: true,
      weightUpdatePath: 'none',
      components: [
        {
          name: state.description.modelId,
          kind: 'language-model',
          provenance: 'frozen-open-weight',
          hash: state.description.weightsHash,
          textAligned: true,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private modelTimeBudget(turnBudget: TurnBudget): number {
    const fraction = this.options.modelBudgetFraction ?? 0.8;
    const ceiling = this.options.maxModelTimeBudgetMs ?? 120_000;
    const budget = Math.floor(turnBudget.responseBudgetMs * fraction);
    return Math.max(1, Math.min(ceiling, budget));
  }

  /**
   * Sampling seed for this turn, derived from the Baby's private seed and the
   * turn/role rather than from a stream cursor, so a §7.3 re-initialization or
   * a §14.5 retry reproduces the same seed (SPEC §14.3).
   */
  private samplingSeed(state: AdapterState, turnBudget: TurnBudget): number {
    return new SeededPrng(state.context.seed)
      .derive(`frozen-llm/sampling/${turnBudget.role}/${turnBudget.turn}`)
      .nextInt(2_147_483_647);
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
        content: { termRef: `symbol:${symbol}`, policy: POLICY_LABEL },
      });
      await state.ledger.append(draft);
      seen.add(symbol);
    }
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

  /** The message delivered on `turn`; empty when nothing was (§9.6 `disabled`). */
  private receivedFor(turn: number): { symbols: string[] } {
    const received = this.lastReceived;
    return received !== undefined && received.turn === turn
      ? { symbols: received.symbols }
      : { symbols: [] };
  }

  private requireState(): AdapterState {
    if (this.state === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.state;
  }

  private requireMemory(): FrozenLlmMemory {
    if (this.memory === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.memory;
  }
}

/**
 * The approved nonverbal outcome payload is the only outcome channel this
 * track reads (SPEC §8.1 step 7). `outcome.reward` is never touched — the
 * conformance harness's `rewardVisibility: 'forbidden'` mode proves it.
 */
function successBitOf(outcome: OutcomeEvent): number {
  const bit = outcome.payload[0];
  if (bit !== undefined) {
    return bit === 1 ? 1 : 0;
  }
  return outcome.success ? 1 : 0;
}

/** The marks a classified completion named, whatever their validity. */
function readMarks(
  classified: ClassifiedModelOutput,
  property: 'symbols',
): string[] {
  if (
    classified.outputClass !== 'tool-call' &&
    classified.outputClass !== 'tool-call-text'
  ) {
    return [];
  }
  const value = classified.args[property];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The `objectRef` a classified completion named, or `null`. */
function readSelection(classified: ClassifiedModelOutput): string | null {
  if (
    classified.outputClass !== 'tool-call' &&
    classified.outputClass !== 'tool-call-text'
  ) {
    return null;
  }
  const value = classified.args.objectRef;
  return typeof value === 'string' ? value : null;
}

function orderPrimaryFirst(
  tools: ToolDefinition[],
  primary: FrozenLlmToolKind,
): ToolDefinition[] {
  const index = tools.findIndex((tool) => tool.name === primary);
  if (index <= 0) {
    return tools;
  }
  const ordered = [...tools];
  const [tool] = ordered.splice(index, 1);
  return tool === undefined ? tools : [tool, ...ordered];
}

/**
 * Race one completion against this turn's model budget (SPEC §8.3). A budget
 * that elapses is an adapter fault, not model content: there is no output to
 * forward, so the Nursery Controller's deadline and §14.5 retry-then-pause
 * paths take over.
 */
async function withModelDeadline<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new LocalModelTimeoutError(budgetMs));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the `frozen-llm` factory (SPEC §11.1 `babyA.track`).
 *
 * `options.client` is required. There is no default model and no fallback
 * track: SPEC §6.1 forbids a silent default, and a run whose model is not
 * configured must fail before it starts rather than record a provenance it
 * cannot support (ALD-044 criterion 1).
 */
export function createFrozenLlmAdapterFactory(
  options: FrozenLlmAdapterOptions = {},
): LearnerAdapterFactory {
  if (options.client === undefined) {
    throw new LearnerConfigurationError(
      'The frozen-llm track requires a LocalModelClient (ALD-044): build one with OpenAiCompatibleLocalClient.create({ endpoint, modelId, weightsPath }) against a loopback endpoint, or inject a ScriptedModelClient in tests',
    );
  }
  return {
    track: 'frozen-llm',
    create: () => new FrozenLlmAdapter(options),
  };
}
