/**
 * ALD-013 — checkpoint manifest generation, and the proof files the evidence
 * bundle carries (LEDGER-INTEGRITY-DESIGN.md §7, §8, §9; SPECIFICATION.md
 * §11.7, §13.3; docs/evidence-bundle-format.md §5, §6).
 *
 * A checkpoint is a signed statement about every hash-chained stream of one
 * run at one instant: for each stream its tree size, its RFC 6962 root, and
 * its last entry hash, chained to the previous checkpoint's hash so the
 * checkpoint series is itself append-only. Nothing here writes events; the
 * Evidence Writer stays the only component that may append to an event table
 * (SPEC §4.1 item 7) and also owns `insertCheckpointManifest`.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { UnknownRunError } from '@ald/evidence';
import {
  canonicalJson,
  hashCanonical,
  hashRunId,
  parseCanonicalJson,
} from '@ald/hashing';
import {
  buildConsistencyProofRecord,
  buildInclusionProofRecord,
} from '@ald/merkle';
import {
  CheckpointManifestSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  RunConfigSchema,
  UnsignedCheckpointManifestSchema,
  type CheckpointManifest,
  type CheckpointReason,
  type CheckpointService,
  type Clock,
  type ConsistencyProof,
  type EventRange,
  type EventStream,
  type InclusionProof,
  type RunConfig,
  type RunMetadataRecord,
  type SignerRegistry,
  type StoredEvent,
  type TreeReference,
  type UnsignedCheckpointManifest,
} from '@ald/types';

import {
  CheckpointIntegrityError,
  CheckpointNotFoundError,
  CheckpointProofRangeError,
  InvalidCheckpointRequestError,
} from './errors.js';
import {
  CHECKPOINT_STREAMS,
  assertCheckpointStream,
  assertManifestTrees,
  assertPrefixUnchanged,
  auxiliaryTreesFrom,
  mandatoryTreesFrom,
  referenceFor,
  snapshotFromEvents,
  treeNameFor,
  type CheckpointStream,
  type TreeSnapshot,
} from './trees.js';

/**
 * LEDGER §9 triggers that fire on a schedule rather than on a lifecycle
 * event. Only these two are skipped when nothing has been appended since the
 * previous checkpoint, which is what keeps checkpoint event ranges from
 * overlapping (ALD-014 criterion 2).
 */
const INTERVAL_REASONS: readonly CheckpointReason[] = [
  'event-interval',
  'time-interval',
];

/**
 * The slice of the Evidence Store a checkpoint needs: the run's
 * configuration, its checkpoint chain, its events, and the writer-owned
 * insert. `SqliteEvidenceWriter` satisfies it structurally — it is both the
 * reader the roots are recomputed from and the owner of the checkpoint table
 * (SPEC §4.1 item 7). Narrowing it this way also lets a test substitute a
 * reader that reports different events, which is how the rewritten-prefix
 * detector of LEDGER §17 is exercised.
 */
export interface CheckpointEvidenceStore {
  readRunMetadata(runId: string): RunMetadataRecord | undefined;
  readCheckpoints(runId: string): CheckpointManifest[];
  readEvents(
    runId: string,
    stream: EventStream,
    range?: EventRange,
  ): StoredEvent[];
  insertCheckpointManifest(manifest: CheckpointManifest): void;
}

export interface EvidenceCheckpointServiceOptions {
  evidence: CheckpointEvidenceStore;
  /** Per-run registry; the `witness` domain signs every checkpoint (LEDGER §11). */
  signers: SignerRegistry;
  clock: Clock;
  /** Recorded verbatim in `softwareCommit` (LEDGER §8). */
  softwareCommit: string;
}

/** Result of a possibly-skipped checkpoint attempt (ALD-014). */
export interface CheckpointCreationResult {
  /** `false` when an interval trigger found no new events and reused the previous manifest. */
  created: boolean;
  manifest: CheckpointManifest;
  reason: CheckpointReason;
}

export interface WriteProofFilesOptions {
  /**
   * Trees at or below this size get an inclusion proof for every event;
   * larger trees get the first and last sequence only, so a long run's bundle
   * stays a bounded size while still proving both ends of every tree.
   */
  maxInclusionPerTree?: number;
}

export interface WriteProofFilesResult {
  inclusionFiles: number;
  consistencyFiles: number;
}

/** The scheduler only needs this much of the service (ALD-014). */
export interface CheckpointCreator {
  createCheckpointIfChanged(
    runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointCreationResult>;
}

const DEFAULT_MAX_INCLUSION_PER_TREE = 64;

/** Normalizes a `RunConfig` hash field to the strict manifest encoding. */
function toStrictHash(field: string, value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  const lower = hex.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(lower)) {
    throw new InvalidCheckpointRequestError(
      `${field} ${value} is not a sha256 hash`,
    );
  }
  return `sha256:${lower}`;
}

