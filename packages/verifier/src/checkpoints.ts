/**
 * Checkpoint and Merkle verification: steps 6-9 of
 * LEDGER-INTEGRITY-DESIGN.md §14 — rebuild every ordered Merkle root from the
 * disclosed JSONL, verify inclusion and consistency proofs, rebuild every
 * checkpoint hash, and verify the Nursery witness signatures (LEDGER §7, §8;
 * docs/evidence-bundle-format.md §5, §6).
 *
 * Nothing here trusts a value that a tamperer could have rewritten: roots are
 * recomputed from the events, a proof's `leafHash` is recomputed from the
 * disclosed event at that sequence, and a proof's root is compared with the
 * root the referenced checkpoint actually committed.
 */
import { hashCanonical, omitFields, verifyHashSignature } from '@ald/hashing';
import {
  EMPTY_MERKLE_ROOT,
  merkleLeafHash,
  merkleLeafHashes,
  merkleRoot,
  verifyConsistency,
  verifyInclusion,
} from '@ald/merkle';
import {
  CheckpointManifestSchema,
  ConsistencyProofSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  InclusionProofSchema,
  MANIFEST_SIGNATURE_FIELDS,
  type CheckpointManifest,
  type EventStream,
  type RunManifest,
  type TreeReference,
} from '@ald/types';

import {
  bundlePath,
  formatIssues,
  listJsonFiles,
  readCanonicalJsonFile,
} from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedStreams } from './streams.js';
import { normalizeHash } from './values.js';

/** One tree committed by one checkpoint, after the rebuild attempt. */
export interface CheckpointTree {
  treeName: string;
  stream: EventStream | undefined;
  treeSize: number;
  /** Root as committed by the checkpoint manifest. */
  storedRoot: string;
  /** Leaf hashes recomputed from the disclosed events, empty when unusable. */
  leafHashes: string[];
  /** `true` when the committed root and last entry hash were reproduced. */
  rebuilt: boolean;
}

export interface LoadedCheckpoint {
  file: string;
  sequence: number;
  manifest: CheckpointManifest;
  trees: Map<string, CheckpointTree>;
}

/** `treeName` → stream, from `run-manifest.json` `streams[]` (bundle §7). */
export function treeNameIndex(manifest: RunManifest): Map<string, EventStream> {
  const index = new Map<string, EventStream>();
  for (const declaration of manifest.streams) {
    if (declaration.treeName !== undefined) {
      index.set(declaration.treeName, declaration.stream);
    }
  }
  return index;
}

function signerDomainForTree(
  manifest: RunManifest,
  treeName: string,
): string | undefined {
  return manifest.streams.find(
    (declaration) => declaration.treeName === treeName,
  )?.signerDomain;
}

/**
 * Rebuilds one tree of one checkpoint from the disclosed events and compares
 * the result with the committed `treeSize`, `merkleRoot`, and `lastEntryHash`
 * (LEDGER §7: a root without a size does not describe the prefix).
 */
