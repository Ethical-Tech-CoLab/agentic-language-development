import { domainHash } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_MERKLE_ROOT,
  MerkleTree,
  consistencyProof,
  createRangeRootCache,
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  merkleRoot,
} from '@ald/merkle';

/** Deterministic stand-in entry hashes; content is irrelevant to tree shape. */
function fakeEntryHash(index: number): string {
  return domainHash('test', String(index));
}

function leaves(size: number, offset = 0): string[] {
  return Array.from({ length: size }, (_, index) =>
    merkleLeafHash(index + 1, fakeEntryHash(index + offset)),
  );
}

describe('merkleRoot known structure (RFC 6962 §2.1)', () => {
  it('hashes an empty tree to the documented empty root', () => {
    expect(merkleRoot([])).toBe(EMPTY_MERKLE_ROOT);
  });

  it('hashes a single-leaf tree to that leaf hash (ALD-012 decision)', () => {
    const [leaf] = leaves(1);
    expect(leaf).toBeDefined();
    expect(merkleRoot(leaves(1))).toBe(leaf);
  });

  it('hashes two leaves to nodeHash(l0, l1)', () => {
    const [l0, l1] = leaves(2);
    expect(merkleRoot(leaves(2))).toBe(merkleNodeHash(l0 ?? '', l1 ?? ''));
  });

  it('hashes three leaves to nodeHash(nodeHash(l0, l1), l2)', () => {
    const [l0, l1, l2] = leaves(3);
    expect(merkleRoot(leaves(3))).toBe(
      merkleNodeHash(merkleNodeHash(l0 ?? '', l1 ?? ''), l2 ?? ''),
    );
  });

  it('hashes four leaves as a balanced tree', () => {
    const [l0, l1, l2, l3] = leaves(4);
    expect(merkleRoot(leaves(4))).toBe(
      merkleNodeHash(
        merkleNodeHash(l0 ?? '', l1 ?? ''),
        merkleNodeHash(l2 ?? '', l3 ?? ''),
      ),
    );
  });

  it('splits five leaves at k = 4, the largest power of two below n', () => {
    const five = leaves(5);
    const [l0, l1, l2, l3, l4] = five;
    expect(merkleRoot(five)).toBe(
      merkleNodeHash(
        merkleNodeHash(
          merkleNodeHash(l0 ?? '', l1 ?? ''),
          merkleNodeHash(l2 ?? '', l3 ?? ''),
        ),
        l4 ?? '',
      ),
    );
  });

  it('splits seven leaves at k = 4 (RFC 6962 example shape)', () => {
    const seven = leaves(7);
    expect(merkleRoot(seven)).toBe(
      merkleNodeHash(merkleRoot(seven.slice(0, 4)), merkleRoot(seven.slice(4))),
    );
  });
});

describe('merkleRoot determinism (ALD-012 acceptance 1)', () => {
  it('produces the same root for the same ordered leaves across two builds', () => {
    for (const size of [0, 1, 2, 3, 7, 8, 33, 100, 130]) {
      const first = merkleRoot(leaves(size));
      const second = merkleRoot(leaves(size));
      expect(second).toBe(first);
    }
  });

  it('produces the same root through the class as through the pure function', () => {
    const tree = new MerkleTree();
    const expected = leaves(130);
    for (const [index, leaf] of expected.entries()) {
      expect(tree.append(leaf)).toBe(index);
      expect(tree.size).toBe(index + 1);
      expect(tree.root()).toBe(merkleRoot(expected.slice(0, index + 1)));
    }
    expect(tree.leafHashes()).toEqual(expected);
  });

  it('re-reads a cached root identically (the cache never changes a root)', () => {
    const tree = new MerkleTree(leaves(97));
    const first = tree.root();
    expect(tree.root()).toBe(first);
    for (let size = 0; size <= 97; size += 1) {
      expect(tree.rootAt(size)).toBe(merkleRoot(leaves(97).slice(0, size)));
    }
  });

  it('starts empty, with the documented empty root and no proofs to make', () => {
    const tree = new MerkleTree();
    expect(tree.size).toBe(0);
    expect(tree.root()).toBe(EMPTY_MERKLE_ROOT);
    expect(tree.rootAt(0)).toBe(EMPTY_MERKLE_ROOT);
    expect(tree.consistencyProof(0)).toEqual([]);
    expect(tree.leafHashes()).toEqual([]);
    expect(() => tree.inclusionProof(0)).toThrow(/out of range/u);
  });

  it('appends an event by sequence and entry hash', () => {
    const tree = new MerkleTree();
    expect(tree.appendEntry(1, fakeEntryHash(0))).toBe(
      merkleLeafHash(1, fakeEntryHash(0)),
    );
    expect(tree.root()).toBe(merkleRoot(leaves(1)));
  });
});

