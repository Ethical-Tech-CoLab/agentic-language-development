/**
 * LEDGER-INTEGRITY-DESIGN.md §6 / docs/evidence-bundle-format.md §3: the
 * intention → message → interpretation → turn graph. These are unit tests
 * over hand-built streams, because breaking a binding inside a real bundle
 * requires re-signing the whole stream and would hide which rule fired.
 */
import { describe, expect, it } from 'vitest';

import { verifyCrossBindings, type LoadedStream, type LoadedStreams } from '@ald/verifier';
import { STREAM_HASH_DOMAIN, type EventStream } from '@ald/types';

function hash(seed: string): string {
  return `sha256:${seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/gu, '1')}`;
}

function loaded(
  stream: EventStream,
  events: Record<string, unknown>[],
): LoadedStream {
  return {
    stream,
    declaration: {
      stream,
      file: `${stream}.jsonl`,
      hashDomain: STREAM_HASH_DOMAIN[stream],
    },
    events,
    entries: [],
    bySequence: new Map(),
    size: events.length,
  };
}

const INTENTION_HASH = hash('aaaa');
const CHANNEL_HASH = hash('bbbb');
const ARTIFACT_HASH = hash('cccc');

function streams(overrides: {
  babyA?: Record<string, unknown>[];
  babyB?: Record<string, unknown>[];
  channel?: Record<string, unknown>[];
  turns?: Record<string, unknown>[];
}): LoadedStreams {
  const map: LoadedStreams = new Map();
  map.set('baby-a-ledger', loaded('baby-a-ledger', overrides.babyA ?? []));
  map.set('baby-b-ledger', loaded('baby-b-ledger', overrides.babyB ?? []));
  map.set('channel', loaded('channel', overrides.channel ?? []));
  map.set('turns', loaded('turns', overrides.turns ?? []));
  return map;
}

function intention(): Record<string, unknown> {
  return {
    sequence: 1,
    babyId: 'A',
    eventType: 'intention.recorded',
    entryHash: INTENTION_HASH,
  };
}

function acceptedChannelEvent(): Record<string, unknown> {
  return {
    sequence: 1,
    entryHash: CHANNEL_HASH,
    logicalSender: 'baby-a',
    origin: 'baby',
    communicationCondition: 'normal',
    gatewayValidationResult: 'accepted',
    senderLedgerSequence: 1,
    senderEntryHash: INTENTION_HASH,
    publicArtifactHash: ARTIFACT_HASH,
    deliveryReceipt: {
      recipient: 'baby-b',
      deliveredArtifactHash: ARTIFACT_HASH,
      deliveredAt: '2026-08-24T21:00:00.000Z',
    },
  };
}

function interpretation(): Record<string, unknown> {
  return {
    sequence: 1,
    babyId: 'B',
    eventType: 'interpretation.recorded',
    entryHash: hash('dddd'),
    channelEventHash: CHANNEL_HASH,
  };
}

describe('verifyCrossBindings', () => {
  it('accepts a complete intention → message → interpretation → turn graph', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        babyB: [interpretation()],
        channel: [acceptedChannelEvent()],
        turns: [{ sequence: 1, channelEventHash: CHANNEL_HASH }],
      }),
    );

    expect(failures).toEqual([]);
  });

  it('rejects a channel event whose sender ledger entry is missing', () => {
    const failures = verifyCrossBindings(
      streams({ babyA: [], channel: [acceptedChannelEvent()] }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('baby-a-ledger#1, which is not in the bundle');
  });

  it('rejects a channel event referencing a non-intention ledger entry', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [{ ...intention(), eventType: 'hypothesis.created' }],
        channel: [acceptedChannelEvent()],
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('not intention.recorded');
  });

  it('rejects a sender entry hash that does not match the ledger event', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [{ ...intention(), entryHash: hash('eeee') }],
        channel: [acceptedChannelEvent()],
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('senderEntryHash does not match');
  });

  it('rejects a delivery receipt that does not commit the public artifact', () => {
    const event = acceptedChannelEvent();
    event['deliveryReceipt'] = {
      recipient: 'baby-b',
      deliveredArtifactHash: hash('ffff'),
      deliveredAt: '2026-08-24T21:00:00.000Z',
    };

    const failures = verifyCrossBindings(
      streams({ babyA: [intention()], channel: [event] }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('deliveredArtifactHash does not equal publicArtifactHash');
  });

  it('rejects an interpretation of a message delivered to the other Baby', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention(), interpretation()],
        channel: [acceptedChannelEvent()],
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('delivered to baby-b, not baby-a');
  });

  it('rejects a rejected channel event that carries delivery fields', () => {
    const failures = verifyCrossBindings(
      streams({
        channel: [
          {
            sequence: 1,
            entryHash: CHANNEL_HASH,
            logicalSender: 'baby-a',
            origin: 'baby',
            gatewayValidationResult: 'rejected',
            publicArtifactHash: ARTIFACT_HASH,
            senderEntryHash: INTENTION_HASH,
            senderLedgerSequence: 1,
            deliveryReceipt: {
              recipient: 'baby-b',
              deliveredArtifactHash: ARTIFACT_HASH,
              deliveredAt: '2026-08-24T21:00:00.000Z',
            },
          },
        ],
      }),
    );

    expect(failures).toHaveLength(3);
    expect(failures.join(' | ')).toContain('rejected event carries no reasonCode');
    expect(failures.join(' | ')).toContain('rejected event carries a deliveryReceipt');
    expect(failures.join(' | ')).toContain('rejected event carries sender ledger bindings');
  });

  it('rejects a turn record referencing an unknown channel event', () => {
    const failures = verifyCrossBindings(
      streams({ turns: [{ sequence: 1, channelEventHash: hash('9999') }] }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('is not a channel event in this bundle');
  });
});
