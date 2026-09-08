/**
 * The six-display affect protocol (SPECIFICATION.md §9.3, §11.6; ALD-033).
 *
 * All seven §9.3 rules are enforced here, in one place, so `SymbolGatewayImpl`
 * only delegates:
 *
 * 1. the display occupies its own typed field — an `AffectEvent` on the
 *    `affect` stream — and can never appear inside a `symbols`/`strokes`
 *    payload: the affect surface is a separate method that accepts exactly
 *    `{ kind: 'submit_affect', publicArtifact: { displayId } }` and nothing
 *    else, and the carrier modules never see it;
 * 2. a window opens only through {@link AffectProtocol.openWindow}, which the
 *    runtime calls after a Gateway-defined outcome and which refuses a turn the
 *    fixed `affectWindowSchedule` does not allow (no Baby-chosen or extra
 *    windows);
 * 3. exactly one allowlisted `A1`-`A6` per open window — sequences,
 *    repetitions, combinations, custom forms, and extra fields are rejections;
 * 4. delivery timing and envelope size normalization is the runtime's and
 *    `@ald/isolation`'s job (§10.3); what this module contributes is a
 *    *constant-shape* result and a constant-size submission —
 *    {@link normalizedAffectSubmission}, {@link AFFECT_ACCEPTED_RESULT_KEYS},
 *    {@link AFFECT_REJECTED_RESULT_KEYS} — and nothing more. This module makes
 *    no timing claim of any kind;
 * 5. one submission per window, by the window's single permitted sender: any
 *    submission (accepted *or* rejected) consumes the window, so there is no
 *    variable retry count (§10.3) and the recipient cannot answer until its own
 *    next window;
 * 6. every violation is committed as `channel.rejected` with reason
 *    `affect-violation` through the one ALD-034 rejection framework, so it
 *    shares the payload-hash-only shape, the consecutive-rejection counter, and
 *    the automatic-pause policy with every other channel violation;
 * 7. the §15.3 leakage estimator is `@ald/analysis`'s `evaluateAffectLeakage`;
 *    what this module guarantees is that the data it needs — the sender's
 *    chosen display per window — is recorded for every accepted window.
 *
 * Mode notes (SPEC §9.3, CONCEPT-IDEA.md §19.1):
 *
 * - `declared` — the chosen display is delivered as chosen;
 * - `permuted` — a per-run seeded permutation of `A1..A6` is applied between
 *   the sender's choice and the recipient's delivery. The `AffectEvent`
 *   records the **sender's chosen** display (that is the quantity §9.3 rule 7
 *   and E20 analyse, and the Evidence Store is inside the Nursery trust zone,
 *   never Baby-readable); the delivered value is returned to the runtime only
 *   and is reproducible from the run seed. The permutation itself is never
 *   returned to a Baby-facing caller;
 * - `opaque` — byte-for-byte identical Gateway behaviour to `declared`; the
 *   difference is only in the Baby-facing display labels the runtime and the
 *   learner contract supply, which the Gateway never sees. The tests assert
 *   this identity rather than asserting a semantic difference;
 * - `derived` — `submit_affect` is unavailable ({@link affectActionAvailable}
 *   returns `false`, and a submission is an `affect-violation`). The runtime
 *   passes the adapter's private `AffectStateMeasurement` to
 *   {@link AffectProtocol.recordDerivedAffect}; the complete measurement is
 *   kept privately and returned to the runtime for a private ledger/audit
 *   record, and only the fixed pre-registered mapping's single display reaches
 *   the public `AffectEvent`;
 * - `emergent` — no `AffectEvent` is ever produced. The display is an artifact
 *   of the selected alternate carrier and is an ordinary `ChannelEvent`;
 *   {@link tagEmergentAffect} produces the analysis-side tag, which lives in
 *   analysis and never in a signed event.
 *
 * Research-integrity note: nothing here claims that a Baby has an affective
 * state. The protocol constrains a six-valued side channel and records what was
 * chosen; `derived` mode records an adapter's self-reported scores. Both are
 * software behaviour (Prototype Mode), not a research finding.
 */
