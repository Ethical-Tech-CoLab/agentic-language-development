import { describe, expect, it } from 'vitest';

import {
  LEDGER_EVENT_TYPES,
  validateLedgerEventDraft,
} from '../src/index.js';

const requiredContent = {
  'term.first_emitted': { termRef: 'term:1' },
  'term.first_received': { termRef: 'term:1' },
  'hypothesis.created': { hypothesisRef: 'hypothesis:1' },
  'hypothesis.revised': {
    hypothesisRef: 'hypothesis:2',
    priorHypothesisRef: 'hypothesis:1',
  },
  'hypothesis.contradicted': {
    hypothesisRef: 'hypothesis:1',
    evidenceRef: 'outcome:1',
  },
  'hypothesis.abandoned': {
    hypothesisRef: 'hypothesis:1',
    evidenceRef: 'outcome:1',
  },
  'construction.created': { constructionRef: 'construction:1' },
  'construction.revised': {
    constructionRef: 'construction:2',
    priorConstructionRef: 'construction:1',
  },
  'intention.recorded': { artifactRef: 'channel:1' },
  'interpretation.recorded': { artifactRef: 'channel:1' },
  'affect.recorded': { displayId: 'A1' },
  'policy.checkpointed': { policyCheckpointRef: 'policy:1' },
  'run.sealed': { checkpointRef: 'checkpoint:1' },
} as const;

function draft(eventType: string, content: Record<string, unknown>) {
  return {
    eventType,
    contentSchema: 'agent-native-ledger',
    subjectId: 'subject:1',
    content,
    blindingNonce: 'nonce:1',
    evidenceRefs: [],
  };
}

describe('ledger event type registry', () => {
  it.each(LEDGER_EVENT_TYPES)('validates %s', (eventType) => {
    expect(
      validateLedgerEventDraft(draft(eventType, requiredContent[eventType])),
    ).toMatchObject({ eventType });
  });

  it('rejects unknown event types before serialization', () => {
    expect(() =>
      validateLedgerEventDraft(draft('unknown.event', {})),
    ).toThrow('Unknown ledger event type: unknown.event');
  });

  it('rejects event content missing required fields', () => {
    expect(() =>
      validateLedgerEventDraft(draft('hypothesis.revised', {
        hypothesisRef: 'hypothesis:2',
      })),
    ).toThrow(
      'hypothesis.revised requires content fields: priorHypothesisRef',
    );
  });
});
