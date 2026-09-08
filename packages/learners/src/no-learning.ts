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
 *
 * A receiver turn may carry no delivered message: SPEC §9.6's `disabled`
 * control delivers nothing, and §8.2 forbids an interpretation event when
 * there is no channel event to reference. The selection is uniform either way
 * for this track; the intention event then records `symbols: []`.
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
  carrierProposal,
  createCarrierSupport,
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
import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import {
  parseObservationPayload,
  requireAction,
  resolveGameShape,
  roundAll,
  type GameShapeOptions,
  type ParsedObservation,
  type ResolvedGameShape,
} from './game.js';

export type NoLearningAdapterOptions = GameShapeOptions & CarrierSupportOptions;

/** Shape of `NoLearningAdapter.exportPolicy()`. Never contains the raw seed. */
export interface ExportedUniformRandomPolicy {
  kind: 'uniform-random';
  /** Domain-separated hash of the private seed, so runs stay comparable. */
  seedHash: string;
  symbolInventorySize: number;
  messageLength: number;
  attributeCount: number;
  valuesPerAttribute: number;
  /**
   * SPEC §9.2 carrier fields, present only for an alternate carrier
   * (ALD-031). They are omitted on the default `fixed-token` carrier so this
   * control's checkpoint stays byte-identical to the pre-ALD-031 export — the
   * constancy of this policy across a run is the control's meaning, and a
   * field appearing in it would change every recorded policy hash of every
   * existing E00-E03 baseline for no behavioural reason.
   */
  carrier?: string;
  /** Number of declared or invented forms this Baby chooses between. */
  formCount?: number;
  /** Hash of the whole form inventory (SPEC §14.3 replay). */
  formInventoryHash?: string;
}

interface AdapterState {
  context: LearnerInitContext;
  ledger: PrivateLedgerClient;
  shape: ResolvedGameShape;
  /** SPEC §9.1/§9.2: how a form index becomes a public artifact (ALD-031). */
  support: CarrierAdapterSupport;
  symbolStream: SeededPrng;
  candidateStream: SeededPrng;
  nonces: BlindingNonceSource;
  seedHash: string;
}

