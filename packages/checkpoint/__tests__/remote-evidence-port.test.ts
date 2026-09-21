import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCheckpointEvidenceRpc } from '@ald/evidence';
import { connectDomainSignerRpc, verifyHashSignature } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { verifyConsistency, verifyInclusion } from '@ald/merkle';
import { InclusionProofSchema, type SignerRegistry } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { EvidenceCheckpointService } from '../src/checkpoint-service.js';

const writerFixture = fileURLToPath(new URL(
  './fixtures/checkpoint-writer-child.mjs', import.meta.url));
const signerFixture = fileURLToPath(new URL(
  '../../hashing/__tests__/fixtures/domain-signer-child.mjs', import.meta.url));

function ready(child: ChildProcess, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let error = '';
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    const timer = setTimeout(() => reject(new Error(`${label} did not start: ${error}`)), 5_000);
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString());
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`${label} exited before ready: ${error}`)));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

describe('Checkpoint service with remote writer and witness signer', () => {
  it('creates signed manifests and verifies proofs over the restricted evidence port', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-checkpoint-remote-'));
    const witnessSocket = join(directory, 'witness.sock');
    const writerSocket = join(directory, 'writer.sock');
    const config = buildRunConfig({
      runId: 'run-checkpoint-remote',
      experimentId: 'E00',
      randomSeed: 'seed-checkpoint-remote',
      promptBundleHash: `sha256:${'b'.repeat(64)}`,
    });
    const signer = spawn(process.execPath,
      [signerFixture, witnessSocket, config.runId, 'witness'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let writer: ChildProcess | undefined;
    try {
      expect(await ready(signer, 'witness signer')).toBe('ready\n');
      const connected = await connectDomainSignerRpc(
        witnessSocket, config.runId, 'witness');
      expect(connected.processId).toBe(signer.pid);
      const signers: SignerRegistry = {
        runId: config.runId,
        signer: (domain) => {
          if (domain !== 'witness') throw new Error('checkpoint service may only sign as witness');
          return connected.signer;
        },
        publicKeys: () => [{
          domain: 'witness',
          keyId: connected.signer.keyId,
          publicKey: connected.signer.publicKey,
        }],
      };
      writer = spawn(process.execPath,
        [writerFixture, writerSocket, join(directory, 'evidence.sqlite'),
          JSON.stringify(config), witnessSocket],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const initial = JSON.parse(await ready(writer, 'evidence writer')) as { manifest: unknown };
      expect(initial.manifest).toBeDefined();
      const { port, processId } = await connectCheckpointEvidenceRpc(writerSocket, config.runId);
      expect(processId).toBe(writer.pid);
      expect(processId).not.toBe(process.pid);
      expect(processId).not.toBe(signer.pid);

      const service = new EvidenceCheckpointService({
        evidence: port,
        signers,
        clock: { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() },
        softwareCommit: 'git:remote-checkpoint-test',
      });
      const first = await service.createCheckpoint(config.runId, 'run-initialized');
      expect(first.auxiliaryTrees.intervention?.treeSize).toBe(1);
      expect(verifyHashSignature(first.checkpointHash, first.witnessSignature,
        connected.signer.publicKey)).toBe(true);
      expect((await port.readCheckpoints(config.runId))[0]?.checkpointHash)
        .toBe(first.checkpointHash);
      await service.verifyManifestTrees(config.runId, first);

      const inclusion = await service.inclusionProof(config.runId, 'intervention', 1, 0);
      expect(verifyInclusion(inclusion)).toBe(true);
      const skipped = await service.createCheckpointIfChanged(config.runId, 'event-interval');
      expect(skipped.created).toBe(false);
      const second = await service.createCheckpoint(config.runId, 'policy-checkpoint');
      expect(second.checkpointSequence).toBe(1);
      expect(second.previousCheckpointHash).toBe(first.checkpointHash);
      const consistency = await service.consistencyProof(config.runId, 'intervention', 0, 1);
      expect(verifyConsistency(consistency)).toBe(true);
      const proofFiles = await service.writeProofFiles(config.runId, directory);
      expect(proofFiles.inclusionFiles).toBe(2);
      const written = InclusionProofSchema.parse(JSON.parse(readFileSync(
        join(directory, 'proofs', 'inclusion', 'intervention-1-at-1.json'), 'utf8')));
      expect(verifyInclusion(written)).toBe(true);

      await stop(signer);
      await expect(service.createCheckpoint(config.runId, 'pause')).rejects.toThrow();
      expect(await port.readCheckpoints(config.runId)).toHaveLength(2);
    } finally {
      if (writer) await stop(writer);
      await stop(signer);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