import {
  AffectStateMeasurementSchema,
  AFFECT_DISPLAY_IDS,
  HASH_DOMAINS,
  type AffectDisplayId,
  type AffectEvent,
  type AffectStateMeasurement,
  type AffectSubmitResult,
  type AffectWindow,
  type BabyRole,
  type ChannelEvent,
  type EvidenceWriter,
  type GatewayRunContext,
  type RunConfig,
  type Sha256Hash,
} from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';

import {
  AffectDisabledError,
  AffectModeMismatchError,
  AffectWindowNotOpenError,
  InvalidAffectWindowError,
} from './affect-errors.js';
import {
  AFFECT_DISPLAY_COUNT,
  SUPPORTED_MEASUREMENT_VERSIONS,
  resolveAffectDerivedMapping,
  type AffectDerivedMapping,
} from './affect-mapping.js';
import {
  affectActionAvailable,
  affectWindowDue,
  assertValidAffectWindow,
  parseAffectWindowSchedule,
  type AffectWindowSchedule,
} from './affect-windows.js';
import { isPlainObject, isWithinComplexityBudget } from './inspect.js';

/**
 * Domain separator for the private measurement digest of `derived` mode.
 *
 * The separator is centralized in `HASH_DOMAINS`; this alias remains part of
 * the Gateway's public API for callers that need to reproduce the digest.
 */
export const AFFECT_MEASUREMENT_HASH_DOMAIN = HASH_DOMAINS.affectMeasurement;

/** SPEC §9.3 rule 6: the single reason code for every affect violation. */
export const AFFECT_VIOLATION_REASON = 'affect-violation' as const;

/** Exact key set of an accepted `submit_affect` result (constant shape). */
export const AFFECT_ACCEPTED_RESULT_KEYS: readonly string[] = [
  'affectEvent',
  'deliveredDisplayId',
  'kind',
];

/** Exact key set of a rejected affect result, for every violation alike. */
export const AFFECT_REJECTED_RESULT_KEYS: readonly string[] = [
  'channelEvent',
  'consecutiveRejections',
  'kind',
  'pauseRequested',
  'reasonCode',
  'rejectedPayloadHash',
];

/**
 * The canonical, constant-size submission a Baby makes inside an open window.
 * Every one of the six displays produces the same canonical byte length, which
 * is the envelope-size half of §9.3 rule 4 that the Gateway can guarantee on
 * its own.
 */
export function normalizedAffectSubmission(displayId: AffectDisplayId): {
  kind: 'submit_affect';
  publicArtifact: { displayId: AffectDisplayId };
} {
  return { kind: 'submit_affect', publicArtifact: { displayId } };
}

/** What `commitRejection` returns; mirrors the ALD-034 rejection framework. */
export interface AffectRejectionCommit {
  channelEvent: ChannelEvent;
  reasonCode: string;
  rejectedPayloadHash: Sha256Hash;
  consecutiveRejections: number;
  pauseRequested: boolean;
}

/**
 * The seam between the affect protocol and the Gateway core. The protocol
 * never writes evidence itself except through `evidence.appendAffectEvent`,
 * and never counts rejections itself: `commitAffectRejection` is the Gateway's
 * one rejection path (ALD-034), which owns the counter and the pause policy.
 */
export interface AffectProtocolHost {
  readonly runContext: GatewayRunContext;
  readonly evidence: EvidenceWriter;
  commitAffectRejection(
    turn: number,
    sender: BabyRole,
    payload: unknown,
  ): Promise<AffectRejectionCommit>;
  /** Window-close timestamp source; injected so tests are deterministic. */
  now(): string;
}

/**
 * The private `derived`-mode record. It carries the *complete* measurement, so
 * it must never be written to a public event or a Baby-facing surface — the
 * runtime appends it as a private ledger/audit record (SPEC §9.3 "records the
 * complete internal measurement privately").
 */
export interface DerivedAffectRecord {
  windowId: string;
  turn: number;
  sender: BabyRole;
  /** Name of the fixed pre-registered mapping that produced the display. */
  mapping: string;
  measurement: AffectStateMeasurement;
  /** Domain-separated digest of the canonical measurement. */
  measurementHash: Sha256Hash;
  /** The display the mapping selected, i.e. the public `AffectEvent` value. */
  displayId: AffectDisplayId;
}

