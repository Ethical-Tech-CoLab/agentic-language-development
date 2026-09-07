/**
 * The mapping between event streams, checkpoint tree names, and the
 * `TreeReference` a manifest commits for each one
 * (LEDGER-INTEGRITY-DESIGN.md §7, §8; docs/evidence-bundle-format.md §5, §6).
 *
 * `intervention` is hash-chained and exported but is not a checkpoint tree,
 * because the v1 schema stores it unsigned (`packages/types/src/domains.ts`),
 * so every function here rejects it.
 */
import { EMPTY_MERKLE_ROOT, merkleLeafHashes, merkleRoot } from '@ald/merkle';
import {
  AUXILIARY_TREES,
  EVENT_STREAMS,
  GENESIS_HASH,
  MANDATORY_TREES,
  type CheckpointManifest,
  type CheckpointTreeName,
  type EventStream,
  type StoredEvent,
  type TreeReference,
  type UnsignedCheckpointManifest,
} from '@ald/types';

import { CheckpointIntegrityError, InvalidCheckpointRequestError } from './errors.js';

/** Streams that carry a Merkle root in a checkpoint manifest. */
export type CheckpointStream = Exclude<EventStream, 'intervention'>;

/** Every checkpointed stream, in the canonical `EVENT_STREAMS` order. */
export const CHECKPOINT_STREAMS: readonly CheckpointStream[] =
  EVENT_STREAMS.filter(
    (stream): stream is CheckpointStream => stream !== 'intervention',
  );

const MANDATORY_STREAMS = Object.keys(
  MANDATORY_TREES,
) as (keyof typeof MANDATORY_TREES)[];

const AUXILIARY_STREAMS = Object.keys(
  AUXILIARY_TREES,
) as (keyof typeof AUXILIARY_TREES)[];

function isMandatory(
  stream: CheckpointStream,
): stream is keyof typeof MANDATORY_TREES {
  return (MANDATORY_STREAMS as CheckpointStream[]).includes(stream);
}

/**
 * Narrows an arbitrary stream to a checkpointed one. `intervention` is
 * refused rather than silently skipped, so a caller asking for an
 * intervention-log proof gets a clear error.
 */
export function assertCheckpointStream(stream: EventStream): CheckpointStream {
  if (stream === 'intervention') {
    throw new InvalidCheckpointRequestError(
      'the intervention stream is hash-chained but is not a checkpoint tree',
    );
  }
  return stream;
}

/** The LEDGER §8 tree name a stream is committed under. */
export function treeNameFor(input: EventStream): CheckpointTreeName {
  const stream = assertCheckpointStream(input);
  return isMandatory(stream)
    ? MANDATORY_TREES[stream]
    : AUXILIARY_TREES[stream as keyof typeof AUXILIARY_TREES];
}

/** The empty-stream reference: size 0, the empty root, and the genesis hash. */
export const EMPTY_TREE_REFERENCE: TreeReference = {
  treeSize: 0,
  merkleRoot: EMPTY_MERKLE_ROOT,
  lastEntryHash: GENESIS_HASH,
};

/** One stream's committed prefix plus the leaves the root was built from. */
export interface TreeSnapshot {
  stream: CheckpointStream;
  treeName: CheckpointTreeName;
  reference: TreeReference;
  leafHashes: string[];
}

/**
 * Asserts the stored prefix is exactly `1..events.length` with no gap. A gap
 * means the tree size does not describe the committed prefix (LEDGER §7), so
 * no checkpoint may be built over it.
 */
export function assertContiguousPrefix(
  stream: EventStream,
  events: readonly StoredEvent[],
): void {
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      throw new CheckpointIntegrityError(
        `stream ${stream} is not a contiguous prefix: expected sequence ${String(index + 1)}, stored ${String(event.sequence)}`,
      );
    }
  });
}

/** Builds the `TreeReference` and leaf hashes for one stream's stored prefix. */
export function snapshotFromEvents(
  stream: CheckpointStream,
  events: readonly StoredEvent[],
): TreeSnapshot {
  assertContiguousPrefix(stream, events);
  const leafHashes = merkleLeafHashes(events);
  const last = events.at(-1);
  return {
    stream,
    treeName: treeNameFor(stream),
    leafHashes,
    reference: {
      treeSize: events.length,
      merkleRoot: merkleRoot(leafHashes),
      lastEntryHash: last?.entryHash ?? GENESIS_HASH,
    },
  };
}

/**
 * The reference a manifest commits for `stream`. An auxiliary stream absent
 * from `auxiliaryTrees` is committed as empty (LEDGER §8: auxiliary trees
 * appear only once they hold at least one event).
 */
export function referenceFor(
  manifest: UnsignedCheckpointManifest,
  stream: EventStream,
): TreeReference {
  const treeName = treeNameFor(stream);
  switch (treeName) {
    case 'babyA':
      return manifest.babyA;
    case 'babyB':
      return manifest.babyB;
    case 'channel':
      return manifest.channel;
    default:
      return manifest.auxiliaryTrees[treeName] ?? EMPTY_TREE_REFERENCE;
  }
}

