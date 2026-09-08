/**
 * The agent-native ledger claim index the §15.2 probe planner reads.
 *
 * SPEC §15.2 is explicit that "ledger meanings MUST be validated
 * behaviorally, not accepted from ledger prose alone", and E16's procedure
 * fixes the order of operations: "Select ledger hypotheses before viewing
 * intervention outcomes". This module is the read side of that rule. It walks
 * a Baby's own hash-chained ledger events (SPEC §11.4, LEDGER §5) and reduces
 * them to the claims a probe can target:
 *
 * - `hypothesis.created` / `hypothesis.revised` establish the current claim
 *   for a form: which referent type code the Baby's own state puts the
 *   argmax on, and with what confidence (the tabular reference track writes
 *   `argmaxTypeCode`, `confidence`, and `associationOverTypeCodes` —
 *   `packages/learners/src/tabular-reinforce.ts`);
 * - `hypothesis.contradicted` is counted, never used to delete a claim
 *   (CONCEPT-IDEA.md §11.2 rule 5: contradictory evidence is preserved as its
 *   own event);
 * - `intention.recorded` / `interpretation.recorded` carry the message the
 *   Baby emitted or interpreted, which is the only evidence in the ledger of
 *   *which position* a form occupied.
 *
 * The index is content-schema tolerant on purpose: a track whose
 * `agent-native-ledger` content does not carry a parseable claim is counted
 * in `ignoredEvents` rather than rejected, because SPEC §11.4 lets
 * `agent-native-ledger` content be any canonicalizable object and this
 * package must not dictate a track's private state shape.
 *
 * Nothing here reads an outcome, a reward, or a success flag. That is what
 * makes a schedule built from this index verifiably pre-outcome (E16).
 */
import type { LedgerEvent } from '@ald/types';
import { z } from 'zod';

/** Subject prefix the reference tracks use for a form (`symbol:S07`). */
const FORM_SUBJECT_PREFIX = 'symbol:';

const hypothesisContentSchema = z.object({
  hypothesisRef: z.string().min(1),
  argmaxTypeCode: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  termRef: z.string().min(1).optional(),
});

const messageContentSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
});

/** The current ledger-claimed meaning of one form. */
export interface LedgerFormClaim {
  /**
   * The form the claim is about: a fixed-token/fixed-glyph inventory id, or a
   * generative carrier's `markHash`. Taken from `content.termRef` when
   * present, else from `subjectId`, with the `symbol:` prefix stripped.
   */
  readonly form: string;
  /** The claim's own reference, e.g. `hyp:S07:2` (LEDGER §5 revision graph). */
  readonly hypothesisRef: string;
  /** Referent type code the Baby's state puts its argmax on. */
  readonly claimedTypeCode: number;
  /** The Baby's own confidence in that argmax, as recorded. */
  readonly confidence: number;
  /** Ledger sequence of the event that established the current claim. */
  readonly sequence: number;
  readonly turn: number;
  /** `hypothesis.revised` events seen for this form. */
  readonly revisions: number;
  /** `hypothesis.contradicted` events seen for this form (never deletes it). */
  readonly contradictions: number;
  /**
   * Message positions this form was recorded in, most frequent first, ties
   * broken by the lower position. Empty when the ledger records no message
   * containing the form.
   */
  readonly positions: readonly { readonly position: number; readonly count: number }[];
}

export interface LedgerClaimIndex {
  /** Claims ranked by confidence (desc), fewer contradictions, then form. */
  readonly claims: readonly LedgerFormClaim[];
  readonly claimsByForm: ReadonlyMap<string, LedgerFormClaim>;
  /** Longest message length seen in the ledger's own records; 0 if none. */
  readonly observedMessageLength: number;
  /** Events whose content carried no parseable claim or message. */
  readonly ignoredEvents: number;
  readonly eventsRead: number;
}

interface MutableClaim {
  form: string;
  hypothesisRef: string;
  claimedTypeCode: number;
  confidence: number;
  sequence: number;
  turn: number;
  revisions: number;
  contradictions: number;
  positionCounts: Map<number, number>;
}

function formOf(
  content: { termRef?: string | undefined },
  subjectId: string,
): string {
  const raw = content.termRef ?? subjectId;
  return raw.startsWith(FORM_SUBJECT_PREFIX)
    ? raw.slice(FORM_SUBJECT_PREFIX.length)
    : raw;
}

/**
 * Reduce one Baby's ledger events to the claim index the planner selects
 * from. Events are read in `sequence` order, so the last
 * `hypothesis.created`/`hypothesis.revised` for a form wins regardless of the
 * order the caller passes them in.
 */