/**
 * `recordDerivedAffect`'s result: an `AffectSubmitResult` plus, when accepted,
 * the private measurement record for the runtime to persist privately. The
 * extra field is not part of the public `AffectEvent` and is never delivered
 * to a Baby.
 */
export type DerivedAffectResult = AffectSubmitResult & {
  privateMeasurement?: DerivedAffectRecord;
};

/** The analysis-side tag of `affectMode: "emergent"` (SPEC §9.3). */
export const EMERGENT_AFFECT_ANALYSIS_TAG = 'emergent-affect' as const;

export interface EmergentAffectTag {
  analysisTag: typeof EMERGENT_AFFECT_ANALYSIS_TAG;
  channelEventHash: Sha256Hash;
  turn: number;
  sender: BabyRole;
}

/**
 * SPEC §9.3 `emergent`: "no `AffectEvent` is produced. The display is an
 * artifact of the selected alternate carrier and is recorded as an ordinary
 * `ChannelEvent` with analysis tag `emergent-affect`". The tag is derived
 * from an already-committed channel event and is *not* part of the signed
 * event, so tagging cannot alter evidence.
 */
export function tagEmergentAffect(channelEvent: ChannelEvent): EmergentAffectTag {
  return {
    analysisTag: EMERGENT_AFFECT_ANALYSIS_TAG,
    channelEventHash: channelEvent.entryHash,
    turn: channelEvent.turn,
    sender: channelEvent.logicalSender,
  };
}

/** True when the run's mode produces `AffectEvent`s at all (SPEC §11.6). */
export function producesAffectEvents(
  affectMode: RunConfig['affectMode'],
): boolean {
  return (
    affectMode === 'declared' ||
    affectMode === 'permuted' ||
    affectMode === 'opaque' ||
    affectMode === 'derived'
  );
}

/**
 * Fails fast on an affect configuration the protocol cannot honour. The
 * Nursery Controller should call this when it builds the run context, so an
 * unregistered `affectDerivedMapping` or an unrecognised `affectWindowSchedule`
 * is refused before turn 1 rather than on the first window.
 */
export function assertAffectConfiguration(config: RunConfig): void {
  if (config.affectMode === 'none') {
    return;
  }
  parseAffectWindowSchedule(config.affectWindowSchedule);
  if (config.affectMode === 'derived') {
    resolveAffectDerivedMapping(config.affectDerivedMapping);
  }
}

type WindowStatus = 'open' | 'consumed';

interface WindowState {
  window: AffectWindow;
  status: WindowStatus;
}

/** How many past windows and private measurements are retained in memory. */
const WINDOW_HISTORY_LIMIT = 4096;

/** The affect mode of an `AffectEvent` (SPEC §11.6 excludes none/emergent). */
type RecordedAffectMode = AffectEvent['affectMode'];

export class AffectProtocol {
  readonly mode: RunConfig['affectMode'];
  private readonly schedule: AffectWindowSchedule;
  private readonly mapping: AffectDerivedMapping | undefined;
  /**
   * `permuted` only. Derived from the run seed through the same labelled
   * `SeededPrng.derive` chain the §9.6 controls use (`seed → 'affect' →
   * 'permutation'`), so a replay from the registered seed reproduces it
   * exactly (SPEC §14.3). It is deranged, so no display maps to itself and
   * `permuted` differs from `declared` for every display — an
   * implementation-defined choice recorded in BACKLOG §15.
   */
  private readonly permutation: readonly number[] | undefined;
  private readonly windows = new Map<string, WindowState>();
  private readonly measurements = new Map<string, DerivedAffectRecord>();

  constructor(private readonly host: AffectProtocolHost) {
    const config = host.runContext.config;
    this.mode = config.affectMode;
    if (this.mode === 'none') {
      throw new AffectDisabledError();
    }
    this.schedule = parseAffectWindowSchedule(config.affectWindowSchedule);
    this.mapping =
      this.mode === 'derived'
        ? resolveAffectDerivedMapping(config.affectDerivedMapping)
        : undefined;
    this.permutation =
      this.mode === 'permuted'
        ? derangedPermutation(host.runContext.seed)
        : undefined;
  }

