/**
 * Schema-validated proof records for the evidence bundle: the JSON documents
 * a checkpoint or verifier exchanges, built from a tree plus the metadata
 * that identifies which stream and checkpoint the proof belongs to
 * (LEDGER-INTEGRITY-DESIGN.md §7, §13; docs/evidence-bundle-format.md §5).
 *
 * Both builders validate with the authoritative schemas from `@ald/types`
 * before returning, and both recompute the roots from the supplied leaves, so
 * a record can never carry a root that its own leaves do not produce.
 */
import {
  ConsistencyProofSchema,
  InclusionProofSchema,
  type ConsistencyProof,
  type EventStream,
  type InclusionProof,
} from '@ald/types';

import { merkleLeafHash } from './hashes.js';
import {
  consistencyProof,
  inclusionProof,
  merkleRoot,
  type RangeRootCache,
} from './tree.js';

export interface InclusionProofRecordInput {
  /** Event stream the leaf belongs to (LEDGER §6). */
  stream: EventStream;
  /** Checkpoint tree name the root is committed under (LEDGER §8). */
  treeName: string;
  /** Checkpoint whose root this proof is verified against. */
  checkpointSequence: number;
  /** 1-based event sequence; `leafIndex` is `sequence - 1`. */
  sequence: number;
  /** Canonical entry hash of that event. */
  entryHash: string;
  /** Leaf hashes of the committed prefix, in sequence order. */
  leafHashes: readonly string[];
  cache?: RangeRootCache;
}

export interface ConsistencyProofRecordInput {
  stream: EventStream;
  treeName: string;
  fromCheckpointSequence: number;
  toCheckpointSequence: number;
  /** Tree size committed by the earlier checkpoint. */
  fromSize: number;
  /** Leaf hashes of the later (larger) tree, in sequence order. */
  leafHashes: readonly string[];
  cache?: RangeRootCache;
}

/**
 * Builds an `InclusionProofSchema` record for one event. Throws if the leaf
 * derived from `sequence`/`entryHash` is not the leaf the tree committed at
 * that index — that mismatch means the event content, its sequence, or the
 * tree is wrong (LEDGER §17).
 */
export function buildInclusionProofRecord(
  input: InclusionProofRecordInput,
): InclusionProof {
  const { leafHashes, sequence, entryHash, cache } = input;
  const leafIndex = sequence - 1;
  const leafHash = merkleLeafHash(sequence, entryHash);
  const committed = leafHashes[leafIndex];
  if (committed === undefined) {
    throw new Error(
      `sequence ${String(sequence)} is outside the committed tree of size ${String(leafHashes.length)}`,
    );
  }
  if (committed !== leafHash) {
    throw new Error(
      `leaf hash mismatch at sequence ${String(sequence)}: tree committed ${committed}, event yields ${leafHash}`,
    );
  }
  return InclusionProofSchema.parse({
    version: 1,
    stream: input.stream,
    treeName: input.treeName,
    checkpointSequence: input.checkpointSequence,
    treeSize: leafHashes.length,
    leafIndex,
    sequence,
    entryHash,
    leafHash,
    path: inclusionProof(leafHashes, leafIndex, cache),
    root: merkleRoot(leafHashes, cache),
  });
}

/**
 * Builds a `ConsistencyProofSchema` record between two checkpoint sizes of
 * the same stream. `fromRoot` is recomputed from the first `fromSize` leaves,
 * so it matches the earlier checkpoint only when the prefix is unchanged.
 */
export function buildConsistencyProofRecord(
  input: ConsistencyProofRecordInput,
): ConsistencyProof {
  const { leafHashes, fromSize, cache } = input;
  const toSize = leafHashes.length;
  if (!Number.isSafeInteger(fromSize) || fromSize < 0 || fromSize > toSize) {
    throw new Error(
      `fromSize ${String(fromSize)} is out of range for a tree of size ${String(toSize)}`,
    );
  }
  return ConsistencyProofSchema.parse({
    version: 1,
    stream: input.stream,
    treeName: input.treeName,
    fromCheckpointSequence: input.fromCheckpointSequence,
    toCheckpointSequence: input.toCheckpointSequence,
    fromSize,
    toSize,
    fromRoot: merkleRoot(leafHashes.slice(0, fromSize), cache),
    toRoot: merkleRoot(leafHashes, cache),
    path: consistencyProof(leafHashes, fromSize, cache),
  });
}
