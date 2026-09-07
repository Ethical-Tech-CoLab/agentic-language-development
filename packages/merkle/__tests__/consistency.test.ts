import { domainHash } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_MERKLE_ROOT,
  MerkleTree,
  consistencyProof,
  merkleLeafHash,
  merkleRoot,
  verifyConsistency,
} from '@ald/merkle';

function fakeEntryHash(index: number): string {
  return domainHash('test', String(index));
}

function leaves(size: number): string[] {
  return Array.from({ length: size }, (_, index) =>
    merkleLeafHash(index + 1, fakeEntryHash(index)),
  );
}

const MAX = 64;
const ALL = leaves(MAX);
const TREE = new MerkleTree(ALL);

describe('consistencyProof structure (RFC 6962 §2.1.2)', () => {
  it('is empty when the prefix is the whole tree', () => {
    for (let size = 0; size <= MAX; size += 1) {
      expect(consistencyProof(leaves(size), size)).toEqual([]);
    }
  });

  it('is empty for the empty prefix', () => {
    expect(consistencyProof(ALL, 0)).toEqual([]);
  });

  it('is the sibling leaf when growing a one-leaf tree to two', () => {
    const two = leaves(2);
    expect(consistencyProof(two, 1)).toEqual([two[1]]);
  });

  it('omits the old root when the old size is a power of two', () => {
    // PROOF(4, D[7]) = SUBPROOF(4, D[0:4], true) : MTH(D[4:7]) — the size-4
    // root is recomputed by the verifier (RFC 6962-bis §2.1.4.2 step 1).
    const seven = leaves(7);
    expect(consistencyProof(seven, 4)).toEqual([
      merkleRoot(seven.slice(4, 7)),
    ]);
    expect(consistencyProof(seven, 4)).not.toContain(
      merkleRoot(seven.slice(0, 4)),
    );
  });

  it('decomposes the old tree when the old size is not a power of two', () => {
    // PROOF(3, D[7]) = [d2, d3, MTH(D[0:2]), MTH(D[4:7])]: enough to rebuild
    // both the size-3 root and the size-7 root.
    const seven = leaves(7);
    expect(consistencyProof(seven, 3)).toEqual([
      seven[2],
      seven[3],
      merkleRoot(seven.slice(0, 2)),
      merkleRoot(seven.slice(4, 7)),
    ]);
  });

  it('rejects an out-of-range prefix size', () => {
    expect(() => consistencyProof(leaves(4), 5)).toThrow(/out of range/u);
    expect(() => consistencyProof(leaves(4), -1)).toThrow(/out of range/u);
  });
});

describe('verifyConsistency accepts every honest extension (ALD-012 acceptance 3)', () => {
  it('verifies every pair (m, n) with m <= n <= 64', () => {
    for (let toSize = 0; toSize <= MAX; toSize += 1) {
      const toRoot = TREE.rootAt(toSize);
      const prefix = ALL.slice(0, toSize);
      for (let fromSize = 0; fromSize <= toSize; fromSize += 1) {
        expect(
          verifyConsistency({
            fromSize,
            toSize,
            fromRoot: TREE.rootAt(fromSize),
            toRoot,
            path: consistencyProof(prefix, fromSize),
          }),
        ).toBe(true);
      }
    }
  });

  it('verifies the empty prefix against any tree with the empty root', () => {
    for (let toSize = 1; toSize <= MAX; toSize += 1) {
      expect(
        verifyConsistency({
          fromSize: 0,
          toSize,
          fromRoot: EMPTY_MERKLE_ROOT,
          toRoot: TREE.rootAt(toSize),
          path: [],
        }),
      ).toBe(true);
    }
  });

  it('verifies identical sizes only when the roots match and the proof is empty', () => {
    const root = TREE.rootAt(20);
    expect(
      verifyConsistency({ fromSize: 20, toSize: 20, fromRoot: root, toRoot: root, path: [] }),
    ).toBe(true);
    expect(
      verifyConsistency({
        fromSize: 20,
        toSize: 20,
        fromRoot: root,
        toRoot: TREE.rootAt(19),
        path: [],
      }),
    ).toBe(false);
    expect(
      verifyConsistency({
        fromSize: 20,
        toSize: 20,
        fromRoot: root,
        toRoot: root,
        path: [ALL[0] ?? ''],
      }),
    ).toBe(false);
  });

  it('verifies proofs produced by the memoizing class', () => {
    const tree = new MerkleTree();
    for (let size = 1; size <= 40; size += 1) {
      tree.appendEntry(size, fakeEntryHash(size - 1));
      for (let fromSize = 0; fromSize <= size; fromSize += 1) {
        expect(
          verifyConsistency({
            fromSize,
            toSize: size,
            fromRoot: tree.rootAt(fromSize),
            toRoot: tree.root(),
            path: tree.consistencyProof(fromSize),
          }),
        ).toBe(true);
      }
    }
  });
});

