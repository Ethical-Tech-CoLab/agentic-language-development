/**
 * Test doubles for the two services the runtime consumes but does not own.
 *
 * `SimpleCheckpointService` is a straight-line implementation of the
 * `CheckpointService` contract (LEDGER §7-§9, `docs/evidence-bundle-format.md`
 * §5-§6): it rebuilds every tree from the store on demand, signs the manifest
 * with the run's `witness` key, and inserts it through the single Evidence
 * Writer. It carries no scheduler, no caching, and no time trigger — that is
 * what `@ald/checkpoint` adds — so the orchestrator's tests exercise the real
 * manifest chain without depending on a package built in parallel.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AUXILIARY_TREES,
  GENESIS_HASH,
  HASH_DOMAINS,
  MANDATORY_TREES,
  RunConfigSchema,
  SIGNER_KEY_IDS,
  type CheckpointManifest,
  type CheckpointReason,
  type CheckpointService,
  type CheckpointTreeName,
  type Clock,
  type ConsistencyProof,
  type EventStream,
  type InclusionProof,
  type SignerRegistry,
  type TreeReference,
  CheckpointManifestSchema,
} from '@ald/types';
import { canonicalJson, hashCanonical, hashRunId } from '@ald/hashing';
import {
  EMPTY_MERKLE_ROOT,
  buildConsistencyProofRecord,
  buildInclusionProofRecord,
  merkleLeafHashes,
  merkleRoot,
} from '@ald/merkle';
import type { SqliteEvidenceWriter } from '@ald/evidence';

/** Streams whose root is mandatory in every manifest (LEDGER §8). */
const MANDATORY_STREAMS = ['baby-a-ledger', 'baby-b-ledger', 'channel'] as const;

/** Streams committed under `auxiliaryTrees` once they carry an event. */
const AUXILIARY_STREAMS = ['affect', 'audit', 'turns', 'intervention'] as const;

export interface SimpleCheckpointServiceOptions {
  evidence: SqliteEvidenceWriter;
  signers: SignerRegistry;
  clock?: Clock;
  softwareCommit?: string;
}

/** Checkpoint tree name of one stream (`run-manifest.json` `treeName`). */
export function treeNameForStream(stream: EventStream): CheckpointTreeName {
  if (stream === 'baby-a-ledger' || stream === 'baby-b-ledger' || stream === 'channel') {
    return MANDATORY_TREES[stream];
  }
  if (
    stream === 'affect' ||
    stream === 'audit' ||
    stream === 'turns' ||
    stream === 'intervention'
  ) {
    return AUXILIARY_TREES[stream];
  }
  throw new Error(`unknown checkpoint stream ${stream}`);
}

function strictHash(value: string): string {
  const lowered = value.toLowerCase();
  return lowered.startsWith('sha256:') ? lowered : `sha256:${lowered}`;
}

export class SimpleCheckpointService implements CheckpointService {
  private readonly evidence: SqliteEvidenceWriter;
  private readonly signers: SignerRegistry;
  private readonly clock: Clock;
  private readonly softwareCommit: string;

  constructor(options: SimpleCheckpointServiceOptions) {
    this.evidence = options.evidence;
    this.signers = options.signers;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.softwareCommit = options.softwareCommit ?? 'unknown';
  }

  async createCheckpoint(
    runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointManifest> {
    const metadata = this.evidence.readRunMetadata(runId);
    if (metadata === undefined) {
      throw new Error(`unknown run ${runId}`);
    }
    const config = RunConfigSchema.parse(JSON.parse(metadata.configurationJson));

    const previous = this.evidence.readCheckpoints(runId).at(-1);
    const auxiliaryTrees: Record<string, TreeReference> = {};
    for (const stream of AUXILIARY_STREAMS) {
      const tree = this.#treeFor(runId, stream);
      if (tree.treeSize > 0) {
        auxiliaryTrees[treeNameForStream(stream)] = tree;
      }
    }

    const unsigned = {
      version: 1 as const,
      runIdHash: hashRunId(runId),
      checkpointSequence:
        previous === undefined ? 0 : previous.checkpointSequence + 1,
      previousCheckpointHash: previous?.checkpointHash ?? GENESIS_HASH,
      babyA: this.#treeFor(runId, 'baby-a-ledger'),
      babyB: this.#treeFor(runId, 'baby-b-ledger'),
      channel: this.#treeFor(runId, 'channel'),
      auxiliaryTrees,
      runConfigurationHash: strictHash(metadata.configurationHash),
      promptBundleHash: strictHash(config.promptBundleHash),
      softwareCommit: this.softwareCommit,
      createdAt: this.clock.now(),
      witnessKeyId: SIGNER_KEY_IDS.witness,
      reason,
    };

    const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
    const witnessSignature = await this.signers.signer('witness').sign(
      checkpointHash,
    );
    const manifest = CheckpointManifestSchema.parse({
      ...unsigned,
      checkpointHash,
      witnessSignature,
    });
    this.evidence.insertCheckpointManifest(manifest);
    return manifest;
  }

  inclusionProof(
    runId: string,
    stream: EventStream,
    sequence: number,
    checkpointSequence: number,
  ): InclusionProof {
    const treeName = treeNameForStream(stream);
    const treeSize = this.#committedSize(runId, checkpointSequence, treeName);
    const events = this.evidence.readEvents(runId, stream, {
      toSequence: treeSize,
    });
    const entry = events.find((event) => event.sequence === sequence);
    if (entry === undefined) {
      throw new Error(
        `${stream}#${sequence} is not inside the tree committed at checkpoint ${checkpointSequence}`,
      );
    }
    return buildInclusionProofRecord({
      stream,
      treeName,
      checkpointSequence,
      sequence,
      entryHash: entry.entryHash,
      leafHashes: merkleLeafHashes(events),
    });
  }

  consistencyProof(
    runId: string,
    stream: EventStream,
    fromCheckpointSequence: number,
    toCheckpointSequence: number,
  ): ConsistencyProof {
    const treeName = treeNameForStream(stream);
    const fromSize = this.#committedSize(
      runId,
      fromCheckpointSequence,
      treeName,
    );
    const toSize = this.#committedSize(runId, toCheckpointSequence, treeName);
    const events = this.evidence.readEvents(runId, stream, {
      toSequence: toSize,
    });
    return buildConsistencyProofRecord({
      stream,
      treeName,
      fromCheckpointSequence,
      toCheckpointSequence,
      fromSize,
      leafHashes: merkleLeafHashes(events),
    });
  }

