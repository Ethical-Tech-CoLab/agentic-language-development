/**
 * The Symbol Gateway (SPECIFICATION.md §4.1 item 3, §8.1-§8.3, §9;
 * ALD-029/ALD-030/ALD-034/ALD-035).
 *
 * This class is the single mediation point for every inter-agent artifact.
 * It never writes SQLite: it validates, applies the §9.6 communication
 * control, and calls the one Evidence Writer through the `EvidenceWriter`
 * contract, releasing the public artifact to the receiver only after that
 * commit succeeds (§8.2). It holds no learner state and no scenario ground
 * truth.
 *
 * What it deliberately does *not* do:
 * - it does not forward the sender's intended-meaning field to the receiver
 *   (§4.2 trust boundary: only the validated public artifact crosses);
 * - it does not echo any part of a rejected payload back to the caller, only
 *   a reason code and a domain-separated hash (§9.4);
 * - it does not pause the run itself. Reaching `maxConsecutiveRejections`
 *   commits the `safety-trigger` audit entry (§14.5) and sets
 *   `pauseRequested`; the run state transition belongs to the Nursery
 *   Controller (§7.2).
 */
import {
  babyIdForRole,
  HASH_DOMAINS,
  LedgerDraftEnvelopeSchema,
  TurnProposalEnvelopeSchema,
  type AffectStateMeasurement,
  type AffectSubmitResult,
  type AffectWindow,
  type AgentActionProposal,
  type BabyRole,
  type ChannelEvent,
  type DeliveredChannelArtifact,
  type EvidenceWriter,
  type GatewayRunContext,
  type GatewaySubmitResult,
  type GatewayTurnContext,
  type LedgerDraftEnvelope,
  type LedgerEvent,
  type RunConfig,
  type Sha256Hash,
  type SymbolGateway,
  type TurnProposalEnvelope,
} from '@ald/types';
import { hashCanonical, SeededPrng } from '@ald/hashing';
import { validateLedgerEventDraft } from '@ald/evidence';

import { AffectProtocol, type DerivedAffectResult } from './affect.js';
import {
  carrierModule,
  DEFAULT_MAX_SYMBOL_REPEATS,
  type CarrierContext,
  type CarrierModule,
  type PublicArtifact,
} from './carrier-modules.js';
import {
  ControlArtifactNotPermittedError,
  InterpretationRejectedError,
  InvalidControlArtifactError,
  InvalidSymbolInventoryError,
  OracleRequiresControlArtifactError,
  ShuffledBatchRequiredError,
  TurnDeadlineExceededError,
} from './errors.js';
import {
  findTrustedMetadataKey,
  isPlainObject,
  isWithinComplexityBudget,
  jsonSafe,
} from './inspect.js';
import type { GatewayReasonCode } from './reason-codes.js';

export interface SymbolGatewayOptions {
  /** SPEC §9.1 consecutive identical symbols allowed; default `3`. */
  maxSymbolRepeats?: number;
  /**
   * SPEC §9.6 `constant`: the run's pre-registered replacement artifact. It
   * is validated against the active carrier when the Gateway is constructed.
   */
  constantArtifact?: PublicArtifact;
}

/** What the Gateway remembers about one delivery, for §11.3 echo binding. */
export interface GatewayDelivery {
  turn: number;
  recipient: BabyRole;
  channelEventHash: Sha256Hash;
  deliveredArtifactHash: Sha256Hash;
}

export type GatewayRejection = Extract<GatewaySubmitResult, { kind: 'rejected' }>;

/** Actor id recorded on the automatic pause request (SPEC §14.2). */
export const GATEWAY_ACTOR_ID = 'symbol-gateway';
/** Reason code of the §9.4 automatic-pause audit entry. */
export const MAX_CONSECUTIVE_REJECTIONS_REASON = 'max-consecutive-rejections';

/** Maximum reseeded shuffles attempted before falling back to a rotation. */
const DERANGEMENT_ATTEMPTS = 20;

interface EnvelopeShape {
  proposal: Record<string, unknown>;
  kind: string;
  privateLedgerDraft: Record<string, unknown>;
}

type ValidatedDraft = ReturnType<typeof validateLedgerEventDraft>;

/** True when `value` has exactly the given keys, no more and no fewer. */
function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

