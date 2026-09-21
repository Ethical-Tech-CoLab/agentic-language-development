import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { InMemorySignerRegistry } from '@ald/hashing';

import { connectSymbolGatewayRpc } from '../src/service-rpc.js';
import { runContext, symbolEnvelope, turn } from './support.js';

const writerFixture = fileURLToPath(
  new URL('./fixtures/evidence-writer-child.mjs', import.meta.url),
);
const gatewayFixture = fileURLToPath(
  new URL('./fixtures/symbol-gateway-child.mjs', import.meta.url),
);

function ready(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start`)), 5_000);
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      if (chunk.toString() === 'ready\n') {
        resolve();
      } else {
        reject(new Error(`${name} readiness was malformed`));
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`${name} exited before ready`)));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('Symbol Gateway service RPC', () => {
  it('runs Gateway and writer in distinct processes and quarantines on loss', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-gateway-service-'));
    const writerSocket = join(directory, 'writer.sock');
    const gatewaySocket = join(directory, 'gateway.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const journalDirectory = join(directory, 'journal');
    const context = runContext({ anchorClass: 'simulated' });
    const writer = spawn(process.execPath, [
      writerFixture, writerSocket, databasePath, JSON.stringify(context.config),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let gateway: ChildProcess | undefined;
    try {
      await ready(writer, 'writer');
      gateway = spawn(process.execPath, [
        gatewayFixture,
        gatewaySocket,
        writerSocket,
        journalDirectory,
        JSON.stringify(context.config),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      await ready(gateway, 'Gateway');
      expect(statSync(gatewaySocket).mode & 0o777).toBe(0o600);

      const connected = await connectSymbolGatewayRpc(gatewaySocket, context);
      expect(connected.processId).toBe(gateway.pid);
      expect(connected.processId).not.toBe(writer.pid);
      expect(connected.processId).not.toBe(process.pid);
      expect(connected.gateway.runContext).toEqual(context);
      expect(connected.gateway.isEvidenceWriteQuarantined()).toBe(false);
      expect(Object.keys(connected.gateway).sort()).toEqual([
        'allowedActionKinds', 'appendLifecycleLedgerEvent',
        'beginShuffledBatch', 'consecutiveRejections',
        'discardShuffledBatchAfterRecovery', 'isEvidenceWriteQuarantined',
        'preflightShuffledProposal', 'recordDerivedAffect', 'rejectForTimeout',
        'resetRejectionCounter', 'runContext', 'sealShuffledBatch',
        'submitAffect', 'submitControlArtifact', 'submitInterpretation',
        'submitPreparedShuffledProposal', 'submitProposal',
        'submitReceiverTaskAction',
      ]);
      await expect(connectSymbolGatewayRpc(gatewaySocket, {
        ...context,
        runId: 'wrong-run',
      })).rejects.toThrow();
      await expect(connectSymbolGatewayRpc(gatewaySocket, {
        ...context,
        config: { ...context.config, randomSeed: 'wrong-configuration' },
      })).rejects.toThrow('description does not match');

      const rejected = await connected.gateway.submitProposal(
        turn(),
        symbolEnvelope(['NOT-IN-INVENTORY']),
      );
      expect(rejected.kind).toBe('rejected');
      expect(connected.gateway.consecutiveRejections()).toBe(1);
      await connected.gateway.resetRejectionCounter();
      expect(connected.gateway.consecutiveRejections()).toBe(0);

      const accepted = await connected.gateway.submitProposal(
        turn({ turn: 2 }),
        symbolEnvelope(['S01']),
      );
      expect(accepted.kind).toBe('accepted');
      expect(connected.gateway.consecutiveRejections()).toBe(0);

      await stop(gateway);
      await expect(connected.gateway.submitProposal(
        turn({ turn: 3 }),
        symbolEnvelope(['S02']),
      )).rejects.toThrow();
      expect(connected.gateway.isEvidenceWriteQuarantined()).toBe(true);

      await stop(writer);
      const database = openEvidenceDatabase(databasePath);
      try {
        const reader = new SqliteEvidenceWriter({
          database,
          signers: InMemorySignerRegistry.generate(context.runId),
        });
        expect(reader.readEvents(context.runId, 'channel')).toHaveLength(2);
        expect(reader.readEvents(context.runId, 'baby-a-ledger')).toHaveLength(1);
      } finally {
        database.close();
      }
    } finally {
      if (gateway !== undefined) await stop(gateway);
      await stop(writer);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