function rebuildTree(
  checkpointSequence: number,
  treeName: string,
  reference: TreeReference,
  stream: EventStream | undefined,
  streams: LoadedStreams,
  accumulator: VerificationAccumulator,
): CheckpointTree {
  const at = `checkpoint ${String(checkpointSequence)} tree ${treeName}`;
  const tree: CheckpointTree = {
    treeName,
    stream,
    treeSize: reference.treeSize,
    storedRoot: reference.merkleRoot,
    leafHashes: [],
    rebuilt: false,
  };

  if (stream === undefined) {
    accumulator.fail(
      'merkleRootsRebuilt',
      'undeclared-tree',
      `${at}: no stream in run-manifest.json declares this treeName`,
    );
    return tree;
  }

  const loaded = streams.get(stream);
  if (loaded === undefined) {
    accumulator.fail(
      'merkleRootsRebuilt',
      'undeclared-tree',
      `${at}: stream ${stream} is not exported by this bundle`,
    );
    return tree;
  }

  if (reference.treeSize > loaded.size) {
    accumulator.fail(
      'merkleRootsRebuilt',
      'tree-size-exceeds-stream',
      `${at}: treeSize ${String(reference.treeSize)} exceeds the ${String(loaded.size)} events in ${stream}`,
    );
    return tree;
  }

  const prefix = loaded.entries.slice(0, reference.treeSize);
  if (prefix.length !== reference.treeSize) {
    accumulator.fail(
      'merkleRootsRebuilt',
      'tree-prefix-unusable',
      `${at}: only ${String(prefix.length)} of ${String(reference.treeSize)} events carry a usable sequence and entryHash`,
    );
    return tree;
  }

  let leafHashes: string[];
  try {
    leafHashes = merkleLeafHashes(prefix);
  } catch (error) {
    accumulator.fail(
      'merkleRootsRebuilt',
      'tree-prefix-unusable',
      `${at}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return tree;
  }
  tree.leafHashes = leafHashes;

  const rebuiltRoot =
    reference.treeSize === 0 ? EMPTY_MERKLE_ROOT : merkleRoot(leafHashes);
  const expectedLastEntryHash =
    reference.treeSize === 0
      ? GENESIS_HASH
      : (prefix[reference.treeSize - 1]?.entryHash ?? GENESIS_HASH);

  let ok = true;
  if (normalizeHash(reference.merkleRoot) !== rebuiltRoot) {
    ok = false;
    accumulator.fail(
      'merkleRootsRebuilt',
      'merkle-root-mismatch',
      `${at}: committed ${reference.merkleRoot} but ${String(reference.treeSize)} disclosed events rebuild to ${rebuiltRoot}`,
    );
  }
  if (normalizeHash(reference.lastEntryHash) !== expectedLastEntryHash) {
    ok = false;
    accumulator.fail(
      'merkleRootsRebuilt',
      'last-entry-hash-mismatch',
      `${at}: committed lastEntryHash ${reference.lastEntryHash}, disclosed prefix ends at ${expectedLastEntryHash}`,
    );
  }
  tree.rebuilt = ok;
  return tree;
}

/**
 * Reads `checkpoints/*.json` in name order and verifies the checkpoint series
 * itself: contiguous sequences from 0, the previous-hash chain from genesis,
 * the rebuilt `checkpointHash`, the witness signature, the run bindings, and
 * every mandatory and auxiliary tree.
 */
export async function verifyCheckpoints(
  bundleDir: string,
  manifest: RunManifest,
  streams: LoadedStreams,
  accumulator: VerificationAccumulator,
): Promise<LoadedCheckpoint[]> {
  const directory = bundlePath(bundleDir, 'checkpoints');
  const files = await listJsonFiles(directory);
  const trees = treeNameIndex(manifest);
  const witnessKey = manifest.signers.find(
    (signer) => signer.domain === 'witness',
  )?.publicKey;
  const checkpoints: LoadedCheckpoint[] = [];
  const highestTreeSize = new Map<string, number>();
  let previousCheckpointHash = GENESIS_HASH;
  let expectedSequence = 0;

  if (files.length === 0) {
    accumulator.failStructural(
      'no-checkpoints',
      'checkpoints/ contains no manifest; the run has no committed prefix',
    );
    return checkpoints;
  }

  for (const file of files) {
    const relative = `checkpoints/${file}`;
    const raw = await readCanonicalJsonFile(bundlePath(directory, file));
    if (!raw.ok) {
      if (raw.code === 'canonical-json-invalid') {
        accumulator.fail('canonicalJsonValid', raw.code, `${relative}: ${raw.detail}`);
      } else {
        accumulator.failStructural(raw.code, `${relative}: ${raw.detail}`);
      }
      continue;
    }

    const parsed = CheckpointManifestSchema.safeParse(raw.value);
    if (!parsed.success) {
      accumulator.failStructural(
        'schema-invalid',
        `${relative}: ${formatIssues(parsed.error.issues)}`,
      );
      continue;
    }
    const checkpoint = parsed.data;

    if (checkpoint.checkpointSequence !== expectedSequence) {
      accumulator.failStructural(
        'checkpoint-sequence-gap',
        `${relative}: expected checkpointSequence ${String(expectedSequence)}, found ${String(checkpoint.checkpointSequence)}`,
      );
    }
    expectedSequence = checkpoint.checkpointSequence + 1;

    if (checkpoint.previousCheckpointHash !== previousCheckpointHash) {
      accumulator.failStructural(
        'checkpoint-chain-mismatch',
        `${relative}: previousCheckpointHash ${checkpoint.previousCheckpointHash} does not match ${previousCheckpointHash}`,
      );
    }

    const rebuiltHash = hashCanonical(
      HASH_DOMAINS.checkpoint,
      omitFields(checkpoint, MANIFEST_SIGNATURE_FIELDS),
    );
    if (rebuiltHash !== checkpoint.checkpointHash) {
      accumulator.fail(
        'checkpointHashesRebuilt',
        'checkpoint-hash-mismatch',
        `${relative}: stored ${checkpoint.checkpointHash} does not match rebuilt ${rebuiltHash}`,
      );
    }

    if (witnessKey === undefined) {
      accumulator.fail(
        'witnessSignaturesValid',
        'missing-witness-key',
        `${relative}: run-manifest.json declares no witness public key`,
      );
    } else if (
      !verifyHashSignature(
        checkpoint.checkpointHash,
        checkpoint.witnessSignature,
        witnessKey,
      )
    ) {
      accumulator.fail(
        'witnessSignaturesValid',
        'witness-signature-invalid',
        `${relative}: witnessSignature does not verify under ${witnessKey}`,
      );
    }

    if (checkpoint.runIdHash !== manifest.runIdHash) {
      accumulator.failStructural(
        'checkpoint-run-mismatch',
        `${relative}: runIdHash ${checkpoint.runIdHash} does not match the run manifest`,
      );
    }
    if (normalizeHash(checkpoint.runConfigurationHash) !== normalizeHash(manifest.configurationHash)) {
      accumulator.failStructural(
        'checkpoint-configuration-mismatch',
        `${relative}: runConfigurationHash ${checkpoint.runConfigurationHash} does not match the run manifest`,
      );
    }

    const references: [string, TreeReference][] = [
      ['babyA', checkpoint.babyA],
      ['babyB', checkpoint.babyB],
      ['channel', checkpoint.channel],
    ];
    for (const [treeName, reference] of Object.entries(checkpoint.auxiliaryTrees)) {
      // Bundle format §6: an auxiliary tree must be a declared stream with a
      // signer whose public key is listed in the run manifest.
      const declaredStream = trees.get(treeName);
      const signerDomain = signerDomainForTree(manifest, treeName);
      const signerPresent =
        signerDomain !== undefined &&
        manifest.signers.some((signer) => signer.domain === signerDomain);
      if (declaredStream === undefined || !signerPresent) {
        accumulator.fail(
          'merkleRootsRebuilt',
          'undeclared-auxiliary-tree',
          `${relative}: auxiliary tree ${treeName} is not declared in run-manifest.json with a listed signer`,
        );
        continue;
      }
      references.push([treeName, reference]);
    }

    const checkpointTrees = new Map<string, CheckpointTree>();
    for (const [treeName, reference] of references) {
      const tree = rebuildTree(
        checkpoint.checkpointSequence,
        treeName,
        reference,
        trees.get(treeName),
        streams,
        accumulator,
      );
      checkpointTrees.set(treeName, tree);

      const previousSize = highestTreeSize.get(treeName);
      if (previousSize !== undefined && reference.treeSize < previousSize) {
        accumulator.fail(
          'merkleRootsRebuilt',
          'tree-size-decreased',
          `checkpoint ${String(checkpoint.checkpointSequence)} tree ${treeName}: treeSize ${String(reference.treeSize)} is smaller than the ${String(previousSize)} already committed`,
        );
      }
      highestTreeSize.set(
        treeName,
        Math.max(previousSize ?? 0, reference.treeSize),
      );
    }

    previousCheckpointHash = checkpoint.checkpointHash;
    checkpoints.push({
      file: relative,
      sequence: checkpoint.checkpointSequence,
      manifest: checkpoint,
      trees: checkpointTrees,
    });
  }

  return checkpoints;
}

function checkpointBySequence(
  checkpoints: readonly LoadedCheckpoint[],
  sequence: number,
): LoadedCheckpoint | undefined {
  return checkpoints.find((checkpoint) => checkpoint.sequence === sequence);
}

/**
 * Verifies every proof file the bundle discloses (bundle format §5). A proof
 * that references a checkpoint, tree, or event the bundle does not contain is
 * a failure, not a skip; with no proof files at all both checks stay `true`
 * and the report records an informational gap.
 */
export async function verifyProofs(
  bundleDir: string,
  checkpoints: readonly LoadedCheckpoint[],
  streams: LoadedStreams,
  accumulator: VerificationAccumulator,
): Promise<number> {
  const inclusionDir = bundlePath(bundleDir, 'proofs', 'inclusion');
  const consistencyDir = bundlePath(bundleDir, 'proofs', 'consistency');
  const inclusionFiles = await listJsonFiles(inclusionDir);
  const consistencyFiles = await listJsonFiles(consistencyDir);

  if (inclusionFiles.length === 0 && consistencyFiles.length === 0) {
    accumulator.gap(
      'no-proof-files-present',
      'proofs/inclusion and proofs/consistency are empty; roots were rebuilt from the disclosed events only',
    );
    return 0;
  }

  for (const file of inclusionFiles) {
    const relative = `proofs/inclusion/${file}`;
    const raw = await readCanonicalJsonFile(bundlePath(inclusionDir, file));
    if (!raw.ok) {
      if (raw.code === 'canonical-json-invalid') {
        accumulator.fail('canonicalJsonValid', raw.code, `${relative}: ${raw.detail}`);
      } else {
        accumulator.failStructural(raw.code, `${relative}: ${raw.detail}`);
      }
      continue;
    }
    const parsed = InclusionProofSchema.safeParse(raw.value);
    if (!parsed.success) {
      accumulator.fail(
        'inclusionProofsValid',
        'schema-invalid',
        `${relative}: ${formatIssues(parsed.error.issues)}`,
      );
      continue;
    }
    const proof = parsed.data;
    const fail = (code: string, detail: string): void => {
      accumulator.fail('inclusionProofsValid', code, `${relative}: ${detail}`);
    };

    const checkpoint = checkpointBySequence(checkpoints, proof.checkpointSequence);
    if (checkpoint === undefined) {
      fail(
        'inclusion-proof-checkpoint-unknown',
        `checkpoint ${String(proof.checkpointSequence)} is not in this bundle`,
      );
      continue;
    }
    const tree = checkpoint.trees.get(proof.treeName);
    if (tree === undefined) {
      fail(
        'inclusion-proof-tree-unknown',
        `checkpoint ${String(proof.checkpointSequence)} commits no tree ${proof.treeName}`,
      );
      continue;
    }
    if (tree.stream !== proof.stream) {
      fail(
        'inclusion-proof-stream-mismatch',
        `tree ${proof.treeName} commits ${String(tree.stream)}, not ${proof.stream}`,
      );
      continue;
    }
    if (proof.treeSize !== tree.treeSize) {
      fail(
        'inclusion-proof-tree-size-mismatch',
        `treeSize ${String(proof.treeSize)} does not match the committed ${String(tree.treeSize)}`,
      );
      continue;
    }
    if (proof.leafIndex !== proof.sequence - 1) {
      fail(
        'inclusion-proof-leaf-index-mismatch',
        `leafIndex ${String(proof.leafIndex)} is not sequence ${String(proof.sequence)} - 1`,
      );
      continue;
    }
    const entry = streams.get(proof.stream)?.bySequence.get(proof.sequence);
    if (entry === undefined) {
      fail(
        'inclusion-proof-event-missing',
        `${proof.stream}#${String(proof.sequence)} is not in this bundle`,
      );
      continue;
    }
    if (normalizeHash(proof.entryHash) !== entry.entryHash) {
      fail(
        'inclusion-proof-entry-hash-mismatch',
        `entryHash ${proof.entryHash} does not match the disclosed ${entry.entryHash}`,
      );
      continue;
    }
    let leafHash: string;
    try {
      leafHash = merkleLeafHash(proof.sequence, entry.entryHash);
    } catch (error) {
      fail(
        'inclusion-proof-leaf-unusable',
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (proof.leafHash !== leafHash) {
      fail(
        'inclusion-proof-leaf-mismatch',
        `leafHash ${proof.leafHash} is not the leaf of the disclosed event (${leafHash})`,
      );
      continue;
    }
    if (normalizeHash(proof.root) !== normalizeHash(tree.storedRoot)) {
      fail(
        'inclusion-proof-root-mismatch',
        `root ${proof.root} is not the root committed by checkpoint ${String(checkpoint.sequence)} (${tree.storedRoot})`,
      );
      continue;
    }
    if (
      !verifyInclusion({
        leafHash,
        leafIndex: proof.sequence - 1,
        treeSize: proof.treeSize,
        path: proof.path,
        root: proof.root,
      })
    ) {
      fail(
        'inclusion-proof-invalid',
        `audit path does not reproduce root ${proof.root} for ${proof.stream}#${String(proof.sequence)}`,
      );
    }
  }

  for (const file of consistencyFiles) {
    const relative = `proofs/consistency/${file}`;
    const raw = await readCanonicalJsonFile(bundlePath(consistencyDir, file));
    if (!raw.ok) {
      if (raw.code === 'canonical-json-invalid') {
        accumulator.fail('canonicalJsonValid', raw.code, `${relative}: ${raw.detail}`);
      } else {
        accumulator.failStructural(raw.code, `${relative}: ${raw.detail}`);
      }
      continue;
    }
    const parsed = ConsistencyProofSchema.safeParse(raw.value);
    if (!parsed.success) {
      accumulator.fail(
        'consistencyProofsValid',
        'schema-invalid',
        `${relative}: ${formatIssues(parsed.error.issues)}`,
      );
      continue;
    }
    const proof = parsed.data;
    const fail = (code: string, detail: string): void => {
      accumulator.fail('consistencyProofsValid', code, `${relative}: ${detail}`);
    };

    const from = checkpointBySequence(checkpoints, proof.fromCheckpointSequence);
    const to = checkpointBySequence(checkpoints, proof.toCheckpointSequence);
    if (from === undefined || to === undefined) {
      fail(
        'consistency-proof-checkpoint-unknown',
        `checkpoints ${String(proof.fromCheckpointSequence)} → ${String(proof.toCheckpointSequence)} are not both in this bundle`,
      );
      continue;
    }
    const fromTree = from.trees.get(proof.treeName);
    const toTree = to.trees.get(proof.treeName);
    if (fromTree === undefined || toTree === undefined) {
      fail(
        'consistency-proof-tree-unknown',
        `tree ${proof.treeName} is not committed by both checkpoints`,
      );
      continue;
    }
    if (proof.fromSize !== fromTree.treeSize || proof.toSize !== toTree.treeSize) {
      fail(
        'consistency-proof-size-mismatch',
        `sizes ${String(proof.fromSize)} → ${String(proof.toSize)} do not match the committed ${String(fromTree.treeSize)} → ${String(toTree.treeSize)}`,
      );
      continue;
    }
    if (
      normalizeHash(proof.fromRoot) !== normalizeHash(fromTree.storedRoot) ||
      normalizeHash(proof.toRoot) !== normalizeHash(toTree.storedRoot)
    ) {
      fail(
        'consistency-proof-root-mismatch',
        `roots do not match the checkpoints (${fromTree.storedRoot} → ${toTree.storedRoot})`,
      );
      continue;
    }
    if (
      !verifyConsistency({
        fromSize: proof.fromSize,
        toSize: proof.toSize,
        fromRoot: proof.fromRoot,
        toRoot: proof.toRoot,
        path: proof.path,
      })
    ) {
      fail(
        'consistency-proof-invalid',
        `checkpoint ${String(proof.fromCheckpointSequence)} is not a verified prefix of checkpoint ${String(proof.toCheckpointSequence)} for tree ${proof.treeName}`,
      );
    }
  }

  return inclusionFiles.length + consistencyFiles.length;
}
