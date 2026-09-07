import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  HASH_DOMAINS,
  SIGNER_DOMAINS,
} from '@ald/types';

import {
  InMemorySignerRegistry,
  SeededPrng,
  canonicalJson,
  computeEntryHash,
  decodeHash,
  deriveSeedHex,
  domainHash,
  encodeHash,
  generateEd25519KeyPair,
  hashCarrierMark,
  isSha256Hash,
  parseCanonicalJson,
  privateKeyFromSeed,
  publicKeyFromPrivate,
  signHash,
  uint64BE,
  verifyHashSignature,
} from '../src/index.js';

describe('domain-separated hashing', () => {
  it('encodes as sha256:<64 hex> and round-trips bytes', () => {
    const hash = domainHash('dtsf-test-v1', 'payload');
    expect(isSha256Hash(hash)).toBe(true);
    expect(encodeHash(decodeHash(hash))).toBe(hash);
    expect(isSha256Hash(GENESIS_HASH)).toBe(true);
  });

  it('is deterministic and sensitive to domain, separator, and payload', () => {
    const base = domainHash('dtsf-a-v1', 'x');
    expect(domainHash('dtsf-a-v1', 'x')).toBe(base);
    expect(domainHash('dtsf-b-v1', 'x')).not.toBe(base);
    expect(domainHash('dtsf-a-v1', 'x', 0x01)).not.toBe(base);
    expect(domainHash('dtsf-a-v1', 'y')).not.toBe(base);
    expect(domainHash('dtsf-a-v1', ['x'])).toBe(base);
  });

  it('matches a hand-computed construction', () => {
    // sha256("d" || 0x00 || "p") computed with node:crypto directly.
    const expected = `sha256:${createHash('sha256')
      .update(Buffer.from([0x64, 0x00, 0x70]))
      .digest('hex')}`;
    expect(domainHash('d', 'p')).toBe(expected);
  });

  it('encodes uint64 big-endian', () => {
    expect(uint64BE(1).toString('hex')).toBe('0000000000000001');
    expect(uint64BE(258).toString('hex')).toBe('0000000000000102');
    expect(() => uint64BE(-1)).toThrow();
  });

  it('content-addresses carrier marks with the carrier mode', () => {
    const a = hashCarrierMark('fixed-token', { symbols: ['S01'] });
    expect(a).toBe(hashCarrierMark('fixed-token', { symbols: ['S01'] }));
    expect(a).not.toBe(hashCarrierMark('fixed-glyph', { symbols: ['S01'] }));
    expect(a).not.toBe(hashCarrierMark('fixed-token', { symbols: ['S02'] }));
  });

  it('recomputes an entry hash ignoring signature fields', () => {
    const unsigned = { a: 1, b: { c: [1, 2] } };
    const hash = computeEntryHash('channel', unsigned);
    expect(
      computeEntryHash('channel', {
        ...unsigned,
        entryHash: hash,
        writerSignature: 'ed25519:AAAA',
      }),
    ).toBe(hash);
    expect(computeEntryHash('baby-a-ledger', unsigned)).not.toBe(hash);
    expect(hash).toBe(
      domainHash(HASH_DOMAINS.channelEvent, canonicalJson(unsigned)),
    );
  });
});

describe('canonical JSON', () => {
  it('is insertion-order independent and rejects non-canonical input', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(parseCanonicalJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseCanonicalJson('{ "a": 1 }')).toThrow(/canonical/u);
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('Ed25519', () => {
  it('signs and verifies a hash, and rejects tampering', () => {
    const pair = generateEd25519KeyPair();
    const hash = domainHash('dtsf-test-v1', 'event');
    const signature = signHash(hash, pair.privateKey);
    expect(signature.startsWith('ed25519:')).toBe(true);
    expect(verifyHashSignature(hash, signature, pair.publicKey)).toBe(true);

    const otherHash = domainHash('dtsf-test-v1', 'tampered');
    expect(verifyHashSignature(otherHash, signature, pair.publicKey)).toBe(
      false,
    );
    const otherKey = generateEd25519KeyPair().publicKey;
    expect(verifyHashSignature(hash, signature, otherKey)).toBe(false);
    expect(verifyHashSignature(hash, 'ed25519:notbase64!!', pair.publicKey)).toBe(
      false,
    );
    expect(verifyHashSignature(hash, signature, 'garbage')).toBe(false);
  });

  it('restores the same key from its seed', () => {
    const pair = generateEd25519KeyPair();
    const restored = privateKeyFromSeed(pair.seed);
    expect(publicKeyFromPrivate(restored)).toBe(pair.publicKey);
    const hash = domainHash('dtsf-test-v1', 'seeded');
    expect(signHash(hash, restored)).toBe(signHash(hash, pair.privateKey));
  });
});

describe('seeded PRNG', () => {
  it('replays exactly from the same seed and diverges by label', () => {
    const a = new SeededPrng('run-seed');
    const b = new SeededPrng('run-seed');
    const values = Array.from({ length: 50 }, () => a.nextUint32());
    expect(Array.from({ length: 50 }, () => b.nextUint32())).toEqual(values);

    const c = new SeededPrng('run-seed').derive('scenario');
    const d = new SeededPrng('run-seed').derive('gateway');
    expect(c.nextUint32()).not.toBe(d.nextUint32());
  });

  it('produces bounded integers, unit floats, and permutations', () => {
    const prng = new SeededPrng('bounds');
    for (let index = 0; index < 1000; index += 1) {
      const value = prng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
      const float = prng.nextFloat();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = prng.shuffle(items);
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => prng.nextInt(0)).toThrow();
  });

  it('samples indices proportionally to weights', () => {
    const prng = new SeededPrng('weights');
    const counts = [0, 0, 0];
    for (let index = 0; index < 3000; index += 1) {
      counts[prng.sampleIndex([0, 1, 3])] += 1;
    }
    expect(counts[0]).toBe(0);
    expect(counts[2]).toBeGreaterThan(counts[1] as number);
  });

  it('derives Appendix D seeds as sha256 over 0x00-joined parts', () => {
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from('ald-e03-v1'), Buffer.from([0]), Buffer.from('7')]))
      .digest('hex');
    expect(deriveSeedHex('ald-e03-v1', '7')).toBe(expected);
  });
});

describe('signer registry', () => {
  it('provisions one distinct key per domain and restores from seeds', async () => {
    const registry = InMemorySignerRegistry.generate('run-1');
    const keys = registry.publicKeys();
    expect(keys.map((key) => key.domain).sort()).toEqual(
      [...SIGNER_DOMAINS].sort(),
    );
    expect(new Set(keys.map((key) => key.publicKey)).size).toBe(keys.length);

    const hash = domainHash('dtsf-test-v1', 'signed');
    const signature = await registry.signer('channel').sign(hash);
    const channelKey = keys.find((key) => key.domain === 'channel')?.publicKey;
    const babyKey = keys.find((key) => key.domain === 'baby-a-ledger')?.publicKey;
    expect(verifyHashSignature(hash, signature, channelKey as string)).toBe(true);
    expect(verifyHashSignature(hash, signature, babyKey as string)).toBe(false);

    const restored = InMemorySignerRegistry.fromSeeds(
      'run-1',
      registry.exportSeeds(),
    );
    expect(restored.publicKeys()).toEqual(keys);
    expect(() => restored.signer('witness').keyId).not.toThrow();
    expect(
      InMemorySignerRegistry.generate('run-2').publicKeys()[0]?.publicKey,
    ).not.toBe(keys[0]?.publicKey);
  });
});
