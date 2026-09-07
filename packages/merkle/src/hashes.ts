/**
 * Merkle leaf and interior-node hash construction (LEDGER-INTEGRITY-DESIGN.md
 * §7, docs/evidence-bundle-format.md §5).
 *
 * ```text
 * leafHash = SHA-256("dtsf-merkle-leaf-v1" || 0x00 || uint64BE(sequence) || rawBytes(entryHash))
 * nodeHash = SHA-256("dtsf-merkle-node-v1" || 0x01 || rawBytes(left) || rawBytes(right))
 * ```
 *
 * Leaves bind the sequence number as well as the entry hash, so a reordered
 * or renumbered event cannot reuse an existing leaf (LEDGER §7, §17).
 */
import { decodeHash, domainHash, uint64BE } from '@ald/hashing';
import { HASH_DOMAINS } from '@ald/types';

/**
 * Root of a tree with no leaves: the merkle-node domain and its 0x01
 * separator hashed over zero children (docs/evidence-bundle-format.md §5).
 * A checkpoint records `treeSize: 0` together with this root for a stream
 * that has no events yet.
 */
export const EMPTY_MERKLE_ROOT = domainHash(HASH_DOMAINS.merkleNode, [], 0x01);

/**
 * LEDGER §7 leaf hash for the event at 1-based `sequence` whose canonical
 * entry hash is `entryHash`. Throws on a non-positive sequence or a hash that
 * is not `sha256:<64 lowercase hex>`.
 */
export function merkleLeafHash(sequence: number, entryHash: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(
      `Merkle leaf sequence must be a positive safe integer, received ${String(sequence)}`,
    );
  }
  return domainHash(
    HASH_DOMAINS.merkleLeaf,
    [uint64BE(sequence), decodeHash(entryHash)],
    0x00,
  );
}

/** LEDGER §7 interior-node hash. Separator byte is 0x01, never 0x00. */
export function merkleNodeHash(left: string, right: string): string {
  return domainHash(
    HASH_DOMAINS.merkleNode,
    [decodeHash(left), decodeHash(right)],
    0x01,
  );
}

/** One event in stream order, as stored in the Evidence Store. */
export interface MerkleLeafSource {
  sequence: number;
  entryHash: string;
}

/**
 * Leaf hashes for a contiguous run of events in ascending sequence order.
 * Rejects gaps, duplicates, and descending sequences, because tree size alone
 * does not describe the committed prefix (LEDGER §7).
 */
export function merkleLeafHashes(
  entries: readonly MerkleLeafSource[],
): string[] {
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    if (previous !== undefined && entry.sequence !== previous.sequence + 1) {
      throw new Error(
        `Merkle leaves must be a contiguous ascending sequence: ${String(previous.sequence)} → ${String(entry.sequence)}`,
      );
    }
    return merkleLeafHash(entry.sequence, entry.entryHash);
  });
}