/**
 * SPEC §8.3: race `promise` against the turn response budget. The Gateway
 * does not start the clock itself — the Nursery Controller owns turn timing —
 * so this is exposed as a helper the caller wraps its adapter call in. A
 * rejected deadline is committed with {@link SymbolGatewayImpl.rejectForTimeout}.
 */
export function withTurnDeadline<T>(
  promise: PromiseLike<T>,
  budgetMs: number,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return Promise.reject(new TurnDeadlineExceededError(budgetMs));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TurnDeadlineExceededError(budgetMs));
    }, budgetMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Reads the §11.3 envelope frame without a zod parse.
 *
 * The envelope must carry exactly `proposal` and `privateLedgerDraft`, the
 * proposal must be an object with exactly a string `kind` plus a
 * `publicArtifact`, and the draft must be an object. Anything else is
 * `invalid-envelope`; the carrier module then judges the artifact itself, so
 * carrier-specific reason codes win over the generic one.
 */
function readEnvelopeShape(value: unknown): EnvelopeShape | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  if (!hasExactKeys(value, ['proposal', 'privateLedgerDraft'])) {
    return undefined;
  }
  const proposal = value.proposal;
  const draft = value.privateLedgerDraft;
  if (!isPlainObject(proposal) || !isPlainObject(draft)) {
    return undefined;
  }
  if (typeof proposal.kind !== 'string') {
    return undefined;
  }
  return { proposal, kind: proposal.kind, privateLedgerDraft: draft };
}

function deliveryKey(turn: number, recipient: BabyRole): string {
  return `${turn}:${recipient}`;
}

function isDerangement(permutation: readonly number[]): boolean {
  return permutation.every((value, index) => value !== index);
}

export class SymbolGatewayImpl implements SymbolGateway {
  private readonly module: CarrierModule;
  private readonly maxSymbolRepeats: number;
  private readonly constant: PublicArtifact;
  /**
   * SPEC §9.6 seeded control stream.
   *
   * RESEARCH.md Appendix D.4 binds condition randomness to
   * `scenarioSeed || 0x00 || communicationCondition`. Here the run seed
   * (`GatewayRunContext.seed`, derived by the runtime from
   * `RunConfig.randomSeed`) plays the role of the scenario seed, and the
   * `dtsf-seed-v1` PRNG's labelled `derive` chain plays the role of the
   * `|| 0x00 ||` concatenation: `seed → 'gateway' → <condition>`. Per-turn
   * (`random`) and per-batch (`shuffled`) streams branch off that node, so a
   * replay from the same seed reproduces every substitution exactly
   * (SPEC §14.3).
   */
  private readonly conditionPrng: SeededPrng;
  private readonly deliveries = new Map<string, GatewayDelivery>();
  private readonly permutations = new Map<number, number[]>();
  private rejections = 0;
  /** SPEC §9.3: built on first affect call (see the `affect` accessor). */
  private affectProtocol: AffectProtocol | undefined;

  constructor(
    readonly runContext: GatewayRunContext,
    private readonly evidence: EvidenceWriter,
    options: SymbolGatewayOptions = {},
  ) {
    this.assertInventory(runContext.symbolInventory);
    this.module = carrierModule(runContext.config.carrierMode);
    this.maxSymbolRepeats = options.maxSymbolRepeats ?? DEFAULT_MAX_SYMBOL_REPEATS;
    if (
      !Number.isInteger(this.maxSymbolRepeats) ||
      this.maxSymbolRepeats < 1
    ) {
      throw new InvalidSymbolInventoryError(
        'maxSymbolRepeats must be a positive integer',
      );
    }
    this.conditionPrng = new SeededPrng(runContext.seed)
      .derive('gateway')
      .derive(runContext.config.communicationCondition);
    this.constant = this.resolveConstantArtifact(options.constantArtifact);
  }

  // -------------------------------------------------------------------------
  // Sender path (SPEC §8.1 steps 2-5)
  // -------------------------------------------------------------------------

