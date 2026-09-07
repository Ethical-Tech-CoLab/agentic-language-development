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
import type { SeededPrng } from '@ald/hashing';

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
 * Per-event blinding nonces (LEDGER §12): 24 lowercase hex characters, i.e.
 * 96 bits, drawn from a dedicated child stream of this Baby's private PRNG
 * (`SeededPrng.derive('blinding-nonce')`). Three `nextUint32()` draws are
 * concatenated as 8 hex characters each. The stream is private to the Baby and
 * seeded from `LearnerInitContext.seed`, so nonces replay exactly under SPEC
 * §14.3 while remaining unpredictable to anyone without the run seed.
 */
export class BlindingNonceSource {
  constructor(private readonly prng: SeededPrng) {}

  next(): string {
    let nonce = '';
    for (let index = 0; index < 3; index += 1) {
      nonce += this.prng.nextUint32().toString(16).padStart(8, '0');
    }
    return nonce;
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
