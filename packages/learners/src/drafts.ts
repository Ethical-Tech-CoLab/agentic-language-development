/**
 * Private-ledger draft construction and validation for learner adapters.
 *
 * The event-type registry and its required content fields are the LEDGER
 * §5 list. They are replicated here rather than imported from `@ald/evidence`
 * so that `@ald/learners` stays free of the Evidence Store's native
 * `better-sqlite3` dependency (a learner adapter runs inside the Baby's
 * isolation boundary and never touches the store directly — SPEC §6.3). The
 * table is asserted to be identical to `@ald/evidence`'s in this package's
 * tests.
 *
 * Every draft an adapter produces uses `contentSchema: 'agent-native-ledger'`
 * (SPEC §11.4, CONCEPT-IDEA.md §20.6): association weights, probability
 * distributions and confidences, never an English gloss. The human audit
 * ledger is produced later by the Audit Interpreter and is never fed back.
 */
import {
  LedgerEventDraftSchema,
  type LedgerEventDraft,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';

/** LEDGER §5 event types. */
export const LEARNER_LEDGER_EVENT_TYPES = [
  'term.first_emitted',
  'term.first_received',
  'hypothesis.created',
  'hypothesis.revised',
  'hypothesis.contradicted',
  'hypothesis.abandoned',
  'construction.created',
  'construction.revised',
  'intention.recorded',
  'interpretation.recorded',
  'affect.recorded',
  'policy.checkpointed',
  'run.sealed',
] as const;

export type LearnerLedgerEventType =
  (typeof LEARNER_LEDGER_EVENT_TYPES)[number];

/** Content fields each event type must populate (LEDGER §5). */
export const REQUIRED_CONTENT_FIELDS = {
  'term.first_emitted': ['termRef'],
  'term.first_received': ['termRef'],
  'hypothesis.created': ['hypothesisRef'],
  'hypothesis.revised': ['hypothesisRef', 'priorHypothesisRef'],
  'hypothesis.contradicted': ['hypothesisRef', 'evidenceRef'],
  'hypothesis.abandoned': ['hypothesisRef', 'evidenceRef'],
  'construction.created': ['constructionRef'],
  'construction.revised': ['constructionRef', 'priorConstructionRef'],
  'intention.recorded': ['artifactRef'],
  'interpretation.recorded': ['artifactRef'],
  'affect.recorded': ['displayId'],
  'policy.checkpointed': ['policyCheckpointRef'],
  'run.sealed': ['checkpointRef'],
} as const satisfies Record<LearnerLedgerEventType, readonly string[]>;

export function isLearnerLedgerEventType(
  value: string,
): value is LearnerLedgerEventType {
  return (LEARNER_LEDGER_EVENT_TYPES as readonly string[]).includes(value);
}

function hasRequiredValue(
  content: Record<string, unknown>,
  field: string,
): boolean {
  const value = content[field];
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'string' || value.length > 0)
  );
}

/**
 * Parse a draft against `LedgerEventDraftSchema` and the required-content-field
 * table. Adapters run this on every draft they build so an invalid draft never
 * reaches the Gateway.
 */
export function validateLearnerDraft(value: unknown): LedgerEventDraft & {
  eventType: LearnerLedgerEventType;
} {
  const draft = LedgerEventDraftSchema.parse(value);
  if (!isLearnerLedgerEventType(draft.eventType)) {
    throw new Error(`Unknown ledger event type: ${draft.eventType}`);
  }
  const missing = REQUIRED_CONTENT_FIELDS[draft.eventType].filter(
    (field) => !hasRequiredValue(draft.content, field),
  );
  if (missing.length > 0) {
    throw new Error(
      `${draft.eventType} requires content fields: ${missing.join(', ')}`,
    );
  }
  return { ...draft, eventType: draft.eventType };
}

/**
 * Domain separator for a derived blinding nonce. Implementation-defined:
 * LEDGER §12 names the nonce but not its derivation.
 */
export const BLINDING_NONCE_DOMAIN = 'dtsf-learner-blinding-nonce-v1';