export class NoLearningAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  private state: AdapterState | undefined;
  private observation: ParsedObservation | undefined;
  /**
   * The message delivered on one turn, bound to that turn: with
   * `ledgerLagTurns: 0` (SPEC §8.2) a message belongs to the turn that
   * delivered it, so it is never carried into a later turn that had none.
   */
  private lastReceived: { turn: number; marks: DeliveredMark[] } | undefined;
  /**
   * Terms this Baby has already recorded a first use for (CONCEPT-IDEA.md
   * §11.2 rule 1).
   *
   * Unlike the `scratch-rl` track these are not carried in `exportPolicy()`:
   * this track has no learned state, its checkpoint is a constant by
   * construction (that constancy is the control's meaning and is asserted in
   * this package's tests), and the runtime writes and reloads a policy file
   * only for a track that exposes `updatePolicy` — so there is no checkpoint
   * for a recovered `no-learning` adapter to restore from. A SPEC §7.3
   * recovery of a `no-learning` run therefore re-records first uses; the
   * blinding nonces stay unique regardless, because they are derived from the
   * event rather than from a stream position.
   */
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
      support: createCarrierSupport(context, shape, this.options),
      symbolStream: prng.derive('no-learning/symbol'),
      candidateStream: prng.derive('no-learning/candidate'),
      nonces: new BlindingNonceSource({
        seed: context.seed,
        runId: context.runId,
        babyId: context.babyId,
      }),
      seedHash: domainHash(HASH_DOMAINS.seed, context.seed),
    };
    this.observation = undefined;
    this.lastReceived = undefined;
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
    const support = state.support;
    requireCarrierAction(turnBudget, support.emitKind);
    const observation = this.requireObservation('sender');
    if (observation.targetIndex === null) {
      throw new LearnerStateError(
        'A sender turn requires an observation with a target row',
      );
    }
    const targetTypeCode = observation.typeCodes[observation.targetIndex] as number;

    // One uniform draw per mark over the form inventory. On `fixed-token`
    // `formCount` is the symbol-inventory size and `marksPerMessage` is
    // `messageLength`, so the draw sequence — and therefore every recorded
    // symbol of every existing baseline run — is exactly what it was before
    // ALD-031 generalized the carrier (SPEC §9.2).
    const indices = Array.from({ length: support.marksPerMessage }, () =>
      state.symbolStream.nextInt(support.formCount),
    );
    const marks = indices.map((index) => ({
      formIndex: index,
      formId: support.formId(index),
      markHash: support.formMarkHash(index),
    }));
    const proposal = carrierProposal(support, indices);

    await this.recordFirstUse(
      state,
      turnBudget.turn,
      marks,
      'term.first_emitted',
      this.emitted,
    );

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: subjectIdFor(support, marks[0] as DeliveredMark),
      turn: turnBudget.turn,
      content: {
        artifactRef: `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`,
        ...messageFields(support, marks),
        targetTypeCode,
        policy: 'uniform-random',
      },
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

    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'intention.recorded',
      subjectId: `candidate:${objectRef}`,
      turn: turnBudget.turn,
      content: {
        artifactRef: `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, proposal)}`,
        // §9.6 `disabled`: an empty message when nothing was delivered.
        ...messageFields(state.support, this.receivedMarks(turnBudget.turn)),
        selection: objectRef,
        policy: 'uniform-random',
      },
    });

    return { proposal, privateLedgerDraft: draft };
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    const state = this.requireState();
    const delivered = state.support.parseDelivery(delivery.publicArtifact);
    const marks = delivered.marks;
    this.lastReceived = { turn: delivery.turn, marks };

    await this.recordFirstUse(
      state,
      delivery.turn,
      marks,
      'term.first_received',
      this.received,
    );

    const uniform = 1 / state.shape.typeCount;
    const draft = buildNoncedDraft(state.nonces, {
      eventType: 'interpretation.recorded',
      subjectId: subjectIdFor(state.support, marks[0] as DeliveredMark),
      turn: delivery.turn,
      content: {
        artifactRef: delivery.channelEventHash,
        ...messageFields(state.support, marks),
        inferredTypeDistribution: roundAll(
          new Array<number>(state.shape.typeCount).fill(uniform),
          6,
        ),
        policy: 'uniform-random',
      },
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
    const support = state.support;
    return {
      kind: 'uniform-random',
      seedHash: state.seedHash,
      symbolInventorySize: support.formCount,
      messageLength: support.marksPerMessage,
      attributeCount: state.shape.attributeCount,
      valuesPerAttribute: state.shape.valuesPerAttribute,
      ...(support.carrier === 'fixed-token'
        ? {}
        : {
            carrier: support.carrier,
            formCount: support.formCount,
            formInventoryHash: support.formInventoryHash,
          }),
    };
  }

  /**
   * SPEC §9.2/§14.3: the hash of this Baby's declared or invented form
   * inventory. Researcher-facing; the runtime records it in the evidence
   * bundle so a replay can be checked against the forms that actually ran.
   */
  get carrierFormInventoryHash(): string {
    return this.requireState().support.formInventoryHash;
  }

  /**
   * CONCEPT-IDEA.md §11.2 rule 1. As in the `scratch-rl` track, the symbol is
   * marked as seen only after its event is durable, so a SPEC §14.5 retry
   * re-emits the first-use event it lost rather than dropping it.
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
        content: { ...termFields(state.support, mark), policy: 'uniform-random' },
      });
      await state.ledger.append(draft);
      seen.add(key);
    }
  }

  /** The marks delivered on `turn`; empty when nothing was (§9.6). */
  private receivedMarks(turn: number): readonly DeliveredMark[] {
    const received = this.lastReceived;
    return received !== undefined && received.turn === turn
      ? received.marks
      : [];
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