/** The auxiliary-tree map for a checkpoint: only non-empty streams appear. */
export function auxiliaryTreesFrom(
  snapshots: readonly TreeSnapshot[],
): Record<string, TreeReference> {
  const auxiliary: Record<string, TreeReference> = {};
  for (const stream of AUXILIARY_STREAMS) {
    const snapshot = snapshots.find((entry) => entry.stream === stream);
    if (snapshot !== undefined && snapshot.reference.treeSize > 0) {
      auxiliary[snapshot.treeName] = snapshot.reference;
    }
  }
  return auxiliary;
}

function mandatorySnapshot(
  snapshots: readonly TreeSnapshot[],
  stream: keyof typeof MANDATORY_TREES,
): TreeSnapshot {
  const snapshot = snapshots.find((entry) => entry.stream === stream);
  if (snapshot === undefined) {
    throw new CheckpointIntegrityError(
      `mandatory checkpoint tree ${MANDATORY_TREES[stream]} is missing from the snapshot`,
    );
  }
  return snapshot;
}

/** The three mandatory trees of LEDGER §8, in manifest order. */
export function mandatoryTreesFrom(snapshots: readonly TreeSnapshot[]): {
  babyA: TreeReference;
  babyB: TreeReference;
  channel: TreeReference;
} {
  return {
    babyA: mandatorySnapshot(snapshots, 'baby-a-ledger').reference,
    babyB: mandatorySnapshot(snapshots, 'baby-b-ledger').reference,
    channel: mandatorySnapshot(snapshots, 'channel').reference,
  };
}

/**
 * LEDGER §17: the prefix a previous checkpoint committed must still be in the
 * store, unchanged, when the next checkpoint is built. A shrinking tree or a
 * prefix whose root no longer matches is a rewrite, and no new checkpoint may
 * paper over it with a freshly recomputed root.
 */
export function assertPrefixUnchanged(
  previous: CheckpointManifest,
  snapshots: readonly TreeSnapshot[],
): void {
  for (const snapshot of snapshots) {
    const committed = referenceFor(previous, snapshot.stream);
    if (committed.treeSize > snapshot.reference.treeSize) {
      throw new CheckpointIntegrityError(
        `${snapshot.treeName} shrank from ${String(committed.treeSize)} at checkpoint ${String(previous.checkpointSequence)} to ${String(snapshot.reference.treeSize)}`,
      );
    }
    if (committed.treeSize === 0) {
      continue;
    }
    const prefixRoot = merkleRoot(
      snapshot.leafHashes.slice(0, committed.treeSize),
    );
    if (prefixRoot !== committed.merkleRoot) {
      throw new CheckpointIntegrityError(
        `checkpoint ${String(previous.checkpointSequence)} committed ${snapshot.treeName} root ${committed.merkleRoot}, but the stored prefix of size ${String(committed.treeSize)} now yields ${prefixRoot}`,
      );
    }
  }
}

/**
 * ALD-013 criterion 3: a manifest must declare exactly the trees the Evidence
 * Store holds, with exactly the sizes, roots, and last hashes ALD-012
 * recomputes. A missing tree, an extra tree, or any mismatched field is an
 * integrity failure rather than a warning.
 */
export function assertManifestTrees(
  manifest: UnsignedCheckpointManifest | CheckpointManifest,
  snapshots: readonly TreeSnapshot[],
): void {
  const expectedAuxiliary = auxiliaryTreesFrom(snapshots);
  const declared = Object.keys(manifest.auxiliaryTrees).sort();
  const expected = Object.keys(expectedAuxiliary).sort();
  for (const treeName of declared) {
    if (!expected.includes(treeName)) {
      throw new CheckpointIntegrityError(
        `checkpoint declares auxiliary tree ${treeName}, which the Evidence Store does not hold`,
      );
    }
  }
  for (const treeName of expected) {
    if (!declared.includes(treeName)) {
      throw new CheckpointIntegrityError(
        `checkpoint is missing auxiliary tree ${treeName}, which the Evidence Store holds`,
      );
    }
  }
  for (const snapshot of snapshots) {
    const committed = referenceFor(manifest, snapshot.stream);
    // An empty stream's snapshot reference is exactly EMPTY_TREE_REFERENCE,
    // which is also what `referenceFor` returns for an absent auxiliary tree.
    const expectedReference = snapshot.reference;
    if (
      committed.treeSize !== expectedReference.treeSize ||
      committed.merkleRoot !== expectedReference.merkleRoot ||
      committed.lastEntryHash !== expectedReference.lastEntryHash
    ) {
      throw new CheckpointIntegrityError(
        `checkpoint tree ${snapshot.treeName} commits ` +
          `size ${String(committed.treeSize)} root ${committed.merkleRoot}, ` +
          `but the Evidence Store yields size ${String(expectedReference.treeSize)} root ${expectedReference.merkleRoot}`,
      );
    }
  }
}
