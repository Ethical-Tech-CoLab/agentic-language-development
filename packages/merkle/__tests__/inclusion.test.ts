import { domainHash } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  MerkleTree,
  inclusionProof,
  merkleLeafHash,
  merkleRoot,
  verifyInclusion,
} from '@ald/merkle';

function fakeEntryHash(index: number): string {
  return domainHash('test', String(index));
}

function leaves(size: number): string[] {
  return Array.from({ length: size }, (_, index) =>
    merkleLeafHash(index + 1, fakeEntryHash(index)),
  );
}

const OTHER_HASH = domainHash('test', 'other');

describe('inclusionProof structure (RFC 6962 §2.1.1)', () => {
  it('is empty for the only leaf of a single-leaf tree', () => {
    expect(inclusionProof(leaves(1), 0)).toEqual([]);
  });

  it('is the sibling leaf for a two-leaf tree', () => {
    const two = leaves(2);
    expect(inclusionProof(two, 0)).toEqual([two[1]]);
    expect(inclusionProof(two, 1)).toEqual([two[0]]);
  });

  it('orders the path from the leaf sibling upwards', () => {
    const three = leaves(3);
    expect(inclusionProof(three, 0)).toEqual([
      three[1],
      merkleRoot(three.slice(2)),
    ]);
    expect(inclusionProof(three, 2)).toEqual([merkleRoot(three.slice(0, 2))]);
  });

  it('has ceil(log2(n)) or fewer elements', () => {
    for (let size = 1; size <= 130; size += 1) {
      const tree = leaves(size);
      const depth = Math.ceil(Math.log2(size));
      for (let index = 0; index < size; index += 1) {
        expect(inclusionProof(tree, index).length).toBeLessThanOrEqual(depth);
      }
    }
  });

  it('rejects an out-of-range leaf index', () => {
    expect(() => inclusionProof(leaves(4), 4)).toThrow(/out of range/u);
    expect(() => inclusionProof(leaves(4), -1)).toThrow(/out of range/u);
    expect(() => inclusionProof([], 0)).toThrow(/out of range/u);
  });
});

describe('verifyInclusion accepts every honest proof (ALD-012 acceptance 2)', () => {
  it('verifies every leaf of every tree size 0..130 from the proof alone', () => {
    for (let size = 0; size <= 130; size += 1) {
      const tree = leaves(size);
      const root = merkleRoot(tree);
      for (let leafIndex = 0; leafIndex < size; leafIndex += 1) {
        const leafHash = tree[leafIndex];
        expect(leafHash).toBeDefined();
        expect(
          verifyInclusion({
            leafHash: leafHash ?? '',
            leafIndex,
            treeSize: size,
            path: inclusionProof(tree, leafIndex),
            root,
          }),
        ).toBe(true);
      }
    }
  });

  it('verifies proofs produced by the memoizing class', () => {
    const tree = new MerkleTree();
    for (let size = 1; size <= 40; size += 1) {
      tree.appendEntry(size, fakeEntryHash(size - 1));
      const root = tree.root();
      for (let leafIndex = 0; leafIndex < size; leafIndex += 1) {
        expect(
          verifyInclusion({
            leafHash: merkleLeafHash(leafIndex + 1, fakeEntryHash(leafIndex)),
            leafIndex,
            treeSize: size,
            path: tree.inclusionProof(leafIndex),
            root,
          }),
        ).toBe(true);
      }
    }
  });
});

