import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectAnchorEvidenceRpc } from '@ald/evidence';
import { hashRunId } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { CheckpointManifestSchema } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { BaseAnchorPublisher, FakeChainTransport } from '../src/index.js';
import { ANCHOR_ADDRESS, StepClock } from './support.js';

const fixture = fileURLToPath(new URL('./fixtures/anchor-writer-child.mjs', import.meta.url));

describe('simulated Anchor publisher with remote evidence', () => {
  it('sends one transaction across concurrent asynchronous preflight reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-anchor-remote-publisher-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const config = buildRunConfig({
      runId: 'run-anchor-remote-publisher',
      experimentId: 'E00',
      randomSeed: 'anchor-remote-publisher-seed',
    });
    const child = spawn(process.execPath,
      [fixture, socketPath, databasePath, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk: Buffer) => { childError += chunk.toString(); });
    try {
      const ready = await new Promise<{ manifest: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('remote writer did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(chunk.toString()) as { manifest: unknown }); }
          catch { reject(new Error('remote writer readiness malformed')); }
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`remote writer exited before ready: ${childError}`)));
      });
      const manifest = CheckpointManifestSchema.parse(ready.manifest);
      const { port, processId } = await connectAnchorEvidenceRpc(socketPath, config.runId);
      expect(processId).toBe(child.pid);
      const transport = new FakeChainTransport();
      const publisher = new BaseAnchorPublisher({
        transport,
        anchorClass: 'simulated',
        evidence: port,
        clock: new StepClock(),
        anchorAddress: ANCHOR_ADDRESS,
        finalityPolicy: '1-confirmation',
      });
      const firstPending = publisher.submit(manifest);
      const secondPending = publisher.submit(manifest);
      await expect(publisher.submit({ ...manifest,
        runIdHash: hashRunId('wrong-run') })).rejects.toThrow();
      const [first, second] = await Promise.all([firstPending, secondPending]);
      expect(first.transactionHash).toBe(second.transactionHash);
      expect(transport.submissions).toHaveLength(1);
      transport.mineBlock(1);
      const [confirmed, concurrent] = await Promise.all([
        publisher.awaitConfirmation(first), publisher.awaitConfirmation(second),
      ]);
      expect(confirmed.status).toBe('confirmed');
      expect(concurrent.transactionHash).toBe(confirmed.transactionHash);
      expect((await port.readAnchorReceipts(config.runId))[0]?.transactionHash)
        .toBe(confirmed.transactionHash);
      expect(transport.submissions).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