  // -------------------------------------------------------------------------
  // Window discipline (SPEC §9.3 rules 2 and 5)
  // -------------------------------------------------------------------------

  /**
   * Opens the window the fixed schedule allows after `window.turn`'s outcome.
   * Any previously open window is closed first: a Baby that did not answer in
   * its window has no second chance at it (rule 5), and a window the schedule
   * does not allow is refused outright (rule 2, "never at a Baby-chosen
   * arbitrary point").
   */
  openWindow(window: AffectWindow): AffectWindow {
    assertValidAffectWindow(window);
    if (!affectWindowDue(this.schedule, window.turn)) {
      throw new InvalidAffectWindowError(
        `the fixed schedule ${this.schedule.schedule} opens no window after turn ${window.turn}`,
      );
    }
    const existing = this.windows.get(window.windowId);
    if (existing !== undefined) {
      throw new InvalidAffectWindowError(
        `window ${window.windowId} was already opened once`,
      );
    }
    for (const state of this.windows.values()) {
      state.status = 'consumed';
    }
    this.windows.set(window.windowId, { window, status: 'open' });
    this.evict(this.windows);
    return window;
  }

  /** The currently open window, if any. */
  openWindowState(): AffectWindow | undefined {
    for (const state of this.windows.values()) {
      if (state.status === 'open') {
        return state.window;
      }
    }
    return undefined;
  }

  /** SPEC §6.3: whether `submit_affect` belongs in `availableActions` now. */
  affectActionAvailable(): boolean {
    return affectActionAvailable(this.mode, this.openWindowState() !== undefined);
  }

  // -------------------------------------------------------------------------
  // Baby submissions: declared / permuted / opaque (SPEC §9.3 rules 1, 3, 6)
  // -------------------------------------------------------------------------

  /**
   * The `SymbolGateway.submitAffect` contract shape. The submitting Baby is
   * the window's single permitted sender; the runtime must route only that
   * Baby's submission here. Use {@link submitAffectFrom} when the caller knows
   * the actual submitter and wants rule 5 enforced against an impostor.
   */
  submitAffect(
    window: AffectWindow,
    proposal: unknown,
  ): Promise<AffectSubmitResult> {
    return this.submitAffectFrom(window.sender, window, proposal);
  }

  /**
   * One submission attempt by `sender`. Everything a Baby can get wrong is a
   * rejection, never a thrown error: wrong mode, wrong window, wrong sender,
   * wrong shape, a sequence, a repetition, a combination, an extra field, a
   * string, or a code point outside `A1`-`A6`.
   */
  async submitAffectFrom(
    sender: BabyRole,
    window: AffectWindow,
    proposal: unknown,
  ): Promise<AffectSubmitResult> {
    assertValidAffectWindow(window);

    // `derived` and `emergent` have no Baby-facing affect surface at all
    // (ALD-033 criterion 2). A submission under either mode is a violation.
    if (this.mode === 'derived' || this.mode === 'emergent') {
      return this.rejectAffect(window, sender, proposal);
    }

    const state = this.windows.get(window.windowId);
    if (
      state === undefined ||
      state.status !== 'open' ||
      state.window.sender !== window.sender ||
      state.window.recipient !== window.recipient ||
      state.window.turn !== window.turn
    ) {
      // Out-of-window, unknown-window, or already-answered window.
      return this.rejectAffect(window, sender, proposal);
    }

    // Rule 5: only the window's sender may submit in it.
    if (sender !== window.sender) {
      return this.rejectAffect(window, sender, proposal, state);
    }

    const displayId = readAffectSubmission(proposal);
    if (displayId === undefined) {
      return this.rejectAffect(window, sender, proposal, state);
    }

    // Accepted: the window is spent either way (§10.3 no variable retry).
    state.status = 'consumed';
    const recordedMode = this.mode as RecordedAffectMode;
    const affectEvent = await this.host.evidence.appendAffectEvent({
      runId: this.host.runContext.runId,
      turn: window.turn,
      windowId: window.windowId,
      sender: window.sender,
      displayId,
      affectMode: recordedMode,
      deliveredAt: this.host.now(),
    });

    return {
      kind: 'accepted',
      affectEvent,
      deliveredDisplayId: this.deliveredDisplay(displayId),
    };
  }