describe('verifyInclusion rejects every dishonest proof (ALD-012 acceptance 2)', () => {
  it('rejects a wrong root, wrong leaf, and wrong index for sizes 1..64', () => {
    for (let size = 1; size <= 64; size += 1) {
      const tree = leaves(size);
      const root = merkleRoot(tree);
      const wrongRoot = merkleRoot([...tree, merkleLeafHash(size + 1, OTHER_HASH)]);
      for (let leafIndex = 0; leafIndex < size; leafIndex += 1) {
        const path = inclusionProof(tree, leafIndex);
        const leafHash = tree[leafIndex] ?? '';

        expect(
          verifyInclusion({ leafHash, leafIndex, treeSize: size, path, root: wrongRoot }),
        ).toBe(false);

        expect(
          verifyInclusion({
            leafHash: merkleLeafHash(leafIndex + 1, OTHER_HASH),
            leafIndex,
            treeSize: size,
            path,
            root,
          }),
        ).toBe(false);

        if (size > 1) {
          const wrongIndex = (leafIndex + 1) % size;
          expect(
            verifyInclusion({
              leafHash,
              leafIndex: wrongIndex,
              treeSize: size,
              path,
              root,
            }),
          ).toBe(false);
        }
      }
    }
  });

  it('rejects a truncated, extended, or corrupted path', () => {
    const size = 37;
    const tree = leaves(size);
    const root = merkleRoot(tree);
    for (let leafIndex = 0; leafIndex < size; leafIndex += 1) {
      const path = inclusionProof(tree, leafIndex);
      expect(
        verifyInclusion({
          leafHash: tree[leafIndex] ?? '',
          leafIndex,
          treeSize: size,
          path: path.slice(0, -1),
          root,
        }),
      ).toBe(false);
      expect(
        verifyInclusion({
          leafHash: tree[leafIndex] ?? '',
          leafIndex,
          treeSize: size,
          path: [...path, OTHER_HASH],
          root,
        }),
      ).toBe(false);
      const corrupted = [...path];
      corrupted[0] = OTHER_HASH;
      expect(
        verifyInclusion({
          leafHash: tree[leafIndex] ?? '',
          leafIndex,
          treeSize: size,
          path: corrupted,
          root,
        }),
      ).toBe(false);
      const reversed = [...path].reverse();
      if (path.length > 1) {
        expect(
          verifyInclusion({
            leafHash: tree[leafIndex] ?? '',
            leafIndex,
            treeSize: size,
            path: reversed,
            root,
          }),
        ).toBe(false);
      }
    }
  });

  it('rejects a proof against a tree size the leaf does not belong to', () => {
    const tree = leaves(16);
    const path = inclusionProof(tree, 3);
    expect(
      verifyInclusion({
        leafHash: tree[3] ?? '',
        leafIndex: 3,
        treeSize: 17,
        path,
        root: merkleRoot(tree),
      }),
    ).toBe(false);
    expect(
      verifyInclusion({
        leafHash: tree[3] ?? '',
        leafIndex: 3,
        treeSize: 3,
        path,
        root: merkleRoot(tree),
      }),
    ).toBe(false);
  });

  it('never throws on malformed input', () => {
    const tree = leaves(8);
    const root = merkleRoot(tree);
    const leafHash = tree[0] ?? '';
    const path = inclusionProof(tree, 0);
    const bad = [
      { leafHash: 'not-a-hash', leafIndex: 0, treeSize: 8, path, root },
      { leafHash, leafIndex: 0, treeSize: 8, path, root: 'sha256:zz' },
      { leafHash, leafIndex: 0, treeSize: 8, path: ['bogus'], root },
      { leafHash, leafIndex: -1, treeSize: 8, path, root },
      { leafHash, leafIndex: 0, treeSize: 0, path, root },
      { leafHash, leafIndex: 1.5, treeSize: 8, path, root },
      { leafHash, leafIndex: Number.NaN, treeSize: 8, path, root },
      { leafHash, leafIndex: 0, treeSize: Number.POSITIVE_INFINITY, path, root },
    ];
    for (const input of bad) {
      expect(verifyInclusion(input)).toBe(false);
    }
  });

  it('rejects an empty tree, which contains no leaf', () => {
    expect(
      verifyInclusion({
        leafHash: leaves(1)[0] ?? '',
        leafIndex: 0,
        treeSize: 0,
        path: [],
        root: merkleRoot([]),
      }),
    ).toBe(false);
  });

  it('rejects treeSize/leafIndex at or beyond 2**32 instead of truncating them', () => {
    // fn/sn are driven by the 32-bit operators `>>>` and `&`. Without an
    // explicit upper bound, `treeSize - 1 = 2**32 + 1` truncates to 1 via
    // ToUint32, which is exactly the `sn` a genuine 2-leaf proof produces —
    // so this real 2-leaf audit path would (wrongly) verify as inclusion in
    // a claimed tree of 2**32 + 2 leaves, and even at a claimed leafIndex of
    // 2**32 (which truncates to 0).
    const two = leaves(2);
    const root = merkleRoot(two);
    const genuinePath = inclusionProof(two, 0);

    expect(
      verifyInclusion({
        leafHash: two[0] ?? '',
        leafIndex: 0,
        treeSize: 2 ** 32 + 2,
        path: genuinePath,
        root,
      }),
    ).toBe(false);

    expect(
      verifyInclusion({
        leafHash: two[0] ?? '',
        leafIndex: 2 ** 32,
        treeSize: 2 ** 32 + 2,
        path: genuinePath,
        root,
      }),
    ).toBe(false);

    // A round, out-of-range value the review named explicitly.
    expect(
      verifyInclusion({
        leafHash: two[0] ?? '',
        leafIndex: 0,
        treeSize: 2 ** 32 + 3,
        path: genuinePath,
        root,
      }),
    ).toBe(false);

    // Values within the representable range are unaffected.
    expect(
      verifyInclusion({
        leafHash: two[0] ?? '',
        leafIndex: 0,
        treeSize: 2,
        path: genuinePath,
        root,
      }),
    ).toBe(true);
  });

  it('rejects a path longer than any tree of the declared size could produce', () => {
    const size = 8;
    const tree = leaves(size);
    const root = merkleRoot(tree);
    const genuinePath = inclusionProof(tree, 3);
    const overlong = [...genuinePath, ...genuinePath, ...genuinePath, ...genuinePath];
    expect(
      verifyInclusion({
        leafHash: tree[3] ?? '',
        leafIndex: 3,
        treeSize: size,
        path: overlong,
        root,
      }),
    ).toBe(false);
  });
});
