/**
 * RFC 6962 ordered Merkle trees over sequence-ordered leaf hashes
 * (LEDGER-INTEGRITY-DESIGN.md §7, docs/evidence-bundle-format.md §5).
 *
 * Tree shape is the RFC 6962 §2.1 Merkle Tree Hash: for `n > 1` leaves the
 * tree splits at `k`, the largest power of two strictly less than `n`, so
 * every prefix of the leaf list is a subtree of every extension of it. That
 * is what makes the prefix-consistency proofs of §2.1.2 possible.
 *
 * Two deviations from RFC 6962 §2.1 are deliberate and are recorded in the
 * ALD-012 decisions:
 *
 * 1. Leaves are already domain-hashed by {@link merkleLeafHash}, so
 *    `MTH({d0})` is that leaf hash itself rather than `HASH(0x00 || d0)`;
 *    the RFC's leaf prefix is replaced by the `dtsf-merkle-leaf-v1` domain.
 * 2. `MTH({})` is the merkle-node domain hashed over no children rather than
 *    `HASH()` of the empty string (docs/evidence-bundle-format.md §5).
 */
import { EMPTY_MERKLE_ROOT, merkleLeafHash, merkleNodeHash } from './hashes.js';

/** Cache of `${start}:${end}` → subtree root. Sound because leaves never mutate. */
export type RangeRootCache = Map<string, string>;

/** Largest power of two strictly less than `n`. Requires `n > 1` (RFC 6962 §2.1). */
function splitPoint(size: number): number {
  return 1 << (31 - Math.clz32(size - 1));
}

function leafAt(leafHashes: readonly string[], index: number): string {
  const leaf = leafHashes[index];
  if (leaf === undefined) {
    throw new Error(`Merkle leaf index ${String(index)} is out of range`);
  }
  return leaf;
}

/** MTH over `leafHashes[start, end)`. */
function rangeRoot(
  leafHashes: readonly string[],
  start: number,
  end: number,
  cache?: RangeRootCache,
): string {
  const size = end - start;
  if (size === 0) {
    return EMPTY_MERKLE_ROOT;
  }
  if (size === 1) {
    return leafAt(leafHashes, start);
  }
  const key = `${String(start)}:${String(end)}`;
  const cached = cache?.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const k = splitPoint(size);
  const root = merkleNodeHash(
    rangeRoot(leafHashes, start, start + k, cache),
    rangeRoot(leafHashes, start + k, end, cache),
  );
  cache?.set(key, root);
  return root;
}

function assertLeafHashes(leafHashes: readonly string[]): void {
  for (const [index, leaf] of leafHashes.entries()) {
    if (typeof leaf !== 'string') {
      throw new Error(`Merkle leaf at index ${String(index)} is not a hash string`);
    }
  }
}

/**
 * RFC 6962 §2.1 Merkle Tree Hash of the ordered leaf hashes. An empty tree
 * hashes to {@link EMPTY_MERKLE_ROOT}; a single-leaf tree hashes to that leaf.
 */
export function merkleRoot(
  leafHashes: readonly string[],
  cache?: RangeRootCache,
): string {
  assertLeafHashes(leafHashes);
  return rangeRoot(leafHashes, 0, leafHashes.length, cache);
}

/**
 * RFC 6962 §2.1.1 `PATH(m, D[n])` — the audit path for the leaf at 0-based
 * `leafIndex`, ordered from the leaf's sibling upwards to the sibling of the
 * root's child. `leafIndex = sequence - 1` for ledger events (LEDGER §7).
 */
export function inclusionProof(
  leafHashes: readonly string[],
  leafIndex: number,
  cache?: RangeRootCache,
): string[] {
  assertLeafHashes(leafHashes);
  if (
    !Number.isSafeInteger(leafIndex) ||
    leafIndex < 0 ||
    leafIndex >= leafHashes.length
  ) {
    throw new Error(
      `leafIndex ${String(leafIndex)} is out of range for a tree of size ${String(leafHashes.length)}`,
    );
  }
  const path: string[] = [];
  let start = 0;
  let end = leafHashes.length;
  let index = leafIndex;
  while (end - start > 1) {
    const k = splitPoint(end - start);
    if (index < k) {
      path.push(rangeRoot(leafHashes, start + k, end, cache));
      end = start + k;
    } else {
      path.push(rangeRoot(leafHashes, start, start + k, cache));
      index -= k;
      start += k;
    }
  }
  // PATH() lists the leaf's sibling first; the loop descends, so reverse.
  return path.reverse();
}