  // -------------------------------------------------------------------------
  // Derived mode (SPEC §9.3, ALD-033 criterion 2)
  // -------------------------------------------------------------------------

  /**
   * Records the adapter's private measurement and applies the fixed
   * pre-registered mapping. The complete measurement is returned in
   * `privateMeasurement` for the runtime to store privately and never reaches
   * the public `AffectEvent`.
   *
   * A measurement that fails `AffectStateMeasurementSchema`, carries a
   * non-finite score, or declares an unsupported `measurementVersion` is a
   * *channel violation*, not a thrown error: the measurement is adapter output
   * and crosses the same trust boundary as a proposal, so it is committed as
   * `channel.rejected` with a payload hash and no content.
   */
  async recordDerivedAffect(
    window: AffectWindow,
    measurement: AffectStateMeasurement,
  ): Promise<DerivedAffectResult> {
    assertValidAffectWindow(window);
    if (this.mode !== 'derived') {
      throw new AffectModeMismatchError(this.mode, ['derived']);
    }
    const state = this.windows.get(window.windowId);
    if (state === undefined || state.status !== 'open') {
      throw new AffectWindowNotOpenError(window.windowId);
    }

    const validated = readMeasurement(measurement);
    if (validated === undefined) {
      return this.rejectAffect(window, window.sender, measurement, state);
    }

    state.status = 'consumed';
    const mapping = this.mapping as AffectDerivedMapping;
    const displayId = mapping.map(validated);
    const record: DerivedAffectRecord = {
      windowId: window.windowId,
      turn: window.turn,
      sender: window.sender,
      mapping: mapping.name,
      measurement: validated,
      measurementHash: hashCanonical(
        AFFECT_MEASUREMENT_HASH_DOMAIN,
        validated,
      ),
      displayId,
    };
    this.measurements.set(window.windowId, record);
    this.evict(this.measurements);

    const affectEvent = await this.host.evidence.appendAffectEvent({
      runId: this.host.runContext.runId,
      turn: window.turn,
      windowId: window.windowId,
      sender: window.sender,
      displayId,
      affectMode: 'derived',
      deliveredAt: this.host.now(),
    });

    return {
      kind: 'accepted',
      affectEvent,
      deliveredDisplayId: displayId,
      privateMeasurement: record,
    };
  }

  /** The private measurement recorded for one window, if still retained. */
  privateMeasurementFor(windowId: string): DerivedAffectRecord | undefined {
    return this.measurements.get(windowId);
  }

  /** Drains the retained private measurements; the runtime persists them. */
  takePrivateMeasurements(): DerivedAffectRecord[] {
    const drained = [...this.measurements.values()];
    this.measurements.clear();
    return drained;
  }

  // -------------------------------------------------------------------------
  // Researcher-only accessors
  // -------------------------------------------------------------------------

  /**
   * The `permuted`-mode display permutation as `A1..A6` indices.
   *
   * Researcher-only: this is ground truth. It MUST NOT be given to a Baby
   * context, put in a Baby-visible observation, or written to any Baby-facing
   * surface — knowing it collapses `permuted` onto `declared`.
   */
  researcherOnlyPermutation(): readonly number[] | undefined {
    return this.permutation === undefined ? undefined : [...this.permutation];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** `permuted` applies the run's private permutation; every other mode does not. */
  private deliveredDisplay(chosen: AffectDisplayId): AffectDisplayId {
    if (this.permutation === undefined) {
      return chosen;
    }
    const index = AFFECT_DISPLAY_IDS.indexOf(chosen);
    const mapped = this.permutation[index] as number;
    return AFFECT_DISPLAY_IDS[mapped] as AffectDisplayId;
  }

  private async rejectAffect(
    window: AffectWindow,
    sender: BabyRole,
    payload: unknown,
    state?: WindowState,
  ): Promise<Extract<AffectSubmitResult, { kind: 'rejected' }>> {
    if (state !== undefined) {
      state.status = 'consumed';
    }
    // A payload past the §9.4 complexity budget is hashed as a fixed marker
    // rather than canonicalized, for the same reason the proposal path bounds
    // complexity before hashing: an adversarial adapter must not be able to
    // exhaust the stack instead of failing a shape check.
    const hashable = isWithinComplexityBudget(payload)
      ? payload
      : { affectPayload: 'too-complex' };
    const commit = await this.host.commitAffectRejection(
      window.turn,
      sender,
      hashable,
    );
    return {
      kind: 'rejected',
      channelEvent: commit.channelEvent,
      reasonCode: commit.reasonCode,
      rejectedPayloadHash: commit.rejectedPayloadHash,
      consecutiveRejections: commit.consecutiveRejections,
      pauseRequested: commit.pauseRequested,
    };
  }

  private evict(map: Map<string, unknown>): void {
    while (map.size > WINDOW_HISTORY_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done === true) {
        return;
      }
      map.delete(oldest.value);
    }
  }
}

