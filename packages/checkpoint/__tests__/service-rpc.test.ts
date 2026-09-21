import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { CheckpointService } from '@ald/types';

import {
  connectCheckpointServiceRpc,
  createCheckpointServiceRpcServer,
} from '../src/index.js';

describe('Checkpoint Service RPC', () => {
  it('binds every call to one run and validates returned evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-checkpoint-service-'));
    const socketPath = join(directory, 'checkpoint.sock');
    const runId = 'checkpoint-service-run';
    const calls: string[] = [];
    const fixture = {
      createCheckpoint: async () => {
        calls.push('createCheckpoint');
        return manifest(runId);
      },
      inclusionProof: async () => {
        calls.push('inclusionProof');
        return inclusion(runId);
      },
      consistencyProof: async () => {
        calls.push('consistencyProof');
        return consistency(runId);
      },
    } satisfies CheckpointService;
    const server = await createCheckpointServiceRpcServer(socketPath, runId, fixture);
    try {
      const connected = await connectCheckpointServiceRpc(socketPath, runId);
      expect(connected.processId).toBe(process.pid);
      await expect(connected.service.createCheckpoint(runId, 'run-initialized'))
        .resolves.toMatchObject({ checkpointSequence: 0 });
      await expect(connected.service.inclusionProof(runId, 'channel', 1, 0))
        .resolves.toMatchObject({ sequence: 1 });
      await expect(connected.service.consistencyProof(runId, 'channel', 0, 1))
        .resolves.toMatchObject({ fromCheckpointSequence: 0, toCheckpointSequence: 1 });
      await expect(connected.service.createCheckpoint('wrong-run', 'run-sealed'))
        .rejects.toThrow('run ID mismatch');
      expect(calls).toEqual([
        'createCheckpoint',
        'inclusionProof',
        'consistencyProof',
      ]);
      await expect(connectCheckpointServiceRpc(socketPath, 'wrong-run'))
        .rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const sha = `sha256:${'00'.repeat(32)}`;
const signature = `ed25519:${Buffer.alloc(64).toString('base64')}`;

function tree() {
  return { treeSize: 1, merkleRoot: sha, lastEntryHash: sha };
}

function manifest(runId: string) {
  void runId;
  return {
    version: 1 as const,
    runIdHash: sha,
    checkpointSequence: 0,
    previousCheckpointHash: sha,
    babyA: tree(),
    babyB: tree(),
    channel: tree(),
    auxiliaryTrees: {},
    runConfigurationHash: sha,
    promptBundleHash: sha,
    softwareCommit: 'git:test',
    createdAt: '2026-09-21T00:00:00.000Z',
    witnessKeyId: 'witness:test',
    reason: 'run-initialized' as const,
    checkpointHash: sha,
    witnessSignature: signature,
  };
}

function inclusion(runId: string) {
  void runId;
  return {
    version: 1 as const,
    stream: 'channel' as const,
    treeName: 'channel',
    checkpointSequence: 0,
    treeSize: 1,
    sequence: 1,
    leafIndex: 0,
    entryHash: sha,
    leafHash: sha,
    path: [],
    root: sha,
  };
}

function consistency(runId: string) {
  void runId;
  return {
    version: 1 as const,
    stream: 'channel' as const,
    treeName: 'channel',
    fromSize: 1,
    toSize: 2,
    fromRoot: sha,
    toRoot: sha,
    path: [sha],
    fromCheckpointSequence: 0,
    toCheckpointSequence: 1,
  };
}
