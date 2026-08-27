import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeJson,
  deserializeUnsignedLedgerEvent,
  serializeUnsignedLedgerEvent,
} from '../src/index.js';
import type { UnsignedLedgerEvent } from '@ald/types';

const event: UnsignedLedgerEvent = {
  version: 1,
  runId: 'run-canonical',
  babyId: 'A',
  sequence: 1,
  turn: 0,
  eventType: 'term.first_emitted',
  contentSchema: 'agent-native-ledger',
  subjectId: 'term:1',
  content: {
    confidence: 0.5,
    evidenceRefs: ['observation:1'],
    termRef: 'mark:1',
  },
  blindingNonce: 'nonce:1',
  previousEntryHash: `sha256:${'0'.repeat(64)}`,
  recordedAt: '2026-08-27T12:00:00.000Z',
  writerKeyId: 'baby-a-ledger-writer-v1',
};

describe('RFC 8785 canonical serialization', () => {
  it('is independent of object insertion order', () => {
    const first = canonicalizeJson({
      z: 3,
      a: { y: 2, x: 1 },
    });
    const second = canonicalizeJson({
      a: { x: 1, y: 2 },
      z: 3,
    });

    expect(first).toBe(second);
    expect(first).toBe('{"a":{"x":1,"y":2},"z":3}');
  });

  it('produces the same bytes in separate processes', () => {
    const moduleUrl = new URL('../src/json-canonical.ts', import.meta.url).href;
    const script = `
      import { canonicalizeJson } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(canonicalizeJson(${JSON.stringify(event)}));
    `;
    const run = () =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { encoding: 'utf8' },
      );

    expect(run()).toBe(run());
    expect(run()).toBe(canonicalizeJson(event));
  });

  it('round-trips an unsigned ledger event', () => {
    expect(
      deserializeUnsignedLedgerEvent(serializeUnsignedLedgerEvent(event)),
    ).toEqual(event);
  });
});