  async submitProposal(
    turn: GatewayTurnContext,
    envelope: TurnProposalEnvelope,
  ): Promise<GatewaySubmitResult> {
    const condition = this.condition;
    if (condition === 'oracle') {
      throw new OracleRequiresControlArtifactError();
    }

    const raw: unknown = envelope;

    // 1. §11.3 envelope frame.
    const shape = readEnvelopeShape(raw);
    if (!shape) {
      return this.rejectProposal(turn, raw, 'invalid-envelope');
    }

    // 1b. §9.4: bound the whole envelope's structural complexity — proposal
    //     *and* privateLedgerDraft alike — before any recursive inspection or
    //     canonical hashing touches it. A payload nested or wide enough to
    //     exceed the budget is rejected outright here, rather than risking an
    //     unbounded recursion (in this module's own checks, or later in
    //     `@ald/hashing` canonicalization on the Evidence Writer path) from
    //     escaping the rejection framework as an uncaught RangeError.
    if (!isWithinComplexityBudget(raw)) {
      return this.rejectProposal(turn, raw, 'payload-too-complex');
    }

    // 2. §11.3 trusted metadata is Gateway-assigned; a Baby may never set it.
    if (findTrustedMetadataKey(shape.proposal) !== undefined) {
      return this.rejectProposal(turn, raw, 'trusted-metadata-present');
    }

    // 3. §8.1 step 2: the intention event is required, not optional.
    let draft: ValidatedDraft;
    try {
      draft = validateLedgerEventDraft(shape.privateLedgerDraft);
    } catch {
      return this.rejectProposal(turn, raw, 'missing-intention');
    }
    if (draft.eventType !== 'intention.recorded') {
      return this.rejectProposal(turn, raw, 'missing-intention');
    }

    // 4. §9.6: exactly one carrier family is available in a run.
    if (!(this.module.allowedKinds as readonly string[]).includes(shape.kind)) {
      return this.rejectProposal(turn, raw, 'carrier-mismatch');
    }
    const validation = this.module.validate(shape.proposal, this.carrierContext);
    if (!validation.ok) {
      return this.rejectProposal(turn, raw, validation.reasonCode);
    }

    // 5. ALD-035: the normalized envelope must satisfy the §11.3 schema.
    let parsed: TurnProposalEnvelope;
    try {
      parsed = TurnProposalEnvelopeSchema.parse({
        proposal: { kind: shape.kind, publicArtifact: validation.artifact },
        privateLedgerDraft: shape.privateLedgerDraft,
      });
    } catch {
      return this.rejectProposal(turn, raw, 'invalid-envelope');
    }

    // 6. §9.6: control replacement happens after validation, before the
    //    channel event is constructed.
    const deliveredArtifact = this.applyCommunicationControl(
      turn,
      parsed.proposal.publicArtifact,
    );

    const commit = await this.evidence.commitTurn({
      runId: this.runContext.runId,
      turn: turn.turn,
      sender: turn.sender,
      recipient: turn.recipient,
      carrier: this.carrier,
      communicationCondition: condition,
      proposal: parsed.proposal,
      intentionDraft: parsed.privateLedgerDraft,
      deliveredArtifact,
    });

    this.rejections = 0;
    if (commit.delivery !== null) {
      this.recordDelivery({
        turn: turn.turn,
        recipient: turn.recipient,
        channelEventHash: commit.channelEvent.entryHash,
        deliveredArtifactHash: commit.channelEvent.publicArtifactHash,
      });
    }

    return {
      kind: 'accepted',
      channelEvent: commit.channelEvent,
      senderLedgerEvent: commit.senderLedgerEvent,
      delivery: commit.delivery,
      babyProposalHash: hashCanonical(HASH_DOMAINS.babyProposal, parsed.proposal),
      deliveredArtifactHash: commit.channelEvent.publicArtifactHash,
    };
  }

  /**
   * SPEC §9.6 `oracle` (E03 only, enforced by `RunConfigSchema`): the
   * Scenario Engine's minimal sufficient artifact is committed with
   * `origin: "gateway-control"` and no Baby proposal or sender-ledger
   * binding.
   */
  async submitControlArtifact(
    turn: GatewayTurnContext,
    artifact: AgentActionProposal['publicArtifact'],
  ): Promise<{ channelEvent: ChannelEvent; delivery: DeliveredChannelArtifact }> {
    if (this.condition !== 'oracle') {
      throw new ControlArtifactNotPermittedError(this.condition);
    }

    const validated = this.validateArtifact(artifact, 'oracle');
    const { channelEvent, delivery } = await this.evidence.commitControlArtifact({
      runId: this.runContext.runId,
      turn: turn.turn,
      logicalSender: turn.sender,
      recipient: turn.recipient,
      carrier: this.carrier,
      deliveredArtifact: validated,
    });

    this.recordDelivery({
      turn: turn.turn,
      recipient: turn.recipient,
      channelEventHash: channelEvent.entryHash,
      deliveredArtifactHash: channelEvent.publicArtifactHash,
    });

    return { channelEvent, delivery };
  }

