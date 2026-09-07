/**
 * `no-learning` reference adapter (SPEC §6.1, ALD-042).
 *
 * The chance control: a seeded uniform-random policy that never updates. It
 * establishes the pre-registered chance success rate for the referential game
 * (0.25 with four candidates, SPEC §15.3) and exercises every seam of the
 * `LearnerAdapter` contract, so it is also the reference implementation the
 * conformance harness is written against.
 *
 * It is deliberately not a language-acquisition claim of any kind (SPEC §6.1
 * claim boundary) and exposes no `updatePolicy` method (SPEC §6.2: absent for
 * the no-learning and frozen-llm tracks).
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
  type PrivateLedgerClient,
  type TurnBudget,
  type TurnProposalEnvelope,
} from '@ald/types';
import { SeededPrng, domainHash, hashCanonical } from '@ald/hashing';

import {
  BlindingNonceSource,
  buildAgentNativeDraft,
} from './drafts.js';
import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import {
  extractSymbols,
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';

export type NoLearningAdapterOptions = GameShapeOptions;

/** Shape of `NoLearningAdapter.exportPolicy()`. Never contains the raw seed. */
export interface ExportedUniformRandomPolicy {
  kind: 'uniform-random';
  /** Domain-separated hash of the private seed, so runs stay comparable. */
  seedHash: string;
  symbolInventorySize: number;
  messageLength: number;
  attributeCount: number;
  valuesPerAttribute: number;
}

interface AdapterState {
  context: LearnerInitContext;
  ledger: PrivateLedgerClient;
  shape: ResolvedGameShape;
  symbols: string[];
  symbolStream: SeededPrng;
  candidateStream: SeededPrng;
  nonces: BlindingNonceSource;
  seedHash: string;
}

export class NoLearningAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  private state: AdapterState | undefined;
  private observation: ParsedObservation | undefined;
  private lastReceivedSymbols: string[] = [];
  private readonly emitted = new Set<string>();
  private readonly received = new Set<string>();
  private outcomes = 0;
  private successes = 0;

  constructor(private readonly options: NoLearningAdapterOptions = {}) {}

  /**
   * Researcher-side counters. They are private learner state, never delivered
   * to the other Baby and never written to the ledger; the ledger record of an
   * outcome is the Nursery turn record (SPEC §11.2), not a Baby event.
   */
  get outcomeCounters(): { outcomes: number; successes: number } {
    return { outcomes: this.outcomes, successes: this.successes };
  }

  async init(context: LearnerInitContext): Promise<void> {
    if (context.symbolInventory.length === 0) {
      throw new LearnerConfigurationError('symbolInventory must not be empty');
    }
    const shape = resolveGameShape(
      this.options,
      context.config.maxSymbolsPerMessage,
    );
    const prng = new SeededPrng(context.seed);
    this.state = {
      context,
      ledger: context.ledger,
      shape,
      symbols: [...context.symbolInventory],
      symbolStream: prng.derive('no-learning/symbol'),
      candidateStream: prng.derive('no-learning/candidate'),
      nonces: new BlindingNonceSource(prng.derive('blinding-nonce')),
      seedHash: domainHash(HASH_DOMAINS.seed, context.seed),
    };
    this.observation = undefined;
    this.lastReceivedSymbols = [];
    this.emitted.clear();
    this.received.clear();
    this.outcomes = 0;
    this.successes = 0;
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
    const observation = this.requireObservation('sender');
    if (observation.targetIndex === null) {
      throw new LearnerStateError(
        'A sender turn requires an observation with a target row',
      );
    }
    const targetTypeCode = observation.typeCodes[observation.targetIndex] as number;

    const symbols = Array.from({ length: state.shape.messageLength }, () =>
      state.symbols[state.symbolStream.nextInt(state.symbols.length)] as string,
    );
    const proposal = {
      kind: 'emit_symbols' as const,
      publicArtifact: { symbols },
    };

    await this.recordFirstUse(state, symbols, 'term.first_emitted', this.emitted);

    const draft = buildAgentNativeDraft({
      eventType: 'intention.recorded',
      subjectId: `symbol:${symbols[0] as string}`,
      content: {
        artifactRef: `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`,
        symbols,
        targetTypeCode,
        policy: 'uniform-random',
      },
      blindingNonce: state.nonces.next(),
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
    const index = state.candidateStream.nextInt(candidateRefs.length);
    const objectRef = candidateRefs[index] as string;
    const proposal = {
      kind: 'select_object' as const,
      publicArtifact: { objectRef },
    };

    const draft = buildAgentNativeDraft({
      eventType: 'intention.recorded',
      subjectId: `candidate:${objectRef}`,
      content: {
        artifactRef: `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`,
        symbols: [...this.lastReceivedSymbols],
        selection: objectRef,
        policy: 'uniform-random',
      },
      blindingNonce: state.nonces.next(),
    });

    return { proposal, privateLedgerDraft: draft };
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const symbols = extractSymbols(delivery);
    this.lastReceivedSymbols = symbols;

    await this.recordFirstUse(state, symbols, 'term.first_received', this.received);

    const uniform = 1 / state.shape.typeCount;
    const draft = buildAgentNativeDraft({
      eventType: 'interpretation.recorded',
      subjectId: `symbol:${symbols[0] as string}`,
      content: {
        artifactRef: delivery.channelEventHash,
        symbols,
        inferredTypeDistribution: roundAll(
          new Array<number>(state.shape.typeCount).fill(uniform),
          6,
        ),
        policy: 'uniform-random',
      },
      blindingNonce: state.nonces.next(),
      evidenceRefs: [`channel:${delivery.channelEventHash}`],
    });

    return {
      channelEventHash: delivery.channelEventHash,
      privateLedgerDraft: draft,
    };
  }

  /** Records nothing beyond private counters: this track never learns. */
  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    this.requireState();
    this.outcomes += 1;
    if (outcome.success) {
      this.successes += 1;
    }
    return Promise.resolve();
  }

  exportPolicy(): ExportedUniformRandomPolicy {
    const state = this.requireState();
    return {
      kind: 'uniform-random',
      seedHash: state.seedHash,
      symbolInventorySize: state.symbols.length,
      messageLength: state.shape.messageLength,
      attributeCount: state.shape.attributeCount,
      valuesPerAttribute: state.shape.valuesPerAttribute,
    };
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
        content: { termRef: `symbol:${symbol}`, policy: 'uniform-random' },
        blindingNonce: state.nonces.next(),
      });
      await state.ledger.append(draft);
    }
  }

  private requireState(): AdapterState {
    if (this.state === undefined) {
      throw new LearnerStateError('init() must be called before any other method');
    }
    return this.state;
  }

  private requireObservation(role: string): ParsedObservation {
    if (this.observation === undefined) {
      throw new LearnerStateError(
        `observe() must be called before a ${role} turn`,
      );
    }
    return this.observation;
  }
}

export function createNoLearningAdapterFactory(
  options: NoLearningAdapterOptions = {},
): LearnerAdapterFactory {
  return {
    track: 'no-learning',
    create: () => new NoLearningAdapter(options),
  };
}