function isIntervalReason(reason: CheckpointReason): boolean {
  return INTERVAL_REASONS.includes(reason);
}

function manifestAt(
  runId: string,
  checkpoints: readonly CheckpointManifest[],
  checkpointSequence: number,
): CheckpointManifest {
  const manifest = checkpoints.find(
    (entry) => entry.checkpointSequence === checkpointSequence,
  );
  if (manifest === undefined) {
    throw new CheckpointNotFoundError(runId, checkpointSequence);
  }
  return manifest;
}

export class EvidenceCheckpointService
  implements CheckpointService, CheckpointCreator
{
  private readonly evidence: CheckpointEvidenceStore;
  private readonly signers: SignerRegistry;
  private readonly clock: Clock;
  private readonly softwareCommit: string;

  constructor(options: EvidenceCheckpointServiceOptions) {
    this.evidence = options.evidence;
    this.signers = options.signers;
    this.clock = options.clock;
    this.softwareCommit = options.softwareCommit;
  }

  // -------------------------------------------------------------------------
  // ALD-013 — manifest generation
  // -------------------------------------------------------------------------

  /**
   * Creates and stores the next checkpoint for `runId`. Interval triggers
   * that find no new events reuse the previous manifest instead of writing a
   * duplicate; every lifecycle reason (`run-initialized`, `pause`,
   * `intervention`, `recovery`, `policy-checkpoint`, `run-sealed`,
   * `run-aborted`) always writes (LEDGER §9).
   */
  async createCheckpoint(
    runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointManifest> {
    return (await this.createCheckpointIfChanged(runId, reason)).manifest;
  }

  /** {@link createCheckpoint} with the skip decision exposed (ALD-014). */
  async createCheckpointIfChanged(
    runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointCreationResult> {
    const metadata = this.evidence.readRunMetadata(runId);
    if (metadata === undefined) {
      throw new UnknownRunError(runId);
    }

    const previous = this.evidence.readCheckpoints(runId).at(-1);
    const snapshots = this.snapshots(runId);
    if (previous !== undefined) {
      assertPrefixUnchanged(previous, snapshots);
    }

    if (
      previous !== undefined &&
      isIntervalReason(reason) &&
      !hasGrown(previous, snapshots)
    ) {
      return { created: false, manifest: previous, reason };
    }

    const config = this.runConfig(metadata.configurationJson);
    const witness = this.signers.signer('witness');
    const unsigned: UnsignedCheckpointManifest =
      UnsignedCheckpointManifestSchema.parse({
        version: 1,
        runIdHash: hashRunId(runId),
        checkpointSequence:
          previous === undefined ? 0 : previous.checkpointSequence + 1,
        previousCheckpointHash: previous?.checkpointHash ?? GENESIS_HASH,
        ...mandatoryTreesFrom(snapshots),
        auxiliaryTrees: auxiliaryTreesFrom(snapshots),
        runConfigurationHash: metadata.configurationHash,
        promptBundleHash: toStrictHash(
          'promptBundleHash',
          config.promptBundleHash,
        ),
        softwareCommit: this.softwareCommit,
        createdAt: this.clock.now(),
        witnessKeyId: witness.keyId,
        reason,
      } satisfies UnsignedCheckpointManifest);

    // ALD-013 criterion 3: refuse to sign a manifest whose trees are not
    // exactly the trees the Evidence Store holds.
    assertManifestTrees(unsigned, snapshots);

    const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
    const manifest = CheckpointManifestSchema.parse({
      ...unsigned,
      checkpointHash,
      witnessSignature: await witness.sign(checkpointHash),
    });

    this.evidence.insertCheckpointManifest(manifest);
    return { created: true, manifest, reason };
  }

  /**
   * Recomputes every tree from the Evidence Store and asserts `manifest`
   * commits exactly those trees. Called before each manifest is signed and
   * usable on its own to re-audit a stored checkpoint.
   */
  verifyManifestTrees(runId: string, manifest: CheckpointManifest): void {
    assertManifestTrees(manifest, this.snapshots(runId));
  }

  // -------------------------------------------------------------------------
  // Proofs (LEDGER §7)
  // -------------------------------------------------------------------------

  /**
   * RFC 6962 inclusion proof for one event against the tree a checkpoint
   * committed. Throws if the sequence is outside that committed prefix, and
   * if the recomputed root is not the root the checkpoint carries.
   */
  inclusionProof(
    runId: string,
    stream: EventStream,
    sequence: number,
    checkpointSequence: number,
  ): InclusionProof {
    const checkpointStream = assertCheckpointStream(stream);
    const treeName = treeNameFor(checkpointStream);
    const manifest = this.checkpointAt(runId, checkpointSequence);
    const reference = referenceFor(manifest, checkpointStream);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > reference.treeSize
    ) {
      throw new CheckpointProofRangeError(
        `sequence ${String(sequence)} is outside ${treeName} tree of size ${String(reference.treeSize)} at checkpoint ${String(checkpointSequence)}`,
      );
    }

    const events = this.prefix(runId, checkpointStream, reference.treeSize);
    const target = events[sequence - 1];
    if (target === undefined) {
      throw new CheckpointIntegrityError(
        `stream ${stream} no longer holds sequence ${String(sequence)} committed by checkpoint ${String(checkpointSequence)}`,
      );
    }
    const snapshot = snapshotFromEvents(checkpointStream, events);
    const record = buildInclusionProofRecord({
      stream,
      treeName,
      checkpointSequence,
      sequence,
      entryHash: target.entryHash,
      leafHashes: snapshot.leafHashes,
    });
    if (record.root !== reference.merkleRoot) {
      throw new CheckpointIntegrityError(
        `checkpoint ${String(checkpointSequence)} committed ${treeName} root ${reference.merkleRoot}, but the stored prefix of size ${String(reference.treeSize)} yields ${record.root}`,
      );
    }
    return record;
  }

  /**
   * RFC 6962 prefix-consistency proof between two checkpoints of the same
   * stream. Both endpoints are checked against the roots the checkpoints
   * stored, so a rewritten prefix is caught here rather than being papered
   * over by a freshly recomputed root (LEDGER §17).
   */
  consistencyProof(
    runId: string,
    stream: EventStream,
    fromCheckpointSequence: number,
    toCheckpointSequence: number,
  ): ConsistencyProof {
    const checkpointStream = assertCheckpointStream(stream);
    const treeName = treeNameFor(checkpointStream);
    if (fromCheckpointSequence > toCheckpointSequence) {
      throw new CheckpointProofRangeError(
        `checkpoint ${String(fromCheckpointSequence)} is not before ${String(toCheckpointSequence)}`,
      );
    }
    const fromManifest = this.checkpointAt(runId, fromCheckpointSequence);
    const toManifest = this.checkpointAt(runId, toCheckpointSequence);
    const fromReference = referenceFor(fromManifest, checkpointStream);
    const toReference = referenceFor(toManifest, checkpointStream);
    if (fromReference.treeSize > toReference.treeSize) {
      throw new CheckpointIntegrityError(
        `${treeName} shrank from ${String(fromReference.treeSize)} at checkpoint ${String(fromCheckpointSequence)} to ${String(toReference.treeSize)} at checkpoint ${String(toCheckpointSequence)}`,
      );
    }

    const events = this.prefix(runId, checkpointStream, toReference.treeSize);
    const snapshot = snapshotFromEvents(checkpointStream, events);
    const record = buildConsistencyProofRecord({
      stream,
      treeName,
      fromCheckpointSequence,
      toCheckpointSequence,
      fromSize: fromReference.treeSize,
      leafHashes: snapshot.leafHashes,
    });
    if (record.fromRoot !== fromReference.merkleRoot) {
      throw new CheckpointIntegrityError(
        `checkpoint ${String(fromCheckpointSequence)} committed ${treeName} root ${fromReference.merkleRoot}, but the stored prefix of size ${String(fromReference.treeSize)} yields ${record.fromRoot}`,
      );
    }
    if (record.toRoot !== toReference.merkleRoot) {
      throw new CheckpointIntegrityError(
        `checkpoint ${String(toCheckpointSequence)} committed ${treeName} root ${toReference.merkleRoot}, but the stored prefix of size ${String(toReference.treeSize)} yields ${record.toRoot}`,
      );
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Bundle proof files (docs/evidence-bundle-format.md §1, §5)
  // -------------------------------------------------------------------------

  /**
   * Writes `proofs/inclusion/` and `proofs/consistency/` into an exported
   * bundle. `exportRunBundle` creates both directories empty and writes
   * `checkpoints/`; this fills the proofs in, so a verifier with no access to
   * this process can check both an entry and every checkpoint transition.
   *
   * Inclusion: first and last sequence of every non-empty tree at every
   * checkpoint, plus every sequence when the tree is at most
   * `maxInclusionPerTree`. Consistency: each consecutive checkpoint pair in
   * which the tree grew, plus `(0, last)` when there are three or more
   * checkpoints.
   */
  async writeProofFiles(
    runId: string,
    bundleDir: string,
    options: WriteProofFilesOptions = {},
  ): Promise<WriteProofFilesResult> {
    const maxInclusionPerTree =
      options.maxInclusionPerTree ?? DEFAULT_MAX_INCLUSION_PER_TREE;
    if (!Number.isSafeInteger(maxInclusionPerTree) || maxInclusionPerTree < 2) {
      throw new InvalidCheckpointRequestError(
        `maxInclusionPerTree must be an integer of at least 2, received ${String(maxInclusionPerTree)}`,
      );
    }
    const checkpoints = this.evidence.readCheckpoints(runId);
    if (checkpoints.length === 0) {
      throw new CheckpointNotFoundError(runId, 0);
    }

    const inclusionDir = join(bundleDir, 'proofs', 'inclusion');
    const consistencyDir = join(bundleDir, 'proofs', 'consistency');
    await mkdir(inclusionDir, { recursive: true });
    await mkdir(consistencyDir, { recursive: true });

    let inclusionFiles = 0;
    let consistencyFiles = 0;
    const last = checkpoints.at(-1);
    if (last === undefined) {
      throw new CheckpointNotFoundError(runId, 0);
    }
    const pairs: [number, number][] = checkpoints
      .slice(1)
      .map((to, index): [number, number] => [
        checkpoints[index]?.checkpointSequence ?? 0,
        to.checkpointSequence,
      ]);
    if (checkpoints.length > 2) {
      pairs.push([0, last.checkpointSequence]);
    }

    for (const stream of CHECKPOINT_STREAMS) {
      const treeName = treeNameFor(stream);

      for (const manifest of checkpoints) {
        const reference = referenceFor(manifest, stream);
        for (const sequence of inclusionSequences(
          reference.treeSize,
          maxInclusionPerTree,
        )) {
          const record = this.inclusionProof(
            runId,
            stream,
            sequence,
            manifest.checkpointSequence,
          );
          await writeCanonicalFile(
            join(
              inclusionDir,
              `${treeName}-${String(sequence)}-at-${String(manifest.checkpointSequence)}.json`,
            ),
            record,
          );
          inclusionFiles += 1;
        }
      }

      for (const [from, to] of pairs) {
        const fromSize = referenceFor(
          manifestAt(runId, checkpoints, from),
          stream,
        ).treeSize;
        const toSize = referenceFor(
          manifestAt(runId, checkpoints, to),
          stream,
        ).treeSize;
        if (toSize === fromSize) {
          // The tree did not grow between these checkpoints: the transition
          // carries no information, so no file is written.
          continue;
        }
        const record = this.consistencyProof(runId, stream, from, to);
        await writeCanonicalFile(
          join(
            consistencyDir,
            `${treeName}-${String(from)}-${String(to)}.json`,
          ),
          record,
        );
        consistencyFiles += 1;
      }
    }

    return { inclusionFiles, consistencyFiles };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private snapshots(runId: string): TreeSnapshot[] {
    return CHECKPOINT_STREAMS.map((stream) =>
      snapshotFromEvents(stream, this.evidence.readEvents(runId, stream)),
    );
  }

  private prefix(
    runId: string,
    stream: CheckpointStream,
    treeSize: number,
  ): StoredEvent[] {
    if (treeSize === 0) {
      return [];
    }
    const events = this.evidence.readEvents(runId, stream, {
      fromSequence: 1,
      toSequence: treeSize,
    });
    if (events.length !== treeSize) {
      throw new CheckpointIntegrityError(
        `stream ${stream} holds ${String(events.length)} of the ${String(treeSize)} events a checkpoint committed`,
      );
    }
    return events;
  }

  private checkpointAt(
    runId: string,
    checkpointSequence: number,
  ): CheckpointManifest {
    return manifestAt(
      runId,
      this.evidence.readCheckpoints(runId),
      checkpointSequence,
    );
  }

  private runConfig(configurationJson: string): RunConfig {
    return RunConfigSchema.parse(parseCanonicalJson(configurationJson));
  }
}

/** Sequences that get an inclusion proof for a tree of `treeSize` events. */
function inclusionSequences(treeSize: number, maxPerTree: number): number[] {
  if (treeSize === 0) {
    return [];
  }
  if (treeSize <= maxPerTree) {
    return Array.from({ length: treeSize }, (_, index) => index + 1);
  }
  return [1, treeSize];
}

/** True when any tree grew since `previous` (ALD-014 criterion 2). */
function hasGrown(
  previous: CheckpointManifest,
  snapshots: readonly TreeSnapshot[],
): boolean {
  return snapshots.some((snapshot) => {
    const committed: TreeReference = referenceFor(previous, snapshot.stream);
    return snapshot.reference.treeSize !== committed.treeSize;
  });
}

async function writeCanonicalFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, 'utf8');
}