  // -------------------------------------------------------------------------
  // Receiver path (SPEC §8.1 step 6, §8.2, §11.3)
  // -------------------------------------------------------------------------

  /**
   * The receiver's interpretation event. The echoed `channelEventHash` must
   * be the one the Gateway recorded for this turn *and this recipient*, so a
   * Baby cannot bind an interpretation to a delivery addressed to the other
   * Baby. A mismatch is a channel violation: the rejection is committed with
   * `sender` set to the offending recipient, then thrown.
   */
  async submitInterpretation(
    turn: GatewayTurnContext,
    recipient: BabyRole,
    envelope: LedgerDraftEnvelope,
  ): Promise<LedgerEvent> {
    const raw: unknown = envelope;
    if (!isPlainObject(raw) || !hasExactKeys(raw, ['channelEventHash', 'privateLedgerDraft'])) {
      return this.rejectInterpretation(turn, recipient, 'invalid-envelope', raw);
    }

    // §9.4: bound the envelope's structural complexity — in particular
    // `privateLedgerDraft.content` — before it reaches `validateLedgerEventDraft`
    // or the Evidence Writer's canonical hashing (`appendLedgerEvent`), for the
    // same reason as the proposal path above.
    if (!isWithinComplexityBudget(raw)) {
      return this.rejectInterpretation(turn, recipient, 'payload-too-complex', raw);
    }

    let parsed: LedgerDraftEnvelope;
    try {
      parsed = LedgerDraftEnvelopeSchema.parse(raw);
    } catch {
      return this.rejectInterpretation(turn, recipient, 'invalid-envelope', raw);
    }

    let draft: ValidatedDraft;
    try {
      draft = validateLedgerEventDraft(parsed.privateLedgerDraft);
    } catch {
      return this.rejectInterpretation(
        turn,
        recipient,
        'missing-interpretation',
        raw,
      );
    }
    if (draft.eventType !== 'interpretation.recorded') {
      return this.rejectInterpretation(
        turn,
        recipient,
        'missing-interpretation',
        raw,
      );
    }

    const delivery = this.deliveries.get(deliveryKey(turn.turn, recipient));
    if (
      delivery === undefined ||
      delivery.channelEventHash !== parsed.channelEventHash
    ) {
      return this.rejectInterpretation(
        turn,
        recipient,
        'interpretation-hash-mismatch',
        raw,
      );
    }

    return this.evidence.appendLedgerEvent({
      runId: this.runContext.runId,
      babyId: babyIdForRole(recipient),
      turn: turn.turn,
      draft,
      channelEventHash: parsed.channelEventHash,
    });
  }

  // -------------------------------------------------------------------------
  // Rejection framework (SPEC §9.4, ALD-034)
  // -------------------------------------------------------------------------

  /**
   * SPEC §8.3: commit the forfeited turn as `channel.rejected` with reason
   * `timeout`. There is no payload to hash, so the domain-separated hash of
   * canonical `null` is recorded — the same convention §11.5 uses for the
   * `disabled` public-artifact hash.
   */
  async rejectForTimeout(
    turn: GatewayTurnContext,
    sender: BabyRole,
  ): Promise<GatewayRejection> {
    const rejection = await this.commitRejection(turn.turn, sender, 'timeout', null);
    return { kind: 'rejected', ...rejection };
  }

  // -------------------------------------------------------------------------
  // Affect protocol (SPEC §9.3, ALD-033) — thin delegations; the rules,
  // the modes, the window discipline, and the derived mapping all live in
  // `affect.ts`.
  // -------------------------------------------------------------------------

