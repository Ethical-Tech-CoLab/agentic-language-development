import { describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  LedgerEventSchema,
  SIGNER_KEY_IDS,
  type ChainHead,
} from '@ald/types';

import {
  InMemorySignerRegistry,
  buildSignedEvent,
  canonicalJson,
  computeEntryHash,
  formatChainViolation,
  isSignedStream,
  nextSequence,
  parseJsonlEvents,
  previousHashFor,
  validateChain,
  type ChainValidationResult,
} from '../src/index.js';

const RUN_ID = 'run-2026-08-24-001';
const STREAM = 'baby-a-ledger';

interface ChainOptions {
  count?: number;
  runId?: string;
  /** Sequence whose `previousEntryHash` is replaced by the genesis hash. */
  brokenLinkAt?: number;
}

/**
 * Build a real chain of signed Baby A ledger events: sequences from 1, the
 * first link genesis, every later link the predecessor's entry hash
 * (LEDGER §4). `brokenLinkAt` corrupts exactly one link while keeping the
 * rest of the chain internally consistent.
 */
async function buildChain(
  registry: InMemorySignerRegistry,
  options: ChainOptions = {},
): Promise<Record<string, unknown>[]> {
  const { count = 10, runId = RUN_ID, brokenLinkAt } = options;
  const signer = registry.signer('baby-a-ledger');
  const events: Record<string, unknown>[] = [];
  let previousEntryHash = GENESIS_HASH;
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const event = await buildSignedEvent(
      STREAM,
      {
        version: 1,
        runId,
        babyId: 'A',
        sequence,
        turn: sequence,
        eventType: 'hypothesis.created',
        contentSchema: 'agent-native-ledger',
        subjectId: `sha256:${String(sequence).padStart(64, '0')}`,
        content: { hypothesisRef: `h-${sequence}`, confidence: 0.5 },
        blindingNonce: `base64:nonce-${sequence}`,
        previousEntryHash:
          sequence === brokenLinkAt ? GENESIS_HASH : previousEntryHash,
        recordedAt: `2026-08-24T21:${String(sequence).padStart(2, '0')}:00.000Z`,
        writerKeyId: SIGNER_KEY_IDS['baby-a-ledger'],
      },
      signer,
    );
    events.push(event);
    previousEntryHash = event.entryHash;
  }
  return events;
}

function babyAKey(registry: InMemorySignerRegistry): string {
  return registry.signer('baby-a-ledger').publicKey;
}

function codes(result: ChainValidationResult): string[] {
  return result.violations.map((violation) => violation.code);
}

function clone(event: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(event);
}

const registry = InMemorySignerRegistry.generate(RUN_ID);
const validated = {
  runId: RUN_ID,
  babyId: 'A' as const,
  requireSignatures: true,
  publicKey: babyAKey(registry),
};

describe('validateChain — accepting an unchanged chain (LEDGER §17)', () => {
  it('accepts ten signed events and reports the head', async () => {
    const events = await buildChain(registry);
    const result = validateChain(STREAM, events, validated);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.size).toBe(10);
    expect(result.lastEntryHash).toBe(events[9]?.['entryHash']);
  });

  it('produces events that satisfy the shared LedgerEvent schema', async () => {
    const events = await buildChain(registry, { count: 3 });
    for (const event of events) {
      expect(() => LedgerEventSchema.parse(event)).not.toThrow();
    }
  });

  it('accepts an empty chain with the genesis head', () => {
    const result = validateChain(STREAM, [], validated);
    expect(result.ok).toBe(true);
    expect(result.size).toBe(0);
    expect(result.lastEntryHash).toBe(GENESIS_HASH);
  });

  it('accepts chains of every small size with and without options', async () => {
    for (let count = 1; count <= 8; count += 1) {
      const events = await buildChain(registry, { count });
      expect(validateChain(STREAM, events, validated).ok).toBe(true);
      expect(validateChain(STREAM, events).ok).toBe(true);
    }
  });
});