  #treeFor(runId: string, stream: EventStream): TreeReference {
    const head = this.evidence.chainHead(runId, stream);
    if (head.size === 0) {
      return {
        treeSize: 0,
        merkleRoot: EMPTY_MERKLE_ROOT,
        lastEntryHash: GENESIS_HASH,
      };
    }
    const events = this.evidence.readEvents(runId, stream);
    return {
      treeSize: head.size,
      merkleRoot: merkleRoot(merkleLeafHashes(events)),
      lastEntryHash: head.lastEntryHash,
    };
  }

  #committedSize(
    runId: string,
    checkpointSequence: number,
    treeName: CheckpointTreeName,
  ): number {
    const manifest = this.evidence
      .readCheckpoints(runId)
      .find((candidate) => candidate.checkpointSequence === checkpointSequence);
    if (manifest === undefined) {
      throw new Error(`run ${runId} has no checkpoint ${checkpointSequence}`);
    }
    if (treeName === 'babyA') {
      return manifest.babyA.treeSize;
    }
    if (treeName === 'babyB') {
      return manifest.babyB.treeSize;
    }
    if (treeName === 'channel') {
      return manifest.channel.treeSize;
    }
    return manifest.auxiliaryTrees[treeName]?.treeSize ?? 0;
  }
}

/** Convenience factory matching `NurseryRuntimeOptions.checkpointFactory`. */
export function simpleCheckpointFactory(
  options: { clock?: Clock; softwareCommit?: string } = {},
): (
  evidence: SqliteEvidenceWriter,
  signers: SignerRegistry,
) => SimpleCheckpointService {
  return (evidence, signers) =>
    new SimpleCheckpointService({ evidence, signers, ...options });
}

/**
 * A `proofWriter` that fills `proofs/**` of an exported bundle: one inclusion
 * proof for the last event of every mandatory tree at the final checkpoint,
 * and one consistency proof from the first to the final checkpoint
 * (`docs/evidence-bundle-format.md` §1, §5).
 */
export function createSimpleProofWriter(
  evidence: SqliteEvidenceWriter,
  checkpoints: CheckpointService,
): (runId: string, bundleDir: string) => Promise<void> {
  return async (runId, bundleDir) => {
    const manifests = evidence.readCheckpoints(runId);
    const last = manifests.at(-1);
    if (last === undefined) {
      return;
    }
    const inclusionDir = join(bundleDir, 'proofs', 'inclusion');
    const consistencyDir = join(bundleDir, 'proofs', 'consistency');
    await mkdir(inclusionDir, { recursive: true });
    await mkdir(consistencyDir, { recursive: true });

    for (const stream of MANDATORY_STREAMS) {
      const treeName = treeNameForStream(stream);
      const head = evidence.chainHead(runId, stream);
      if (head.size === 0) {
        continue;
      }
      const proof = checkpoints.inclusionProof(
        runId,
        stream,
        head.size,
        last.checkpointSequence,
      );
      await writeFile(
        join(
          inclusionDir,
          `${treeName}-${String(head.size)}-at-${String(last.checkpointSequence)}.json`,
        ),
        `${canonicalJson(proof)}\n`,
        'utf8',
      );

      if (last.checkpointSequence > 0) {
        const consistency = checkpoints.consistencyProof(
          runId,
          stream,
          0,
          last.checkpointSequence,
        );
        await writeFile(
          join(
            consistencyDir,
            `${treeName}-0-${String(last.checkpointSequence)}.json`,
          ),
          `${canonicalJson(consistency)}\n`,
          'utf8',
        );
      }
    }
  };
}