  /**
   * The run's affect protocol. Created on first use, so a run with
   * `affectMode: "none"` never builds one and an affect call on such a run
   * raises `AffectDisabledError`. The Nursery Controller reaches
   * `openWindow`/`takePrivateMeasurements` through this accessor; it may also
   * construct an `AffectProtocol` directly with its own clock.
   */
  get affect(): AffectProtocol {
    this.affectProtocol ??= new AffectProtocol({
      runContext: this.runContext,
      evidence: this.evidence,
      commitAffectRejection: (turn, sender, payload) =>
        this.commitRejection(turn, sender, 'affect-violation', payload),
      now: () => new Date().toISOString(),
    });
    return this.affectProtocol;
  }

  submitAffect(
    window: AffectWindow,
    proposal: unknown,
  ): Promise<AffectSubmitResult> {
    return this.affect.submitAffect(window, proposal);
  }

  recordDerivedAffect(
    window: AffectWindow,
    measurement: AffectStateMeasurement,
  ): Promise<DerivedAffectResult> {
    return this.affect.recordDerivedAffect(window, measurement);
  }

  consecutiveRejections(): number {
    return this.rejections;
  }

  resetRejectionCounter(): void {
    this.rejections = 0;
  }

  // -------------------------------------------------------------------------
  // Read-side helpers for the Nursery Controller
  // -------------------------------------------------------------------------

  /** The delivery recorded for one turn and recipient, if any. */
  deliveryFor(turn: number, recipient: BabyRole): GatewayDelivery | undefined {
    return this.deliveries.get(deliveryKey(turn, recipient));
  }

  /** The active carrier's protocol module. */
  get carrierProtocol(): CarrierModule {
    return this.module;
  }

  /** SPEC §9.6 condition the Gateway applies to every accepted proposal. */
  get condition(): RunConfig['communicationCondition'] {
    return this.runContext.config.communicationCondition;
  }

  get carrier(): RunConfig['carrierMode'] {
    return this.runContext.config.carrierMode;
  }

  get carrierContext(): CarrierContext {
    return {
      runContext: this.runContext,
      maxSymbolRepeats: this.maxSymbolRepeats,
    };
  }

