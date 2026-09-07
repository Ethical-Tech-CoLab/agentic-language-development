import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { exportRunBundle } from '@ald/evidence';
import { parseCanonicalJson } from '@ald/hashing';
import { verifyConsistency, verifyInclusion } from '@ald/merkle';
import {
  ConsistencyProofSchema,
  InclusionProofSchema,
  type ConsistencyProof,
  type InclusionProof,
} from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CheckpointNotFoundError,
  InvalidCheckpointRequestError,
} from '../src/errors.js';
import {
  cleanupTemporaryDirectories,
  commitTurns,
  createContext,
  temporaryDirectory,
  type CheckpointContext,
} from './support.js';

afterEach(cleanupTemporaryDirectories);

/** Three checkpoints over trees of size 0, 3, and 5. */
async function threeCheckpoints(): Promise<CheckpointContext> {
  const context = await createContext();
  await context.service.createCheckpoint(context.runId, 'run-initialized');
  await commitTurns(context, 3);
  await context.service.createCheckpoint(context.runId, 'pause');
  await commitTurns(context, 2, 4);
  await context.service.createCheckpoint(context.runId, 'run-sealed');
  return context;
}

async function readProof<T>(
  directory: string,
  file: string,
): Promise<{ text: string; value: T }> {
  const text = await readFile(join(directory, file), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return { text, value: parseCanonicalJson<T>(text.slice(0, -1)) };
}

describe('EvidenceCheckpointService.writeProofFiles', () => {
  it('writes verifiable inclusion and consistency proofs under the documented names', async () => {
    const context = await threeCheckpoints();
    const bundleDir = await temporaryDirectory();

    const counts = await context.service.writeProofFiles(
      context.runId,
      bundleDir,
    );

    const inclusionDir = join(bundleDir, 'proofs', 'inclusion');
    const consistencyDir = join(bundleDir, 'proofs', 'consistency');
    const inclusionFiles = (await readdir(inclusionDir)).sort();
    const consistencyFiles = (await readdir(consistencyDir)).sort();

    // Four non-empty trees (babyA, babyB, channel, turns) at sizes 3 and 5.
    expect(counts).toEqual({ inclusionFiles: 32, consistencyFiles: 12 });
    expect(inclusionFiles).toHaveLength(counts.inclusionFiles);
    expect(consistencyFiles).toHaveLength(counts.consistencyFiles);
    expect(inclusionFiles).toContain('channel-1-at-1.json');
    expect(inclusionFiles).toContain('channel-3-at-1.json');
    expect(inclusionFiles).toContain('turns-5-at-2.json');
    expect(inclusionFiles).toContain('babyB-1-at-2.json');
    expect(consistencyFiles).toEqual([
      'babyA-0-1.json',
      'babyA-0-2.json',
      'babyA-1-2.json',
      'babyB-0-1.json',
      'babyB-0-2.json',
      'babyB-1-2.json',
      'channel-0-1.json',
      'channel-0-2.json',
      'channel-1-2.json',
      'turns-0-1.json',
      'turns-0-2.json',
      'turns-1-2.json',
    ]);
    // Nothing is written for a stream with no events.
    expect(
      inclusionFiles.filter((file) => file.startsWith('affect')),
    ).toEqual([]);
    expect(
      consistencyFiles.filter((file) => file.startsWith('audit')),
    ).toEqual([]);
    // Checkpoint 0 committed empty trees, so it has no inclusion proofs.
    expect(inclusionFiles.filter((file) => file.endsWith('-at-0.json'))).toEqual(
      [],
    );

    const checkpoints = context.writer.readCheckpoints(context.runId);
    for (const file of inclusionFiles) {
      const { value } = await readProof<InclusionProof>(inclusionDir, file);
      expect(InclusionProofSchema.parse(value)).toEqual(value);
      expect(verifyInclusion(value)).toBe(true);
      const manifest = checkpoints[value.checkpointSequence];
      expect(manifest).toBeDefined();
      expect(file).toBe(
        `${value.treeName}-${String(value.sequence)}-at-${String(value.checkpointSequence)}.json`,
      );
    }

    for (const file of consistencyFiles) {
      const { value } = await readProof<ConsistencyProof>(
        consistencyDir,
        file,
      );
      expect(ConsistencyProofSchema.parse(value)).toEqual(value);
      expect(verifyConsistency(value)).toBe(true);
      expect(file).toBe(
        `${value.treeName}-${String(value.fromCheckpointSequence)}-${String(value.toCheckpointSequence)}.json`,
      );
    }

    context.close();
  });

  it('is byte-identical when run twice with no intervening writes', async () => {
    const context = await threeCheckpoints();
    const bundleDir = await temporaryDirectory();

    await context.service.writeProofFiles(context.runId, bundleDir);
    const first = await readProof<InclusionProof>(
      join(bundleDir, 'proofs', 'inclusion'),
      'channel-3-at-1.json',
    );
    await context.service.writeProofFiles(context.runId, bundleDir);
    const second = await readProof<InclusionProof>(
      join(bundleDir, 'proofs', 'inclusion'),
      'channel-3-at-1.json',
    );

    expect(second.text).toBe(first.text);

    context.close();
  });

  it('caps inclusion proofs at the first and last sequence for a large tree', async () => {
    const context = await threeCheckpoints();
    const bundleDir = await temporaryDirectory();

    const counts = await context.service.writeProofFiles(
      context.runId,
      bundleDir,
      { maxInclusionPerTree: 2 },
    );

    const inclusionFiles = (
      await readdir(join(bundleDir, 'proofs', 'inclusion'))
    ).sort();
    // Trees of size 3 and 5 both exceed the cap: two proofs each, four trees.
    expect(counts.inclusionFiles).toBe(16);
    expect(inclusionFiles).toContain('channel-1-at-1.json');
    expect(inclusionFiles).toContain('channel-3-at-1.json');
    expect(inclusionFiles).not.toContain('channel-2-at-1.json');
    expect(inclusionFiles).toContain('channel-5-at-2.json');

    context.close();
  });

  it('writes no consistency file for a checkpoint pair in which the tree did not grow', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 2);
    await context.service.createCheckpoint(context.runId, 'pause');
    // No new events: the trees are identical across checkpoints 1 and 2.
    await context.service.createCheckpoint(context.runId, 'run-sealed');
    const bundleDir = await temporaryDirectory();

    const counts = await context.service.writeProofFiles(
      context.runId,
      bundleDir,
    );

    const consistencyFiles = (
      await readdir(join(bundleDir, 'proofs', 'consistency'))
    ).sort();
    expect(consistencyFiles).toEqual([
      'babyA-0-1.json',
      'babyA-0-2.json',
      'babyB-0-1.json',
      'babyB-0-2.json',
      'channel-0-1.json',
      'channel-0-2.json',
      'turns-0-1.json',
      'turns-0-2.json',
    ]);
    expect(counts.consistencyFiles).toBe(consistencyFiles.length);

    context.close();
  });

  it('writes only the single consecutive pair when a run has two checkpoints', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 2);
    await context.service.createCheckpoint(context.runId, 'run-sealed');
    const bundleDir = await temporaryDirectory();

    await context.service.writeProofFiles(context.runId, bundleDir);

    const consistencyFiles = (
      await readdir(join(bundleDir, 'proofs', 'consistency'))
    ).sort();
    expect(consistencyFiles).toEqual([
      'babyA-0-1.json',
      'babyB-0-1.json',
      'channel-0-1.json',
      'turns-0-1.json',
    ]);

    context.close();
  });

  it('fills the proof directories the bundle exporter leaves empty', async () => {
    const context = await threeCheckpoints();
    const bundleDir = await temporaryDirectory();

    const runManifest = await exportRunBundle(
      context.writer,
      context.runId,
      join(bundleDir, 'bundle'),
      {
        softwareCommit: 'git:test-commit',
        learnerContracts: [
          {
            track: context.config.babyA.track,
            version: 'v1',
            text: 'test learner contract',
          },
        ],
      },
    );
    const target = join(bundleDir, 'bundle');
    expect(await readdir(join(target, 'proofs', 'inclusion'))).toEqual([]);

    const counts = await context.service.writeProofFiles(
      context.runId,
      target,
    );

    expect(counts.inclusionFiles).toBeGreaterThan(0);
    expect(await readdir(join(target, 'checkpoints'))).toHaveLength(3);
    const declaredTrees = new Set(
      runManifest.streams
        .map((stream) => stream.treeName)
        .filter((treeName): treeName is string => treeName !== undefined),
    );
    for (const file of await readdir(join(target, 'proofs', 'inclusion'))) {
      const { value } = await readProof<InclusionProof>(
        join(target, 'proofs', 'inclusion'),
        file,
      );
      // Bundle format §6: every committed tree name is declared in the run manifest.
      expect(declaredTrees.has(value.treeName)).toBe(true);
      expect(verifyInclusion(value)).toBe(true);
    }

    context.close();
  });

  it('refuses a run with no checkpoints and an unusable cap', async () => {
    const context = await createContext();
    const bundleDir = await temporaryDirectory();

    await expect(
      context.service.writeProofFiles(context.runId, bundleDir),
    ).rejects.toThrow(CheckpointNotFoundError);

    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await expect(
      context.service.writeProofFiles(context.runId, bundleDir, {
        maxInclusionPerTree: 1,
      }),
    ).rejects.toThrow(InvalidCheckpointRequestError);

    context.close();
  });
});
