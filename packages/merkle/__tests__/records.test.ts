import { domainHash } from '@ald/hashing';
import {
  ConsistencyProofSchema,
  EVENT_STREAMS,
  InclusionProofSchema,
  MANDATORY_TREES,
} from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_MERKLE_ROOT,
  buildConsistencyProofRecord,
  buildInclusionProofRecord,
  createRangeRootCache,
  merkleLeafHash,
  merkleRoot,
  verifyConsistency,
  verifyInclusion,
} from '@ald/merkle';

function fakeEntryHash(index: number): string {
  return domainHash('test', String(index));
}

const SIZE = 40;
const ENTRIES = Array.from({ length: SIZE }, (_, index) => ({
  sequence: index + 1,
  entryHash: fakeEntryHash(index),
}));
const LEAVES = ENTRIES.map((entry) =>
  merkleLeafHash(entry.sequence, entry.entryHash),
);

describe('buildInclusionProofRecord', () => {
  it('returns a record that validates against InclusionProofSchema', () => {
    const record = buildInclusionProofRecord({
      stream: 'baby-a-ledger',
      treeName: MANDATORY_TREES['baby-a-ledger'],
      checkpointSequence: 7,
      sequence: 13,
      entryHash: fakeEntryHash(12),
      leafHashes: LEAVES,
    });
    expect(InclusionProofSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      version: 1,
      stream: 'baby-a-ledger',
      treeName: 'babyA',
      checkpointSequence: 7,
      treeSize: SIZE,
      leafIndex: 12,
      sequence: 13,
      root: merkleRoot(LEAVES),
    });
  });

  it('uses leafIndex = sequence - 1 and verifies for every event and stream', () => {
    for (const stream of EVENT_STREAMS) {
      for (const entry of ENTRIES) {
        const record = buildInclusionProofRecord({
          stream,
          treeName: stream,
          checkpointSequence: 1,
          sequence: entry.sequence,
          entryHash: entry.entryHash,
          leafHashes: LEAVES,
        });
        expect(record.leafIndex).toBe(entry.sequence - 1);
        expect(verifyInclusion(record)).toBe(true);
      }
    }
  });

  it('throws when the event does not match the leaf the tree committed', () => {
    expect(() =>
      buildInclusionProofRecord({
        stream: 'channel',
        treeName: 'channel',
        checkpointSequence: 1,
        sequence: 5,
        entryHash: fakeEntryHash(999),
        leafHashes: LEAVES,
      }),
    ).toThrow(/leaf hash mismatch/u);
  });

  it('throws when the sequence is outside the committed tree', () => {
    expect(() =>
      buildInclusionProofRecord({
        stream: 'channel',
        treeName: 'channel',
        checkpointSequence: 1,
        sequence: SIZE + 1,
        entryHash: fakeEntryHash(SIZE),
        leafHashes: LEAVES,
      }),
    ).toThrow(/outside the committed tree/u);
    expect(() =>
      buildInclusionProofRecord({
        stream: 'channel',
        treeName: 'channel',
        checkpointSequence: 1,
        sequence: 1,
        entryHash: fakeEntryHash(0),
        leafHashes: [],
      }),
    ).toThrow(/outside the committed tree/u);
  });
});

describe('buildConsistencyProofRecord', () => {
  it('returns a record that validates against ConsistencyProofSchema', () => {
    const record = buildConsistencyProofRecord({
      stream: 'channel',
      treeName: MANDATORY_TREES.channel,
      fromCheckpointSequence: 3,
      toCheckpointSequence: 9,
      fromSize: 17,
      leafHashes: LEAVES,
    });
    expect(ConsistencyProofSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      version: 1,
      stream: 'channel',
      treeName: 'channel',
      fromCheckpointSequence: 3,
      toCheckpointSequence: 9,
      fromSize: 17,
      toSize: SIZE,
      fromRoot: merkleRoot(LEAVES.slice(0, 17)),
      toRoot: merkleRoot(LEAVES),
    });
    expect(verifyConsistency(record)).toBe(true);
  });

  it('verifies for every prefix size, including the empty and full prefixes', () => {
    for (let fromSize = 0; fromSize <= SIZE; fromSize += 1) {
      const record = buildConsistencyProofRecord({
        stream: 'turns',
        treeName: 'turns',
        fromCheckpointSequence: 0,
        toCheckpointSequence: 1,
        fromSize,
        leafHashes: LEAVES,
      });
      expect(verifyConsistency(record)).toBe(true);
      if (fromSize === 0) {
        expect(record.fromRoot).toBe(EMPTY_MERKLE_ROOT);
        expect(record.path).toEqual([]);
      }
    }
  });

  it('throws when fromSize exceeds the tree', () => {
    expect(() =>
      buildConsistencyProofRecord({
        stream: 'audit',
        treeName: 'audit',
        fromCheckpointSequence: 1,
        toCheckpointSequence: 2,
        fromSize: SIZE + 1,
        leafHashes: LEAVES,
      }),
    ).toThrow(/out of range/u);
  });

  it('records the tampered prefix root, so verification against the real one fails', () => {
    const tampered = [...LEAVES];
    tampered[4] = merkleLeafHash(5, fakeEntryHash(1234));
    const record = buildConsistencyProofRecord({
      stream: 'affect',
      treeName: 'affect',
      fromCheckpointSequence: 1,
      toCheckpointSequence: 2,
      fromSize: 16,
      leafHashes: tampered,
    });
    // Internally self-consistent...
    expect(verifyConsistency(record)).toBe(true);
    // ...but not consistent with the root the earlier checkpoint committed.
    expect(
      verifyConsistency({
        ...record,
        fromRoot: merkleRoot(LEAVES.slice(0, 16)),
      }),
    ).toBe(false);
  });
});

describe('RangeRootCache identity scoping across streams (LEDGER-INTEGRITY-DESIGN.md §7)', () => {
  it('gives each stream its own root when two record builds share one cache', () => {
    const babyA = LEAVES;
    const babyB = Array.from({ length: SIZE }, (_, index) =>
      merkleLeafHash(index + 1, fakeEntryHash(index + 1000)),
    );
    const cache = createRangeRootCache();

    const recordA = buildInclusionProofRecord({
      stream: 'baby-a-ledger',
      treeName: MANDATORY_TREES['baby-a-ledger'],
      checkpointSequence: 1,
      sequence: 13,
      entryHash: fakeEntryHash(12),
      leafHashes: babyA,
      cache,
    });
    const recordB = buildInclusionProofRecord({
      stream: 'baby-b-ledger',
      treeName: MANDATORY_TREES['baby-b-ledger'],
      checkpointSequence: 1,
      sequence: 13,
      entryHash: fakeEntryHash(12 + 1000),
      leafHashes: babyB,
      cache,
    });

    // Each record's root must be the MTH of its own leaves, not the other
    // stream's leaves borrowed from a colliding "start:end" cache key.
    expect(recordA.root).toBe(merkleRoot(babyA));
    expect(recordB.root).toBe(merkleRoot(babyB));
    expect(recordA.root).not.toBe(recordB.root);
    expect(verifyInclusion(recordA)).toBe(true);
    expect(verifyInclusion(recordB)).toBe(true);
  });
});
