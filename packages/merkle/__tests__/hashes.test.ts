import { createHash } from 'node:crypto';

import { domainHash, uint64BE } from '@ald/hashing';
import { HASH_DOMAINS } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_MERKLE_ROOT,
  merkleLeafHash,
  merkleLeafHashes,
  merkleNodeHash,
} from '@ald/merkle';

const ENTRY_A = domainHash('test', 'a');
const ENTRY_B = domainHash('test', 'b');

function rawSha256(...parts: Buffer[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashBytes(hash: string): Buffer {
  return Buffer.from(hash.slice('sha256:'.length), 'hex');
}

describe('merkle leaf and node hashes (LEDGER §7)', () => {
  it('computes the leaf hash as domain || 0x00 || uint64BE(sequence) || entryHash bytes', () => {
    expect(merkleLeafHash(1, ENTRY_A)).toBe(
      rawSha256(
        Buffer.from(HASH_DOMAINS.merkleLeaf, 'utf8'),
        Buffer.from([0x00]),
        uint64BE(1),
        hashBytes(ENTRY_A),
      ),
    );
  });

  it('computes the node hash as domain || 0x01 || left || right bytes', () => {
    const left = merkleLeafHash(1, ENTRY_A);
    const right = merkleLeafHash(2, ENTRY_B);
    expect(merkleNodeHash(left, right)).toBe(
      rawSha256(
        Buffer.from(HASH_DOMAINS.merkleNode, 'utf8'),
        Buffer.from([0x01]),
        hashBytes(left),
        hashBytes(right),
      ),
    );
  });

  it('binds the sequence, so the same entry at a different sequence is a different leaf', () => {
    expect(merkleLeafHash(1, ENTRY_A)).not.toBe(merkleLeafHash(2, ENTRY_A));
  });

  it('binds the entry hash, so a different entry at the same sequence differs', () => {
    expect(merkleLeafHash(1, ENTRY_A)).not.toBe(merkleLeafHash(1, ENTRY_B));
  });

  it('is not order-symmetric for interior nodes', () => {
    const left = merkleLeafHash(1, ENTRY_A);
    const right = merkleLeafHash(2, ENTRY_B);
    expect(merkleNodeHash(left, right)).not.toBe(merkleNodeHash(right, left));
  });

  it('rejects a non-positive or non-integer sequence', () => {
    expect(() => merkleLeafHash(0, ENTRY_A)).toThrow(/positive/u);
    expect(() => merkleLeafHash(-1, ENTRY_A)).toThrow(/positive/u);
    expect(() => merkleLeafHash(1.5, ENTRY_A)).toThrow(/positive/u);
  });

  it('rejects malformed entry hashes and node children', () => {
    expect(() => merkleLeafHash(1, 'sha256:zz')).toThrow(/Invalid SHA-256/u);
    expect(() => merkleNodeHash(ENTRY_A, 'nope')).toThrow(/Invalid SHA-256/u);
  });

  it('documents the empty-tree root as the node domain over no children', () => {
    expect(EMPTY_MERKLE_ROOT).toBe(
      rawSha256(
        Buffer.from(HASH_DOMAINS.merkleNode, 'utf8'),
        Buffer.from([0x01]),
      ),
    );
    expect(EMPTY_MERKLE_ROOT).toBe(
      domainHash(HASH_DOMAINS.merkleNode, [], 0x01),
    );
  });

  it('maps a contiguous event run to leaves in sequence order', () => {
    const entries = [
      { sequence: 1, entryHash: ENTRY_A },
      { sequence: 2, entryHash: ENTRY_B },
    ];
    expect(merkleLeafHashes(entries)).toEqual([
      merkleLeafHash(1, ENTRY_A),
      merkleLeafHash(2, ENTRY_B),
    ]);
  });

  it('rejects gaps, duplicates, and descending sequences', () => {
    expect(() =>
      merkleLeafHashes([
        { sequence: 1, entryHash: ENTRY_A },
        { sequence: 3, entryHash: ENTRY_B },
      ]),
    ).toThrow(/contiguous/u);
    expect(() =>
      merkleLeafHashes([
        { sequence: 2, entryHash: ENTRY_A },
        { sequence: 2, entryHash: ENTRY_B },
      ]),
    ).toThrow(/contiguous/u);
    expect(() =>
      merkleLeafHashes([
        { sequence: 2, entryHash: ENTRY_A },
        { sequence: 1, entryHash: ENTRY_B },
      ]),
    ).toThrow(/contiguous/u);
  });
});