describe('verifyConsistency rejects non-prefix trees (ALD-012 acceptance 3)', () => {
  it('rejects a fromRoot taken from a different prefix size', () => {
    for (let toSize = 2; toSize <= MAX; toSize += 1) {
      const prefix = ALL.slice(0, toSize);
      for (let fromSize = 1; fromSize < toSize; fromSize += 1) {
        const path = consistencyProof(prefix, fromSize);
        const wrongSize = fromSize === 1 ? fromSize + 1 : fromSize - 1;
        expect(
          verifyConsistency({
            fromSize,
            toSize,
            fromRoot: TREE.rootAt(wrongSize),
            toRoot: TREE.rootAt(toSize),
            path,
          }),
        ).toBe(false);
      }
    }
  });

  it('rejects a later tree whose committed prefix was modified', () => {
    for (let toSize = 2; toSize <= 40; toSize += 1) {
      for (let fromSize = 1; fromSize < toSize; fromSize += 1) {
        const tampered = ALL.slice(0, toSize);
        const target = fromSize - 1;
        tampered[target] = merkleLeafHash(target + 1, fakeEntryHash(500 + target));
        expect(
          verifyConsistency({
            fromSize,
            toSize,
            fromRoot: TREE.rootAt(fromSize),
            toRoot: merkleRoot(tampered),
            path: consistencyProof(tampered, fromSize),
          }),
        ).toBe(false);
      }
    }
  });

  it('rejects a deletion inside the committed prefix', () => {
    const fromSize = 16;
    const toSize = 32;
    const deleted = [
      ...ALL.slice(0, 5),
      ...ALL.slice(6, toSize + 1),
    ];
    expect(
      verifyConsistency({
        fromSize,
        toSize,
        fromRoot: TREE.rootAt(fromSize),
        toRoot: merkleRoot(deleted.slice(0, toSize)),
        path: consistencyProof(deleted.slice(0, toSize), fromSize),
      }),
    ).toBe(false);
  });

  it('rejects an insertion inside the committed prefix', () => {
    const fromSize = 16;
    const toSize = 32;
    const inserted = [
      ...ALL.slice(0, 5),
      merkleLeafHash(6, fakeEntryHash(777)),
      ...ALL.slice(5, toSize - 1),
    ];
    expect(inserted).toHaveLength(toSize);
    expect(
      verifyConsistency({
        fromSize,
        toSize,
        fromRoot: TREE.rootAt(fromSize),
        toRoot: merkleRoot(inserted),
        path: consistencyProof(inserted, fromSize),
      }),
    ).toBe(false);
  });

  it('rejects reordered leaves inside the committed prefix', () => {
    const fromSize = 8;
    const toSize = 24;
    const swapped = ALL.slice(0, toSize);
    const a = swapped[2];
    const b = swapped[5];
    swapped[2] = b ?? '';
    swapped[5] = a ?? '';
    expect(
      verifyConsistency({
        fromSize,
        toSize,
        fromRoot: TREE.rootAt(fromSize),
        toRoot: merkleRoot(swapped),
        path: consistencyProof(swapped, fromSize),
      }),
    ).toBe(false);
  });

  it('rejects a shrinking tree and a mismatched toRoot', () => {
    expect(
      verifyConsistency({
        fromSize: 20,
        toSize: 10,
        fromRoot: TREE.rootAt(20),
        toRoot: TREE.rootAt(10),
        path: [],
      }),
    ).toBe(false);
    expect(
      verifyConsistency({
        fromSize: 10,
        toSize: 20,
        fromRoot: TREE.rootAt(10),
        toRoot: TREE.rootAt(21),
        path: consistencyProof(ALL.slice(0, 20), 10),
      }),
    ).toBe(false);
  });

  it('rejects a truncated, extended, corrupted, or missing path', () => {
    for (let fromSize = 1; fromSize < 40; fromSize += 1) {
      const toSize = 40;
      const prefix = ALL.slice(0, toSize);
      const path = consistencyProof(prefix, fromSize);
      const base = {
        fromSize,
        toSize,
        fromRoot: TREE.rootAt(fromSize),
        toRoot: TREE.rootAt(toSize),
      };
      expect(verifyConsistency({ ...base, path: path.slice(1) })).toBe(false);
      expect(verifyConsistency({ ...base, path: [...path, ALL[0] ?? ''] })).toBe(false);
      expect(verifyConsistency({ ...base, path: [] })).toBe(false);
      const corrupted = [...path];
      corrupted[corrupted.length - 1] = merkleLeafHash(1, fakeEntryHash(4242));
      expect(verifyConsistency({ ...base, path: corrupted })).toBe(false);
    }
  });

  it('rejects the empty prefix presented with a non-empty root', () => {
    expect(
      verifyConsistency({
        fromSize: 0,
        toSize: 8,
        fromRoot: TREE.rootAt(1),
        toRoot: TREE.rootAt(8),
        path: [],
      }),
    ).toBe(false);
  });

  it('never throws on malformed input', () => {
    const path = consistencyProof(ALL.slice(0, 20), 10);
    const bad = [
      { fromSize: 10, toSize: 20, fromRoot: 'x', toRoot: TREE.rootAt(20), path },
      { fromSize: 10, toSize: 20, fromRoot: TREE.rootAt(10), toRoot: 'sha256:zz', path },
      { fromSize: -1, toSize: 20, fromRoot: TREE.rootAt(10), toRoot: TREE.rootAt(20), path },
      { fromSize: 1.5, toSize: 20, fromRoot: TREE.rootAt(10), toRoot: TREE.rootAt(20), path },
      { fromSize: 10, toSize: Number.NaN, fromRoot: TREE.rootAt(10), toRoot: TREE.rootAt(20), path },
      { fromSize: 10, toSize: 20, fromRoot: TREE.rootAt(10), toRoot: TREE.rootAt(20), path: ['bad'] },
    ];
    for (const input of bad) {
      expect(verifyConsistency(input)).toBe(false);
    }
  });

  it('rejects fromSize/toSize at or beyond 2**32 instead of truncating them', () => {
    // fn/sn (and the RFC 6962-bis step-1 power-of-two test) are driven by
    // the 32-bit operators `>>>` and `&`; without an explicit upper bound,
    // fromSize/toSize >= 2**32 would be silently reduced modulo 2**32, so
    // this exact genuine 4-to-8 proof would (wrongly) verify against
    // declared sizes inflated by 2**32.
    const eight = leaves(8);
    const fromRoot = merkleRoot(eight.slice(0, 4));
    const toRoot = merkleRoot(eight);
    const genuinePath = consistencyProof(eight, 4);

    expect(
      verifyConsistency({
        fromSize: 4 + 2 ** 32,
        toSize: 8 + 2 ** 32,
        fromRoot,
        toRoot,
        path: genuinePath,
      }),
    ).toBe(false);

    expect(
      verifyConsistency({
        fromSize: 4,
        toSize: 8 + 2 ** 32,
        fromRoot,
        toRoot,
        path: genuinePath,
      }),
    ).toBe(false);

    // Values within the representable range are unaffected.
    expect(
      verifyConsistency({ fromSize: 4, toSize: 8, fromRoot, toRoot, path: genuinePath }),
    ).toBe(true);
  });

  it('rejects a path longer than any tree of the declared size could produce', () => {
    const toSize = 40;
    const prefix = ALL.slice(0, toSize);
    const genuinePath = consistencyProof(prefix, 10);
    const overlong = [
      ...genuinePath,
      ...genuinePath,
      ...genuinePath,
      ...genuinePath,
    ];
    expect(
      verifyConsistency({
        fromSize: 10,
        toSize,
        fromRoot: TREE.rootAt(10),
        toRoot: TREE.rootAt(toSize),
        path: overlong,
      }),
    ).toBe(false);
  });
});
