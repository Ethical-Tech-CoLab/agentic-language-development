/**
 * Shared fixtures: a temp-directory SQLite evidence store with one registered
 * run and real, chain-linked checkpoint manifests, so every anchoring test
 * runs against the production `SqliteEvidenceWriter` rather than a stub.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqliteEvidenceWriter,
  openEvidenceDatabase,
  type EvidenceDatabase,
} from '@ald/evidence';
import { InMemorySignerRegistry, hashCanonical, hashRunId } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { EMPTY_MERKLE_ROOT } from '@ald/merkle';
import { GENESIS_HASH, HASH_DOMAINS } from '@ald/types';
import type {
  CheckpointManifest,
  CheckpointReason,
  Clock,
} from '@ald/types';

/** Designated destination of every test anchor transaction. */
export const ANCHOR_ADDRESS = `0x${'d0'.repeat(20)}`;

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ald-anchor-'));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

/** Deterministic clock: one millisecond per call from a fixed epoch. */
export class StepClock implements Clock {
  private current = Date.UTC(2026, 0, 1, 0, 0, 0);

  now(): string {
    const value = new Date(this.current).toISOString();
    this.current += 1;
    return value;
  }
}

/** Every checkpoint tree is empty in these fixtures; only its hash matters. */
const EMPTY_TREE = {
  treeSize: 0,
  merkleRoot: EMPTY_MERKLE_ROOT,
  lastEntryHash: GENESIS_HASH,
};

export interface AnchorTestContext {
  runId: string;
  directory: string;
  clock: StepClock;
  writer: SqliteEvidenceWriter;
  database: EvidenceDatabase;
  manifests: CheckpointManifest[];
  addCheckpoint(reason?: CheckpointReason): Promise<CheckpointManifest>;
  close(): void;
}

export async function createAnchorContext(
  runId = 'run-anchor-001',
): Promise<AnchorTestContext> {
  const directory = await temporaryDirectory();
  const config = buildRunConfig({
    runId,
    experimentId: 'E00',
    randomSeed: 'seed-anchor-001',
  });
  const database = openEvidenceDatabase(join(directory, 'evidence.sqlite'));
  const signers = InMemorySignerRegistry.generate(runId);
  const clock = new StepClock();
  const writer = new SqliteEvidenceWriter({ database, signers, clock });
  const { configurationHash } = writer.registerRun(config);

  const manifests: CheckpointManifest[] = [];

  const context: AnchorTestContext = {
    runId,
    directory,
    clock,
    writer,
    database,
    manifests,
    async addCheckpoint(reason = 'run-initialized'): Promise<CheckpointManifest> {
      const previous = manifests.at(-1);
      const unsigned = {
        version: 1 as const,
        runIdHash: hashRunId(runId),
        checkpointSequence: manifests.length,
        previousCheckpointHash: previous?.checkpointHash ?? GENESIS_HASH,
        babyA: EMPTY_TREE,
        babyB: EMPTY_TREE,
        channel: EMPTY_TREE,
        auxiliaryTrees: {},
        runConfigurationHash: configurationHash,
        promptBundleHash: config.promptBundleHash,
        softwareCommit: 'anchor-test-commit',
        createdAt: clock.now(),
        witnessKeyId: signers.signer('witness').keyId,
        reason,
      };
      const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
      const manifest: CheckpointManifest = {
        ...unsigned,
        checkpointHash,
        witnessSignature: await signers.signer('witness').sign(checkpointHash),
      };
      writer.insertCheckpointManifest(manifest);
      manifests.push(manifest);
      return manifest;
    },
    close(): void {
      database.close();
    },
  };

  return context;
}

/** Never-waiting sleep so retry/backoff tests stay fast. */
export const immediateSleep = async (): Promise<void> => {};