  /** SPEC §8.3 wrapper bound to this run's `turnResponseBudgetMs`. */
  withTurnDeadline<T>(promise: PromiseLike<T>, budgetMs?: number): Promise<T> {
    return withTurnDeadline(
      promise,
      budgetMs ?? this.runContext.config.turnResponseBudgetMs,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertInventory(inventory: readonly string[]): void {
    if (inventory.length < 2) {
      throw new InvalidSymbolInventoryError(
        'a run must declare at least two symbols',
      );
    }
    if (new Set(inventory).size !== inventory.length) {
      throw new InvalidSymbolInventoryError('inventory symbols must be unique');
    }
    for (const symbol of inventory) {
      if (symbol.length === 0 || /\s/u.test(symbol)) {
        throw new InvalidSymbolInventoryError(
          'inventory symbols must be non-empty and contain no whitespace',
        );
      }
    }
  }

  private resolveConstantArtifact(
    provided: PublicArtifact | undefined,
  ): PublicArtifact {
    if (provided === undefined) {
      return this.module.constantArtifact(this.carrierContext);
    }
    return this.validateArtifact(provided, 'constant');
  }

  /**
   * Runs a researcher-supplied artifact through the carrier module. The
   * module judges a full proposal, so the artifact is wrapped in the carrier's
   * first offered kind; the wrapper is discarded and never delivered.
   */
  private validateArtifact(
    artifact: PublicArtifact,
    origin: 'constant' | 'oracle' | 'shuffled-batch',
  ): PublicArtifact {
    const kind = this.module.allowedKinds[0] as AgentActionProposal['kind'];
    const validation = this.module.validate(
      { kind, publicArtifact: artifact },
      this.carrierContext,
    );
    if (!validation.ok) {
      throw new InvalidControlArtifactError(
        validation.reasonCode,
        origin,
        validation.detail,
      );
    }
    return validation.artifact;
  }

  /** SPEC §9.6 table, applied after validation and before the channel event. */
  private applyCommunicationControl(
    turn: GatewayTurnContext,
    artifact: PublicArtifact,
  ): PublicArtifact | null {
    switch (this.condition) {
      case 'normal':
        return artifact;
      case 'disabled':
        return null;
      case 'constant':
        return this.constant;
      case 'random':
        return this.module.randomArtifact(
          this.conditionPrng.derive(String(turn.turn)),
          this.carrierContext,
        );
      case 'shuffled':
        return this.shuffledArtifact(turn);
      case 'oracle':
        throw new OracleRequiresControlArtifactError();
    }
  }

  /**
   * SPEC §9.6 `shuffled`: deliver another episode's artifact from the same
   * evaluation batch under a seeded permutation. The permutation is derived
   * per batch size (not per turn) so every episode of a batch uses the same
   * one, and a batch of two or more is deranged so no episode can receive its
   * own artifact.
   */
  private shuffledArtifact(turn: GatewayTurnContext): PublicArtifact {
    const batch = turn.batchArtifacts;
    const index = turn.batchIndex;
    if (
      batch === undefined ||
      batch.length === 0 ||
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= batch.length
    ) {
      throw new ShuffledBatchRequiredError(turn.turn);
    }

    const permutation = this.permutationFor(batch.length);
    const source = permutation[index] as number;
    return this.validateArtifact(batch[source] as PublicArtifact, 'shuffled-batch');
  }

  private permutationFor(size: number): number[] {
    const cached = this.permutations.get(size);
    if (cached) {
      return cached;
    }

    const indices = Array.from({ length: size }, (_, index) => index);
    const prng = this.conditionPrng.derive(String(size));
    let permutation = prng.shuffle(indices);
    if (size >= 2) {
      for (
        let attempt = 0;
        attempt < DERANGEMENT_ATTEMPTS && !isDerangement(permutation);
        attempt += 1
      ) {
        permutation = prng.shuffle(indices);
      }
      if (!isDerangement(permutation)) {
        // Deterministic fallback: rotate by one, which is a derangement for
        // every size >= 2.
        permutation = indices.map((value) => (value + 1) % size);
      }
    }

    this.permutations.set(size, permutation);
    return permutation;
  }

  private recordDelivery(delivery: GatewayDelivery): void {
    this.deliveries.set(
      deliveryKey(delivery.turn, delivery.recipient),
      delivery,
    );
  }

  private async rejectProposal(
    turn: GatewayTurnContext,
    payload: unknown,
    reasonCode: GatewayReasonCode,
  ): Promise<GatewaySubmitResult> {
    const rejection = await this.commitRejection(
      turn.turn,
      turn.sender,
      reasonCode,
      payload,
    );
    return { kind: 'rejected', ...rejection };
  }

  private async rejectInterpretation(
    turn: GatewayTurnContext,
    recipient: BabyRole,
    reasonCode: GatewayReasonCode,
    payload: unknown,
  ): Promise<never> {
    const rejection = await this.commitRejection(
      turn.turn,
      recipient,
      reasonCode,
      payload,
    );
    throw new InterpretationRejectedError(
      reasonCode,
      rejection.channelEvent,
      rejection.rejectedPayloadHash,
      rejection.consecutiveRejections,
      rejection.pauseRequested,
    );
  }

  /**
   * The one place a `channel.rejected` event is created (ALD-034). Every
   * registered protocol module shares this shape, this counter, and this
   * pause policy.
   */
  private async commitRejection(
    turn: number,
    sender: BabyRole,
    reasonCode: GatewayReasonCode,
    payload: unknown,
  ): Promise<Omit<GatewayRejection, 'kind'>> {
    const rejectedPayloadHash = hashCanonical(
      HASH_DOMAINS.rejectedPayload,
      jsonSafe(payload),
    );
    const channelEvent = await this.evidence.commitRejection({
      runId: this.runContext.runId,
      turn,
      sender,
      carrier: this.carrier,
      communicationCondition: this.condition,
      reasonCode,
      rejectedPayloadHash,
    });

    this.rejections += 1;
    const ceiling = this.runContext.config.maxConsecutiveRejections;
    if (this.rejections === ceiling) {
      await this.evidence.appendInterventionEvent({
        runId: this.runContext.runId,
        eventType: 'safety-trigger',
        actorId: GATEWAY_ACTOR_ID,
        reasonCode: MAX_CONSECUTIVE_REJECTIONS_REASON,
        details: {
          consecutiveRejections: this.rejections,
          maxConsecutiveRejections: ceiling,
          sender,
          turn,
          lastReasonCode: reasonCode,
        },
      });
    }

    return {
      channelEvent,
      reasonCode,
      rejectedPayloadHash,
      consecutiveRejections: this.rejections,
      pauseRequested: this.rejections >= ceiling,
    };
  }
}
