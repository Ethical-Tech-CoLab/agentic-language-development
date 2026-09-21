import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AnchorPublisher } from '@ald/types';

import {
  connectAnchorServiceRpc,
  createAnchorServiceRpcServer,
} from '../src/index.js';

describe('Anchor Service RPC', () => {
  it('validates service identity and returns schema-valid receipts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-anchor-service-'));
    const socketPath = join(directory, 'anchor.sock');
    const runId = 'anchor-service-run';
    const calls: string[] = [];
    const publisher: AnchorPublisher = {
      anchorClass: 'simulated',
      network: 'base-sepolia',
      submit: async () => {
        calls.push('submit');
        return receipt(runId, 'submitted');
      },
      awaitConfirmation: async () => {
        calls.push('awaitConfirmation');
        return receipt(runId, 'confirmed');
      },
    };
    const server = await createAnchorServiceRpcServer(
      socketPath,
      runId,
      publisher,
    );
    try {
      const connected = await connectAnchorServiceRpc(socketPath, runId, publisher);
      expect(connected.processId).toBe(process.pid);
      const submitted = await connected.publisher.submit(manifest());
      expect(submitted.status).toBe('submitted');
      await expect(connected.publisher.awaitConfirmation(submitted))
        .resolves.toMatchObject({ status: 'confirmed' });
      expect(calls).toEqual(['submit', 'awaitConfirmation']);
      await expect(connectAnchorServiceRpc(socketPath, runId, {
        anchorClass: 'public-chain',
        network: 'base-sepolia',
      })).rejects.toThrow('identity does not match');
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

function manifest() {
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
    reason: 'run-sealed' as const,
    checkpointHash: sha,
    witnessSignature: signature,
  };
}

function receipt(runId: string, status: 'submitted' | 'confirmed') {
  return {
    version: 1 as const,
    runId,
    checkpointSequence: 0,
    checkpointHash: sha,
    anchorClass: 'simulated' as const,
    network: 'base-sepolia' as const,
    chainId: 84532,
    transactionHash: `0x${'11'.repeat(32)}`,
    from: `0x${'22'.repeat(20)}`,
    to: `0x${'33'.repeat(20)}`,
    inputData: `0x${'00'.repeat(32)}`,
    blockNumber: status === 'confirmed' ? 1 : null,
    blockHash: status === 'confirmed' ? `0x${'44'.repeat(32)}` : null,
    status,
    confirmations: status === 'confirmed' ? 1 : 0,
    finalityPolicy: '1-confirmation',
    rpcEndpointLabel: 'local-simulation',
    recordedAt: '2026-09-21T00:00:00.000Z',
  };
}