export function indexLedgerClaims(
  events: readonly LedgerEvent[],
): LedgerClaimIndex {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const claims = new Map<string, MutableClaim>();
  let ignoredEvents = 0;
  let observedMessageLength = 0;

  const positionsFor = (form: string): Map<number, number> => {
    const existing = claims.get(form);
    if (existing !== undefined) {
      return existing.positionCounts;
    }
    // A message may name a form that has no hypothesis event yet. Its
    // position evidence is kept so a later claim for the same form can use
    // it; a form that never gets a claim never becomes a probe target.
    const placeholder: MutableClaim = {
      form,
      hypothesisRef: '',
      claimedTypeCode: -1,
      confidence: -1,
      sequence: -1,
      turn: -1,
      revisions: 0,
      contradictions: 0,
      positionCounts: new Map<number, number>(),
    };
    claims.set(form, placeholder);
    return placeholder.positionCounts;
  };

  for (const event of ordered) {
    if (
      event.eventType === 'hypothesis.created' ||
      event.eventType === 'hypothesis.revised' ||
      event.eventType === 'hypothesis.contradicted' ||
      event.eventType === 'hypothesis.abandoned'
    ) {
      const parsed = hypothesisContentSchema.safeParse(event.content);
      if (!parsed.success) {
        ignoredEvents += 1;
        continue;
      }
      const form = formOf(parsed.data, event.subjectId);
      const existing = claims.get(form);
      const positionCounts =
        existing?.positionCounts ?? new Map<number, number>();
      if (event.eventType === 'hypothesis.contradicted') {
        claims.set(form, {
          form,
          hypothesisRef: existing?.hypothesisRef ?? parsed.data.hypothesisRef,
          claimedTypeCode:
            existing?.claimedTypeCode ?? parsed.data.argmaxTypeCode,
          confidence: existing?.confidence ?? parsed.data.confidence,
          sequence: existing?.sequence ?? event.sequence,
          turn: existing?.turn ?? event.turn,
          revisions: existing?.revisions ?? 0,
          contradictions: (existing?.contradictions ?? 0) + 1,
          positionCounts,
        });
        continue;
      }
      if (event.eventType === 'hypothesis.abandoned') {
        // An abandoned meaning is no longer a claim the ledger stands behind,
        // so it stops being a probe target; the position evidence stays.
        claims.set(form, {
          form,
          hypothesisRef: '',
          claimedTypeCode: -1,
          confidence: -1,
          sequence: -1,
          turn: -1,
          revisions: existing?.revisions ?? 0,
          contradictions: existing?.contradictions ?? 0,
          positionCounts,
        });
        continue;
      }
      claims.set(form, {
        form,
        hypothesisRef: parsed.data.hypothesisRef,
        claimedTypeCode: parsed.data.argmaxTypeCode,
        confidence: parsed.data.confidence,
        sequence: event.sequence,
        turn: event.turn,
        revisions:
          (existing?.revisions ?? 0) +
          (event.eventType === 'hypothesis.revised' ? 1 : 0),
        contradictions: existing?.contradictions ?? 0,
        positionCounts,
      });
      continue;
    }

    if (
      event.eventType === 'intention.recorded' ||
      event.eventType === 'interpretation.recorded'
    ) {
      const parsed = messageContentSchema.safeParse(event.content);
      if (!parsed.success) {
        ignoredEvents += 1;
        continue;
      }
      observedMessageLength = Math.max(
        observedMessageLength,
        parsed.data.symbols.length,
      );
      parsed.data.symbols.forEach((symbol, position) => {
        const counts = positionsFor(symbol);
        counts.set(position, (counts.get(position) ?? 0) + 1);
      });
      continue;
    }

    ignoredEvents += 1;
  }

  const materialized: LedgerFormClaim[] = [...claims.values()]
    .filter((claim) => claim.hypothesisRef.length > 0)
    .map((claim) => ({
      form: claim.form,
      hypothesisRef: claim.hypothesisRef,
      claimedTypeCode: claim.claimedTypeCode,
      confidence: claim.confidence,
      sequence: claim.sequence,
      turn: claim.turn,
      revisions: claim.revisions,
      contradictions: claim.contradictions,
      positions: [...claim.positionCounts.entries()]
        .map(([position, count]) => ({ position, count }))
        .sort((left, right) =>
          right.count === left.count
            ? left.position - right.position
            : right.count - left.count,
        ),
    }))
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (left.contradictions !== right.contradictions) {
        return left.contradictions - right.contradictions;
      }
      return left.form < right.form ? -1 : left.form > right.form ? 1 : 0;
    });

  return {
    claims: materialized,
    claimsByForm: new Map(materialized.map((claim) => [claim.form, claim])),
    observedMessageLength,
    ignoredEvents,
    eventsRead: ordered.length,
  };
}
