import {
  LedgerEventDraftSchema,
  type LedgerEventDraft,
} from '@ald/types';

export const LEDGER_EVENT_TYPES = [
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

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

const requiredContentFields = {
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
} as const satisfies Record<LedgerEventType, readonly string[]>;

export function isLedgerEventType(value: string): value is LedgerEventType {
  return (LEDGER_EVENT_TYPES as readonly string[]).includes(value);
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

export function validateLedgerEventDraft(value: unknown): LedgerEventDraft & {
  eventType: LedgerEventType;
} {
  const draft = LedgerEventDraftSchema.parse(value);
  if (!isLedgerEventType(draft.eventType)) {
    throw new Error(`Unknown ledger event type: ${draft.eventType}`);
  }

  const missingFields = requiredContentFields[draft.eventType].filter(
    (field) => !hasRequiredValue(draft.content, field),
  );
  if (missingFields.length > 0) {
    throw new Error(
      `${draft.eventType} requires content fields: ${missingFields.join(', ')}`,
    );
  }

  return {
    ...draft,
    eventType: draft.eventType,
  };
}