/** RFC 6962 §2.1.2 `SUBPROOF(m, D[start, end), b)`. */
function subProof(
  leafHashes: readonly string[],
  start: number,
  end: number,
  m: number,
  complete: boolean,
  cache: RangeRootCache | undefined,
  out: string[],
): void {
  const size = end - start;
  if (m === size) {
    if (!complete) {
      out.push(rangeRoot(leafHashes, start, end, cache));
    }
    return;
  }
  const k = splitPoint(size);
  if (m <= k) {
    subProof(leafHashes, start, start + k, m, complete, cache, out);
    out.push(rangeRoot(leafHashes, start + k, end, cache));
    return;
  }
  subProof(leafHashes, start + k, end, m - k, false, cache, out);
  out.push(rangeRoot(leafHashes, start, start + k, cache));
}

/**
 * RFC 6962 §2.1.2 `PROOF(m, D[n])` — the prefix-consistency proof that the
 * tree of size `fromSize` is a prefix of this tree (LEDGER §7: "prefix
 * consistency proofs between checkpoints").
 *
 * Returns `[]` for `fromSize === 0` (the empty tree is a prefix of every
 * tree) and for `fromSize === toSize` (identical trees), matching the empty
 * `SUBPROOF(m, D[m], true)` of the RFC.
 */
export function consistencyProof(
  leafHashes: readonly string[],
  fromSize: number,
  cache?: RangeRootCache,
): string[] {
  assertLeafHashes(leafHashes);
  const toSize = leafHashes.length;
  if (!Number.isSafeInteger(fromSize) || fromSize < 0 || fromSize > toSize) {
    throw new Error(
      `fromSize ${String(fromSize)} is out of range for a tree of size ${String(toSize)}`,
    );
  }
  if (fromSize === 0 || fromSize === toSize) {
    return [];
  }
  const out: string[] = [];
  subProof(leafHashes, 0, toSize, fromSize, true, cache, out);
  return out;
}

/**
 * Append-only convenience wrapper around the pure functions above, with a
 * subtree-root cache so repeated checkpoints over a growing stream do not
 * rehash the stable left subtrees. The pure functions remain the contract:
 * this class only memoizes them.
 */
export class MerkleTree {
  private readonly leaves: string[];
  private readonly cache: RangeRootCache = new Map();

  constructor(leafHashes: readonly string[] = []) {
    assertLeafHashes(leafHashes);
    this.leaves = [...leafHashes];
  }

  /** Number of committed leaves; equals the checkpoint `treeSize`. */
  get size(): number {
    return this.leaves.length;
  }

  /** Appends one leaf hash and returns its 0-based leaf index. */
  append(leafHash: string): number {
    this.leaves.push(leafHash);
    return this.leaves.length - 1;
  }

  /** Appends the leaf for one event, returning the leaf hash it committed. */
  appendEntry(sequence: number, entryHash: string): string {
    const leafHash = merkleLeafHash(sequence, entryHash);
    this.append(leafHash);
    return leafHash;
  }

  /** Snapshot of the committed leaf hashes in sequence order. */
  leafHashes(): string[] {
    return [...this.leaves];
  }

  root(): string {
    return merkleRoot(this.leaves, this.cache);
  }

  inclusionProof(leafIndex: number): string[] {
    return inclusionProof(this.leaves, leafIndex, this.cache);
  }

  consistencyProof(fromSize: number): string[] {
    return consistencyProof(this.leaves, fromSize, this.cache);
  }

  /** MTH of the first `size` leaves — the root a past checkpoint committed. */
  rootAt(size: number): string {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.leaves.length) {
      throw new Error(
        `size ${String(size)} is out of range for a tree of size ${String(this.leaves.length)}`,
      );
    }
    return rangeRoot(this.leaves, 0, size, this.cache);
  }
}
