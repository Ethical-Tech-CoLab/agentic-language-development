/**
 * Regression tests for the canonical-JSON input contract
 * (docs/evidence-bundle-format.md §1 "every *.jsonl line is canonical JSON",
 * §3 entry hashing; LEDGER §4 RFC 8785 canonicalization).
 *
 * `canonicalize` v4 neither drops nor reports non-JSON values: a `Map`, `Set`,
 * `Buffer`, or class instance serializes to `{}` (silently hashing an empty
 * object), and a function- or symbol-valued property is interpolated as the
 * bare token `undefined` (an evidence line no verifier can parse). Both must
 * be refused before a hash exists.
 */
import { describe, expect, it } from 'vitest';

import { HASH_DOMAINS } from '@ald/types';

import {
  canonicalJson,
  computeEntryHash,
  hashCanonical,
  parseCanonicalJson,
} from '../src/index.js';

const REJECTED = /cannot be represented as canonical JSON/u;

describe('canonicalJson input validation', () => {
  it('still serializes every JSON-native value', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1.5)).toBe('-1.5');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson([1, [2, { a: null }], 'three'])).toBe(
      '[1,[2,{"a":null}],"three"]',
    );
    expect(canonicalJson(Object.create(null) as Record<string, unknown>)).toBe(
      '{}',
    );
    expect(canonicalJson(Object.freeze({ a: 1 }))).toBe('{"a":1}');
  });

  it('rejects undefined, bigint, and non-finite numbers', () => {
    expect(() => canonicalJson(undefined)).toThrow(REJECTED);
    expect(() => canonicalJson(10n)).toThrow(REJECTED);
    expect(() => canonicalJson({ a: 1n })).toThrow(REJECTED);
    expect(() => canonicalJson(Number.NaN)).toThrow(REJECTED);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(
      REJECTED,
    );
    expect(() => canonicalJson([Number.NEGATIVE_INFINITY])).toThrow(REJECTED);
  });

  it('rejects functions and symbols instead of emitting invalid JSON', () => {
    // Before the fix these returned '{"redact":undefined,"version":1}' and
    // '[1,]' — strings JSON.parse cannot read.
    const withMethod: Record<string, unknown> = {
      version: 1,
      redact: () => undefined,
    };
    expect(() => canonicalJson(withMethod)).toThrow(REJECTED);
    expect(() => canonicalJson([1, () => undefined])).toThrow(REJECTED);
    expect(() => canonicalJson({ a: Symbol('x'), b: 1 })).toThrow(REJECTED);
    expect(() => canonicalJson([Symbol('x')])).toThrow(REJECTED);
    expect(() => canonicalJson(() => undefined)).toThrow(REJECTED);
  });

  it('rejects containers and class instances that canonicalize to {}', () => {
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(REJECTED);
    expect(() => canonicalJson(new Set([1, 2]))).toThrow(REJECTED);
    expect(() => canonicalJson(new Date(0))).toThrow(REJECTED);
    expect(() => canonicalJson(Buffer.from([1, 2, 3]))).toThrow(REJECTED);
    expect(() => canonicalJson(new Uint8Array([1, 2]))).toThrow(REJECTED);
    expect(() => canonicalJson(new Error('boom'))).toThrow(REJECTED);

    class Policy {
      constructor(public readonly theta: number) {}
    }
    expect(() => canonicalJson(new Policy(1))).toThrow(REJECTED);
    expect(() => canonicalJson({ nested: { hypothesis: new Map() } })).toThrow(
      REJECTED,
    );
    expect(() => canonicalJson([{ seeds: new Set([1]) }])).toThrow(REJECTED);

    class Symbols extends Array<string> {}
    expect(() => canonicalJson(Symbols.from(['S01']))).toThrow(REJECTED);
  });

  it('names the offending path in the rejection', () => {
    expect(() => canonicalJson({ content: { hypothesis: new Map() } })).toThrow(
      /content\.hypothesis/u,
    );
    expect(() => canonicalJson({ rows: [{ fn: () => 1 }] })).toThrow(
      /rows\[0\]\.fn/u,
    );
    expect(() => canonicalJson(undefined)).toThrow(/<root>/u);
  });

  it('rejects circular references', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(REJECTED);

    // Repeated (non-circular) references are still fine.
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe(
      '{"x":{"a":1},"y":{"a":1}}',
    );
  });

  it('pins JSON semantics for undefined members', () => {
    // An undefined-valued property is omitted (JCS/JSON.stringify semantics)…
    const omitted: Record<string, unknown> = { a: 1, b: undefined };
    expect(canonicalJson(omitted)).toBe('{"a":1}');
    expect(parseCanonicalJson(canonicalJson(omitted))).toEqual({ a: 1 });
    // …and an explicitly undefined array element becomes null.
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('rejects sparse arrays, which canonicalize to invalid JSON', () => {
    // `canonicalize` v4 emits '[1,,2]' where JSON.stringify emits
    // '[1,null,2]', so a hole would hash an unparseable evidence line.
    const holed: unknown[] = [1, , 2];
    expect(() => canonicalJson(holed)).toThrow(REJECTED);
    expect(() => canonicalJson({ rows: [, 1] })).toThrow(/rows\[0\]/u);
    const trailing = [1, 2];
    trailing.length = 4;
    expect(() => canonicalJson(trailing)).toThrow(REJECTED);
  });

  it('only ever returns parseable JSON', () => {
    const value = {
      runId: 'r',
      rows: [1, undefined, { a: null, b: [true, 'x'] }],
      omitted: undefined,
    };
    const serialized = canonicalJson(value);
    expect(() => JSON.parse(serialized) as unknown).not.toThrow();
    expect(canonicalJson(JSON.parse(serialized) as unknown)).toBe(serialized);
  });

  it('never produces a hash for a value it cannot represent', () => {
    // Mode (a): a nested Map used to hash identically to an empty object.
    expect(() =>
      hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        new Map([['thetaSender', [[1, 2]]]]),
      ),
    ).toThrow(REJECTED);
    expect(() =>
      computeEntryHash('baby-a-ledger', {
        runId: 'r',
        babyId: 'A',
        sequence: 1,
        content: { hypothesis: new Map([['S01', 'means-circle']]) },
      }),
    ).toThrow(REJECTED);
    // Mode (b): an own function-valued property used to hash a non-JSON line.
    expect(() =>
      computeEntryHash('baby-a-ledger', {
        runId: 'r',
        babyId: 'A',
        sequence: 1,
        content: { artifactRef: 'a', redact: () => undefined },
      }),
    ).toThrow(REJECTED);
  });

  it('leaves parseCanonicalJson behaviour unchanged', () => {
    expect(parseCanonicalJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseCanonicalJson('{ "a": 1 }')).toThrow(/canonical/u);
  });
});