describe('validateChain — mutation matrix (LEDGER §17)', () => {
  it('detects modified event content as an entry-hash mismatch', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    (mutated[4] as { content: Record<string, unknown> }).content = {
      hypothesisRef: 'h-5',
      confidence: 0.99,
    };
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toEqual(['entry-hash-mismatch']);
    expect(result.violations[0]?.sequence).toBe(5);
    expect(result.ok).toBe(false);
  });

  it('detects a modified content field at every position', async () => {
    const events = await buildChain(registry, { count: 6 });
    for (let index = 0; index < events.length; index += 1) {
      const mutated = events.map(clone);
      (mutated[index] as { turn: number }).turn = 999;
      const result = validateChain(STREAM, mutated, validated);
      expect(codes(result)).toEqual(['entry-hash-mismatch']);
      expect(result.violations[0]?.sequence).toBe(index + 1);
    }
  });

  it('detects a changed sequence number', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    (mutated[9] as { sequence: number }).sequence = 99;
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toEqual(['sequence-gap', 'entry-hash-mismatch']);
    expect(result.violations[0]?.message).toContain('expected sequence 10');
  });

  it('detects a chain that does not start at sequence 1', async () => {
    const events = await buildChain(registry);
    const result = validateChain(STREAM, events.slice(1), validated);
    expect(codes(result)).toContain('sequence-start');
    expect(result.violations[0]?.sequence).toBe(2);
  });

  it('detects a deleted middle entry', async () => {
    const events = await buildChain(registry);
    const mutated = [...events.slice(0, 4), ...events.slice(5)];
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toContain('sequence-gap');
    expect(codes(result)).toContain('previous-hash-mismatch');
    expect(
      result.violations.filter((violation) => violation.code === 'sequence-gap'),
    ).toHaveLength(1);
    expect(result.violations[0]?.sequence).toBe(6);
  });

  it('detects an inserted (replayed) entry', async () => {
    const events = await buildChain(registry);
    const mutated = [...events.slice(0, 5), clone(events[2] as Record<string, unknown>), ...events.slice(5)];
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toContain('duplicate-sequence');
    expect(codes(result)).toContain('previous-hash-mismatch');
  });

  it('detects reordered entries', async () => {
    const events = await buildChain(registry);
    const mutated = [...events];
    const fourth = mutated[3] as Record<string, unknown>;
    mutated[3] = mutated[4] as Record<string, unknown>;
    mutated[4] = fourth;
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toContain('sequence-gap');
    expect(codes(result)).toContain('previous-hash-mismatch');
  });

  it('detects an incorrect previous-entry hash even when re-signed', async () => {
    const events = await buildChain(registry, { brokenLinkAt: 7 });
    const result = validateChain(STREAM, events, validated);
    expect(codes(result)).toEqual(['previous-hash-mismatch']);
    expect(result.violations[0]?.sequence).toBe(7);
  });

  it('detects a writer signature made by another domain key', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    const target = mutated[3] as Record<string, unknown>;
    target['writerSignature'] = await registry
      .signer('baby-b-ledger')
      .sign(target['entryHash'] as string);
    const result = validateChain(STREAM, mutated, validated);
    expect(codes(result)).toEqual(['signature-invalid']);
    expect(result.violations[0]?.sequence).toBe(4);
  });

  it('detects a corrupted signature', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    (mutated[0] as Record<string, unknown>)['writerSignature'] =
      'ed25519:not-a-signature';
    expect(codes(validateChain(STREAM, mutated, validated))).toEqual([
      'signature-invalid',
    ]);
  });

  it('rejects the whole chain under the wrong public key', async () => {
    const events = await buildChain(registry);
    const result = validateChain(STREAM, events, {
      ...validated,
      publicKey: registry.signer('channel').publicKey,
    });
    expect(codes(result)).toEqual(Array(10).fill('signature-invalid'));
  });

  it('reports a missing signature only when signatures are required', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    delete (mutated[2] as Record<string, unknown>)['writerSignature'];
    expect(codes(validateChain(STREAM, mutated, validated))).toEqual([
      'signature-missing',
    ]);
    expect(
      validateChain(STREAM, mutated, { ...validated, requireSignatures: false })
        .ok,
    ).toBe(true);
  });

  it('detects a run-id mismatch against the expected run', async () => {
    const events = await buildChain(registry);
    const result = validateChain(STREAM, events, {
      ...validated,
      runId: 'run-other-001',
    });
    expect(codes(result)).toEqual(Array(10).fill('run-id-mismatch'));

    const mutated = events.map(clone);
    (mutated[1] as Record<string, unknown>)['runId'] = 'run-other-001';
    expect(codes(validateChain(STREAM, mutated, validated))).toEqual([
      'run-id-mismatch',
      'entry-hash-mismatch',
    ]);
  });

  it('detects a baby-id mismatch against the expected ledger owner', async () => {
    const events = await buildChain(registry, { count: 2 });
    const result = validateChain(STREAM, events, {
      ...validated,
      babyId: 'B',
    });
    expect(codes(result)).toEqual(['baby-id-mismatch', 'baby-id-mismatch']);
  });

  it('collects every violation instead of stopping at the first', async () => {
    const events = await buildChain(registry);
    const mutated = events.map(clone);
    (mutated[1] as { turn: number }).turn = 42;
    (mutated[6] as { turn: number }).turn = 43;
    const result = validateChain(STREAM, mutated, validated);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((violation) => violation.sequence)).toEqual([
      2, 7,
    ]);
  });
});

