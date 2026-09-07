import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LearnerTrackIdSchema } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_FACTORIES,
  UNIMPLEMENTED_TRACK_BACKLOG_ITEMS,
  createLearnerAdapterFactory,
} from '../src/index.js';
import {
  LEARNER_LEDGER_EVENT_TYPES,
  REQUIRED_CONTENT_FIELDS,
  isLearnerLedgerEventType,
  validateLearnerDraft,
} from '../src/drafts.js';
import { NotImplementedTrackError } from '../src/errors.js';

const LEDGER_DESIGN = fileURLToPath(
  new URL('../../../LEDGER-INTEGRITY-DESIGN.md', import.meta.url),
);

/** The LEDGER-INTEGRITY-DESIGN.md §5 event-type list, read from the document. */
function documentedEventTypes(): string[] {
  const source = readFileSync(LEDGER_DESIGN, 'utf8');
  const section = source.slice(
    source.indexOf('## 5. Event Types'),
    source.indexOf('## 6. Binding Ledgers'),
  );
  return [...section.matchAll(/^- `([a-z._]+)`[;.]$/gmu)].map(
    (match) => match[1] as string,
  );
}

describe('ADAPTER_FACTORIES', () => {
  it('addresses all five SPEC §6.1 track IDs behind one interface', () => {
    expect(Object.keys(ADAPTER_FACTORIES).sort()).toEqual(
      [...LearnerTrackIdSchema.options].sort(),
    );
  });

  it('builds the two implemented reference tracks', () => {
    expect(ADAPTER_FACTORIES['no-learning']().track).toBe('no-learning');
    expect(ADAPTER_FACTORIES['scratch-rl']().track).toBe('scratch-rl');
    expect(createLearnerAdapterFactory('no-learning').create().track).toBe(
      'no-learning',
    );
    expect(
      createLearnerAdapterFactory('scratch-rl', { temperature: 0.5 }).create()
        .track,
    ).toBe('scratch-rl');
  });

  it('throws with the owning BACKLOG item for every unimplemented track', () => {
    for (const [track, backlogItem] of Object.entries(
      UNIMPLEMENTED_TRACK_BACKLOG_ITEMS,
    )) {
      let thrown: unknown;
      try {
        createLearnerAdapterFactory(
          track as keyof typeof UNIMPLEMENTED_TRACK_BACKLOG_ITEMS,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NotImplementedTrackError);
      expect((thrown as NotImplementedTrackError).track).toBe(track);
      expect((thrown as NotImplementedTrackError).backlogItem).toBe(backlogItem);
      expect((thrown as Error).message).toContain(backlogItem);
    }
  });

  it('never silently substitutes another track', () => {
    expect(Object.keys(UNIMPLEMENTED_TRACK_BACKLOG_ITEMS).sort()).toEqual([
      'frozen-llm',
      'hybrid',
      'self-supervised',
    ]);
  });
});

describe('ledger event-type registry (LEDGER §5)', () => {
  it('matches the event types the design document lists', () => {
    expect([...LEARNER_LEDGER_EVENT_TYPES]).toEqual(documentedEventTypes());
  });

  it('declares required content fields for every event type', () => {
    for (const eventType of LEARNER_LEDGER_EVENT_TYPES) {
      expect(REQUIRED_CONTENT_FIELDS[eventType].length).toBeGreaterThan(0);
      expect(isLearnerLedgerEventType(eventType)).toBe(true);
    }
    expect(isLearnerLedgerEventType('term.invented')).toBe(false);
  });
});

describe('validateLearnerDraft', () => {
  const base = {
    contentSchema: 'agent-native-ledger' as const,
    subjectId: 'symbol:S01',
    blindingNonce: '0123456789abcdef01234567',
    evidenceRefs: [],
  };

  it('accepts a well-formed draft and defaults evidenceRefs', () => {
    const draft = validateLearnerDraft({
      eventType: 'intention.recorded',
      contentSchema: 'agent-native-ledger',
      subjectId: 'symbol:S01',
      content: { artifactRef: 'proposal:x' },
      blindingNonce: '0123456789abcdef01234567',
    });
    expect(draft.evidenceRefs).toEqual([]);
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      validateLearnerDraft({
        ...base,
        eventType: 'term.invented',
        content: { termRef: 'symbol:S01' },
      }),
    ).toThrow(/Unknown ledger event type/u);
  });

  it('rejects every missing required content field', () => {
    for (const [eventType, fields] of Object.entries(REQUIRED_CONTENT_FIELDS)) {
      expect(() =>
        validateLearnerDraft({ ...base, eventType, content: {} }),
        eventType,
      ).toThrow(new RegExp(fields.join(', '), 'u'));
    }
  });

  it('rejects an empty string in a required field', () => {
    expect(() =>
      validateLearnerDraft({
        ...base,
        eventType: 'term.first_emitted',
        content: { termRef: '' },
      }),
    ).toThrow(/termRef/u);
  });

  it('rejects a missing blinding nonce', () => {
    expect(() =>
      validateLearnerDraft({
        eventType: 'term.first_emitted',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { termRef: 'symbol:S01' },
      }),
    ).toThrow();
  });
});
