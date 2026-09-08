/**
 * LEDGER-INTEGRITY-DESIGN.md §6 / docs/evidence-bundle-format.md §3: the
 * intention → message → interpretation → turn graph. These are unit tests
 * over hand-built streams, because breaking a binding inside a real bundle
 * requires re-signing the whole stream and would hide which rule fired.
 */
import { describe, expect, it } from 'vitest';

import { verifyCrossBindings, type LoadedStream, type LoadedStreams } from '@ald/verifier';
import { hashCanonical, hashCarrierMark } from '@ald/hashing';
import { HASH_DOMAINS, STREAM_HASH_DOMAIN, type EventStream } from '@ald/types';

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
  intervention?: Record<string, unknown>[];
}): LoadedStreams {
  const map: LoadedStreams = new Map();
  map.set('baby-a-ledger', loaded('baby-a-ledger', overrides.babyA ?? []));
  map.set('baby-b-ledger', loaded('baby-b-ledger', overrides.babyB ?? []));
  map.set('channel', loaded('channel', overrides.channel ?? []));
  map.set('turns', loaded('turns', overrides.turns ?? []));
  map.set('intervention', loaded('intervention', overrides.intervention ?? []));
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

  it('rejects a turn record bound to another turn\'s channel event', () => {
    // Bundle format §3: the reference is to *the turn's* channel event, so
    // hash membership alone must not satisfy the binding.
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        channel: [{ ...acceptedChannelEvent(), turn: 1 }],
        turns: [{ sequence: 5, turn: 5, channelEventHash: CHANNEL_HASH }],
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      "references the channel event of turn 1, not this record's turn 5",
    );
  });

  it('accepts a turn record whose channel event carries the same turn', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        channel: [{ ...acceptedChannelEvent(), turn: 5 }],
        turns: [{ sequence: 5, turn: 5, channelEventHash: CHANNEL_HASH }],
      }),
    );

    expect(failures).toEqual([]);
  });

  it('accepts an applied probe whose descriptor and artifacts bind to the turn', () => {
    const probe = {
      probeId: 'probe:t5:substitution',
      kind: 'substitution',
      position: 0,
      substitute: 'S02',
      hypothesisRef: 'ledger:h1',
    };
    const before = { symbols: ['S01', 'S03'] };
    const after = { symbols: ['S02', 'S03'] };
    const probeHash = hashCanonical(HASH_DOMAINS.causalProbe, probe);
    const deliveredHash = hashCarrierMark('fixed-token', after);
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        channel: [
          {
            ...acceptedChannelEvent(),
            turn: 5,
            carrier: 'fixed-token',
            publicArtifactHash: deliveredHash,
            deliveryReceipt: {
              recipient: 'baby-b',
              deliveredArtifactHash: deliveredHash,
            },
          },
        ],
        turns: [
          {
            sequence: 5,
            turn: 5,
            phase: 'evaluating',
            channelEventHash: CHANNEL_HASH,
            probeHash,
            deliveredArtifactHash: deliveredHash,
          },
        ],
        intervention: [
          {
            sequence: 1,
            eventType: 'causal-probe',
            details: {
              turn: 5,
              application: {
                probe,
                probeHash,
                status: 'applied',
                artifactBefore: before,
                artifactAfter: after,
                artifactHashBefore: hashCarrierMark('fixed-token', before),
                artifactHashAfter: deliveredHash,
              },
            },
          },
        ],
      }),
    );

    expect(failures).toEqual([]);
  });

  it('rejects a turn probe hash with no matching applied probe event', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        channel: [{ ...acceptedChannelEvent(), turn: 5 }],
        turns: [
          {
            sequence: 5,
            turn: 5,
            phase: 'evaluating',
            channelEventHash: CHANNEL_HASH,
            probeHash: hash('eeee'),
          },
        ],
      }),
    );

    expect(failures.join(' | ')).toContain('has no applied causal-probe event');
  });

  it('rejects probe artifacts whose hashes agree but whose transformation is wrong', () => {
    const probe = {
      probeId: 'probe:t5:substitution',
      kind: 'substitution',
      position: 0,
      substitute: 'S02',
      hypothesisRef: 'ledger:h1',
    };
    const before = { symbols: ['S01', 'S03'] };
    const wrongAfter = { symbols: ['S04', 'S03'] };
    const probeHash = hashCanonical(HASH_DOMAINS.causalProbe, probe);
    const wrongHash = hashCarrierMark('fixed-token', wrongAfter);
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        channel: [
          {
            ...acceptedChannelEvent(),
            turn: 5,
            carrier: 'fixed-token',
            publicArtifactHash: wrongHash,
            deliveryReceipt: {
              recipient: 'baby-b',
              deliveredArtifactHash: wrongHash,
            },
          },
        ],
        turns: [
          {
            sequence: 5,
            turn: 5,
            phase: 'evaluating',
            channelEventHash: CHANNEL_HASH,
            probeHash,
            deliveredArtifactHash: wrongHash,
          },
        ],
        intervention: [
          {
            sequence: 1,
            eventType: 'causal-probe',
            details: {
              turn: 5,
              application: {
                probe,
                probeHash,
                status: 'applied',
                artifactBefore: before,
                artifactAfter: wrongAfter,
                artifactHashBefore: hashCarrierMark('fixed-token', before),
                artifactHashAfter: wrongHash,
              },
            },
          },
        ],
      }),
    );

    expect(failures.join(' | ')).toContain(
      'artifactAfter is not the recorded probe applied to artifactBefore',
    );
  });

  it('rejects an interpretation recorded outside the ledgerLagTurns window', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        babyB: [{ ...interpretation(), turn: 12 }],
        channel: [{ ...acceptedChannelEvent(), turn: 2 }],
      }),
      { ledgerLagTurns: 0 },
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      'interprets the channel event of turn 2 at turn 12',
    );
  });

  it('accepts a lagged interpretation permitted by ledgerLagTurns (SPEC §8.2)', () => {
    const failures = verifyCrossBindings(
      streams({
        babyA: [intention()],
        babyB: [{ ...interpretation(), turn: 4 }],
        channel: [{ ...acceptedChannelEvent(), turn: 2 }],
      }),
      { ledgerLagTurns: 2 },
    );

    expect(failures).toEqual([]);
  });
});