/**
 * SPEC §9.3 rules 1 and 3. Returns the single allowlisted display, or
 * `undefined` for every violation: a non-object, an extra proposal or artifact
 * field, a wrong `kind`, a missing or non-string `displayId`, an array
 * (sequence or repetition), an object (combination), a custom form, or a code
 * point outside `A1`-`A6`.
 *
 * The raw payload is inspected, never zod-parsed first, so an unknown key is
 * detected before a schema could strip it (§11.3).
 */
function readAffectSubmission(proposal: unknown): AffectDisplayId | undefined {
  if (!isWithinComplexityBudget(proposal) || !isPlainObject(proposal)) {
    return undefined;
  }
  const keys = Object.keys(proposal);
  if (keys.length !== 2 || !('kind' in proposal) || !('publicArtifact' in proposal)) {
    return undefined;
  }
  if (proposal.kind !== 'submit_affect') {
    return undefined;
  }
  const artifact = proposal.publicArtifact;
  if (!isPlainObject(artifact)) {
    return undefined;
  }
  const artifactKeys = Object.keys(artifact);
  if (artifactKeys.length !== 1 || artifactKeys[0] !== 'displayId') {
    return undefined;
  }
  const displayId = artifact.displayId;
  if (typeof displayId !== 'string') {
    return undefined;
  }
  return (AFFECT_DISPLAY_IDS as readonly string[]).includes(displayId)
    ? (displayId as AffectDisplayId)
    : undefined;
}

/**
 * Validates an adapter-supplied `AffectStateMeasurement`: exactly the schema's
 * fields, six finite scores, and a supported `measurementVersion`. Returns the
 * parsed value or `undefined`; the caller turns `undefined` into an
 * `affect-violation`.
 */
function readMeasurement(
  measurement: unknown,
): AffectStateMeasurement | undefined {
  if (!isWithinComplexityBudget(measurement) || !isPlainObject(measurement)) {
    return undefined;
  }
  const keys = Object.keys(measurement);
  if (
    keys.length !== 2 ||
    !('measurementVersion' in measurement) ||
    !('scores' in measurement)
  ) {
    return undefined;
  }
  const parsed = AffectStateMeasurementSchema.safeParse(measurement);
  if (!parsed.success) {
    return undefined;
  }
  const value = parsed.data;
  if (!SUPPORTED_MEASUREMENT_VERSIONS.includes(value.measurementVersion)) {
    return undefined;
  }
  if (value.scores.some((score) => !Number.isFinite(score))) {
    return undefined;
  }
  return value;
}

/**
 * A seeded derangement of `[0..5]`: a permutation in which no display maps to
 * itself. Derived deterministically from the run seed; the rotation fallback
 * is a derangement for every size >= 2, so the function always terminates.
 */
function derangedPermutation(seed: string): readonly number[] {
  const prng = new SeededPrng(seed).derive('affect').derive('permutation');
  const indices = Array.from({ length: AFFECT_DISPLAY_COUNT }, (_, i) => i);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = prng.shuffle(indices);
    if (candidate.every((value, index) => value !== index)) {
      return candidate;
    }
  }
  return indices.map((value) => (value + 1) % AFFECT_DISPLAY_COUNT);
}