/** Characters of the `sha256:` prefix `hashCanonical` returns. */
const HASH_PREFIX_LENGTH = 'sha256:'.length;

/** Hex characters kept from the digest: 24 = 96 bits (LEDGER §12). */
const NONCE_HEX_LENGTH = 24;

/** The Baby-private material every nonce of one ledger stream is bound to. */
export interface BlindingNonceScope {
  /** `LearnerInitContext.seed`: the private per-Baby seed, never shared. */
  seed: string;
  runId: string;
  babyId: string;
}

/**
 * What distinguishes one event from every other event of the same Baby's
 * ledger. `turn` plus `eventType` plus `subjectId` already separate every
 * event this package emits; `content` is folded in as well so that two events
 * which would otherwise share the tuple — the same turn re-executed after a
 * crash recovery, say — still get different nonces, while an idempotent retry
 * of the *same* append (SPEC §14.5) reproduces the same nonce rather than
 * inventing a second one.
 */
export interface BlindingNonceDiscriminator {
  eventType: LearnerLedgerEventType;
  subjectId: string;
  /** The turn the event belongs to (SPEC §11.4). */
  turn: number;
  content: Record<string, unknown>;
}

/**
 * Per-event blinding nonces (LEDGER §12): 24 lowercase hex characters, i.e.
 * 96 bits, taken from a domain-separated hash of the Baby's private seed, the
 * run and Baby identity, and the event's own discriminator.
 *
 * The derivation is deliberately *position-independent*: it holds no stream
 * cursor, so re-initializing an adapter mid-run — which SPEC §7.3 crash
 * recovery does with the same seed and the same ledger chain — cannot restart
 * the nonce sequence and hand a later event a nonce an earlier event already
 * used. Nonces stay unpredictable to anyone without the private seed (LEDGER
 * §12's stated purpose) and replay exactly under SPEC §14.3.
 */
export class BlindingNonceSource {
  constructor(private readonly scope: BlindingNonceScope) {}

  next(discriminator: BlindingNonceDiscriminator): string {
    const digest = hashCanonical(BLINDING_NONCE_DOMAIN, {
      seed: this.scope.seed,
      runId: this.scope.runId,
      babyId: this.scope.babyId,
      eventType: discriminator.eventType,
      subjectId: discriminator.subjectId,
      turn: discriminator.turn,
      content: discriminator.content,
    });
    return digest.slice(
      HASH_PREFIX_LENGTH,
      HASH_PREFIX_LENGTH + NONCE_HEX_LENGTH,
    );
  }
}

export interface DraftInput {
  eventType: LearnerLedgerEventType;
  subjectId: string;
  content: Record<string, unknown>;
  blindingNonce: string;
  evidenceRefs?: string[];
}

/** Build and validate one `agent-native-ledger` draft. */
export function buildAgentNativeDraft(input: DraftInput): LedgerEventDraft {
  return validateLearnerDraft({
    eventType: input.eventType,
    contentSchema: 'agent-native-ledger',
    subjectId: input.subjectId,
    content: input.content,
    blindingNonce: input.blindingNonce,
    evidenceRefs: input.evidenceRefs ?? [],
  });
}

export interface NoncedDraftInput {
  eventType: LearnerLedgerEventType;
  subjectId: string;
  /** The turn the event belongs to (SPEC §11.4); part of the nonce. */
  turn: number;
  content: Record<string, unknown>;
  evidenceRefs?: string[];
}

/**
 * Build one `agent-native-ledger` draft whose blinding nonce is derived from
 * the event itself (LEDGER §12), so an adapter never has to hold a nonce
 * stream position that a mid-run re-initialization would reset.
 */
export function buildNoncedDraft(
  nonces: BlindingNonceSource,
  input: NoncedDraftInput,
): LedgerEventDraft {
  return buildAgentNativeDraft({
    eventType: input.eventType,
    subjectId: input.subjectId,
    content: input.content,
    blindingNonce: nonces.next({
      eventType: input.eventType,
      subjectId: input.subjectId,
      turn: input.turn,
      content: input.content,
    }),
    evidenceRefs: input.evidenceRefs ?? [],
  });
}