describe('validateChain — malformed input is reported, never thrown', () => {
  it('reports non-objects and unusable chain fields', () => {
    const events = [
      null,
      { sequence: 1 },
      { sequence: 'two', entryHash: GENESIS_HASH, previousEntryHash: GENESIS_HASH },
    ] as unknown as Record<string, unknown>[];
    let result: ChainValidationResult | undefined;
    expect(() => {
      result = validateChain(STREAM, events, validated);
    }).not.toThrow();
    expect(codes(result as ChainValidationResult)).toContain('malformed-event');
    expect((result as ChainValidationResult).ok).toBe(false);
  });

  it('reports values that cannot be canonicalized', () => {
    const cyclic: Record<string, unknown> = {
      sequence: 1,
      entryHash: GENESIS_HASH,
      previousEntryHash: GENESIS_HASH,
    };
    cyclic['self'] = cyclic;
    const result = validateChain(STREAM, [cyclic]);
    expect(codes(result)).toContain('malformed-event');
  });

  it('renders violations as single lines for string-only report fields', async () => {
    const events = await buildChain(registry, { brokenLinkAt: 2 });
    const [violation] = validateChain(STREAM, events, validated).violations;
    const line = formatChainViolation(STREAM, violation as never);
    expect(line.startsWith('baby-a-ledger#2 previous-hash-mismatch:')).toBe(
      true,
    );
    expect(line.includes('\n')).toBe(false);
  });
});

describe('unsigned intervention chain', () => {
  it('validates without signatures even when signatures are required', () => {
    expect(isSignedStream('intervention')).toBe(false);
    expect(isSignedStream(STREAM)).toBe(true);

    const events: Record<string, unknown>[] = [];
    let previousEntryHash = GENESIS_HASH;
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const unsigned = {
        version: 1,
        runId: RUN_ID,
        sequence,
        eventType: 'run.paused',
        actorId: 'researcher-1',
        reasonCode: 'manual-pause',
        previousEntryHash,
        recordedAt: `2026-08-24T22:0${sequence}:00.000Z`,
      };
      const event = {
        ...unsigned,
        entryHash: computeEntryHash('intervention', unsigned),
      };
      events.push(event);
      previousEntryHash = event.entryHash;
    }
    const result = validateChain('intervention', events, {
      runId: RUN_ID,
      requireSignatures: true,
    });
    expect(result.ok).toBe(true);
    expect(result.lastEntryHash).toBe(events[3]?.['entryHash']);

    const mutated = events.map(clone);
    (mutated[1] as { reasonCode: string }).reasonCode = 'other';
    expect(codes(validateChain('intervention', mutated))).toEqual([
      'entry-hash-mismatch',
    ]);
  });
});