describe('merkleRoot sensitivity to leaf-set mutation (LEDGER §17)', () => {
  const size = 64;
  const base = leaves(size);
  const baseRoot = merkleRoot(base);

  it('changes when a leaf is modified', () => {
    for (const index of [0, 1, 31, 32, 63]) {
      const mutated = [...base];
      mutated[index] = merkleLeafHash(index + 1, fakeEntryHash(1000 + index));
      expect(merkleRoot(mutated)).not.toBe(baseRoot);
    }
  });

  it('changes when a middle leaf is deleted', () => {
    const deleted = [...base.slice(0, 30), ...base.slice(31)];
    expect(merkleRoot(deleted)).not.toBe(baseRoot);
  });

  it('changes when a leaf is inserted', () => {
    const inserted = [
      ...base.slice(0, 30),
      merkleLeafHash(31, fakeEntryHash(9999)),
      ...base.slice(30),
    ];
    expect(merkleRoot(inserted)).not.toBe(baseRoot);
  });

  it('changes when two leaves are reordered', () => {
    const swapped = [...base];
    const a = swapped[10];
    const b = swapped[11];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    swapped[10] = b ?? '';
    swapped[11] = a ?? '';
    expect(merkleRoot(swapped)).not.toBe(baseRoot);
  });

  it('changes when the tree is truncated (size is part of the commitment)', () => {
    expect(merkleRoot(base.slice(0, size - 1))).not.toBe(baseRoot);
  });

  it('gives distinct roots to every distinct prefix size 0..130', () => {
    const all = leaves(130);
    const roots = new Set<string>();
    for (let prefix = 0; prefix <= all.length; prefix += 1) {
      roots.add(merkleRoot(all.slice(0, prefix)));
    }
    expect(roots.size).toBe(all.length + 1);
  });
});

describe('merkleRoot argument validation', () => {
  it('rejects an out-of-range prefix size on the class', () => {
    const tree = new MerkleTree(leaves(4));
    expect(() => tree.rootAt(5)).toThrow(/out of range/u);
    expect(() => tree.rootAt(-1)).toThrow(/out of range/u);
  });
});

describe('RangeRootCache identity scoping (LEDGER-INTEGRITY-DESIGN.md §7)', () => {
  it('gives two distinct leaf lists their own correct roots when sharing one cache', () => {
    // Same [start, end) range keys would collide in a cache keyed only by
    // "start:end" — the cache must be scoped by leaf-array identity so that
    // handing it to a second, unrelated leaf list cannot contaminate its
    // roots with the first list's subtree roots.
    const a = leaves(4, 0);
    const b = leaves(4, 100);
    const cache = createRangeRootCache();

    const rootA = merkleRoot(a, cache);
    const rootB = merkleRoot(b, cache);

    expect(rootA).toBe(merkleRoot(a));
    expect(rootB).toBe(merkleRoot(b));
    expect(rootB).not.toBe(rootA);

    // Re-reading through the same shared cache must still be correct, not
    // just the first write.
    expect(merkleRoot(a, cache)).toBe(rootA);
    expect(merkleRoot(b, cache)).toBe(rootB);
  });

  it('gives correct inclusion and consistency proofs when two leaf lists share one cache', () => {
    const a = leaves(8, 0);
    const b = leaves(8, 100);
    const cache = createRangeRootCache();

    const rootA = merkleRoot(a, cache);
    const pathA = inclusionProof(a, 3, cache);
    const rootB = merkleRoot(b, cache);
    const pathB = inclusionProof(b, 3, cache);

    expect(pathA).toEqual(inclusionProof(a, 3));
    expect(pathB).toEqual(inclusionProof(b, 3));
    expect(pathA).not.toEqual(pathB);

    const consistA = consistencyProof(a, 4, cache);
    const consistB = consistencyProof(b, 4, cache);
    expect(consistA).toEqual(consistencyProof(a, 4));
    expect(consistB).toEqual(consistencyProof(b, 4));
    expect(rootA).not.toBe(rootB);
  });
});