describe('link helpers', () => {
  it('derives the next sequence and previous hash from a chain head', () => {
    const empty: ChainHead = {
      stream: STREAM,
      size: 0,
      lastEntryHash: GENESIS_HASH,
    };
    expect(nextSequence(empty)).toBe(1);
    expect(previousHashFor(empty)).toBe(GENESIS_HASH);

    const head: ChainHead = {
      stream: STREAM,
      size: 10,
      lastEntryHash: `sha256:${'a'.repeat(64)}`,
    };
    expect(nextSequence(head)).toBe(11);
    expect(previousHashFor(head)).toBe(head.lastEntryHash);
  });

  it('signs with the stream domain and refuses cross-domain signers', async () => {
    const unsigned = { version: 1, runId: RUN_ID, sequence: 1, previousChannelHash: GENESIS_HASH };
    const signed = await buildSignedEvent(
      'channel',
      unsigned,
      registry.signer('channel'),
    );
    expect(signed.entryHash).toBe(computeEntryHash('channel', unsigned));
    expect(validateChain('channel', [signed], {
      requireSignatures: true,
      publicKey: registry.signer('channel').publicKey,
    }).ok).toBe(true);

    await expect(
      buildSignedEvent('channel', unsigned, registry.signer('baby-a-ledger')),
    ).rejects.toThrow(/must be signed by the channel domain/u);
    await expect(
      buildSignedEvent('turns', unsigned, registry.signer('audit')),
    ).rejects.toThrow(/witness/u);
  });

  it('overwrites any pre-existing signature fields', async () => {
    const signed = await buildSignedEvent(
      'channel',
      {
        sequence: 1,
        previousChannelHash: GENESIS_HASH,
        entryHash: `sha256:${'b'.repeat(64)}`,
        writerSignature: 'ed25519:stale',
      },
      registry.signer('channel'),
    );
    expect(signed.entryHash).not.toBe(`sha256:${'b'.repeat(64)}`);
    expect(signed.writerSignature).not.toBe('ed25519:stale');
    expect(validateChain('channel', [signed], {
      requireSignatures: true,
      publicKey: registry.signer('channel').publicKey,
    }).ok).toBe(true);
  });
});

describe('parseJsonlEvents', () => {
  it('round-trips a canonical JSONL export into a valid chain', async () => {
    const events = await buildChain(registry, { count: 5 });
    const text = `${events.map((event) => canonicalJson(event)).join('\n')}\n`;
    const parsed = parseJsonlEvents(text);
    expect(parsed).toEqual(events);
    expect(validateChain(STREAM, parsed, validated).ok).toBe(true);
  });

  it('accepts a file with no trailing newline', () => {
    expect(parseJsonlEvents('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonlEvents('')).toEqual([]);
    // Only a *trailing* newline is ignored; a file holding a blank line is not
    // a valid export.
    expect(() => parseJsonlEvents('\n')).toThrow(/line 1/u);
  });

  it('rejects non-canonical lines unless canonicalization is waived', () => {
    expect(() => parseJsonlEvents('{ "a": 1 }\n')).toThrow(/line 1/u);
    expect(() => parseJsonlEvents('{"b":1,"a":2}\n')).toThrow(/canonical/u);
    expect(
      parseJsonlEvents('{ "a": 1 }\n', { requireCanonical: false }),
    ).toEqual([{ a: 1 }]);
  });

  it('rejects blank interior lines and non-object lines', () => {
    expect(() => parseJsonlEvents('{"a":1}\n\n{"b":2}\n')).toThrow(/line 2/u);
    expect(() => parseJsonlEvents('[1,2]\n')).toThrow(/not a JSON object/u);
    expect(() => parseJsonlEvents('7\n')).toThrow(/not a JSON object/u);
  });
});
