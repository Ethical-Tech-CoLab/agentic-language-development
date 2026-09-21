import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { InMemorySignerRegistry } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  connectGatewayEvidenceRpc,
  EvidenceWriteUncertainError,
  GatewayWriteIntentJournal,
  SymbolGatewayImpl,
} from '../src/index.js';
import { runContext, symbolEnvelope, turn } from './support.js';

const fixture = fileURLToPath(new URL('./fixtures/evidence-writer-child.mjs', import.meta.url));

function rawRequest(socketPath: string, value: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('Gateway evidence port over a distinct writer process', () => {
  it('rejects a confirmed frame whose signed event shape is invalid', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-evidence-rpc-shape-'));
    const socketPath = join(directory, 'writer.sock');
    const runId = 'run-rpc-invalid-result';
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk: string) => {
        const hello = JSON.parse(chunk.trim()) as { op: string };
        socket.end(hello.op === 'hello'
          ? `${JSON.stringify({ ok: true, protocol: 'gateway-evidence-v1', runId,
            processId: process.pid })}\n`
          : '{"ok":true,"result":{}}\n');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
      chmodSync(socketPath, 0o600);
      const { port } = await connectGatewayEvidenceRpc(socketPath, runId);
      await expect(port.commitRejection({
        runId, turn: 1, sender: 'baby-a', carrier: 'fixed-token',
        communicationCondition: 'normal', reasonCode: 'timeout',
        rejectedPayloadHash: `sha256:${'0'.repeat(64)}`,
      })).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('commits through one private socket and quarantines after writer death', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-evidence-rpc-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const context = runContext({ anchorClass: 'simulated' });
    const child = spawn(process.execPath,
      [fixture, socketPath, databasePath, JSON.stringify(context.config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('writer fixture did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString() === 'ready\n') resolve();
          else reject(new Error(`writer fixture readiness malformed: ${chunk.toString()}`));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('writer fixture exited before ready')));
      });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { port, processId } = await connectGatewayEvidenceRpc(socketPath, context.runId);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      expect(Object.keys(port).sort()).toEqual([
        'appendAffectEvent', 'appendInterventionEvent', 'appendLedgerEvent',
        'commitControlArtifact', 'commitRejection', 'commitTurn',
      ]);
      await expect(connectGatewayEvidenceRpc(socketPath, 'wrong-run')).rejects.toThrow();
      chmodSync(directory, 0o755);
      await expect(connectGatewayEvidenceRpc(socketPath, context.runId)).rejects.toThrow();
      chmodSync(directory, 0o700);
      expect(await rawRequest(socketPath, {
        op: 'registerRun', runId: context.runId, request: context.config,
      })).toBe('{"ok":false}\n');
      const rejected = await rawRequest(socketPath, {
        op: 'commitTurn', runId: context.runId,
        request: { runId: context.runId, privateDraft: 'never-echo-this' },
      });
      expect(rejected).toBe('{"ok":false}\n');

      const journal = new GatewayWriteIntentJournal(join(directory, 'journal'), context.runId);
      const gateway = new SymbolGatewayImpl(context, await journal.openPort(port));
      const accepted = await gateway.submitProposal(turn(), symbolEnvelope(['S01']));
      expect(accepted.kind).toBe('accepted');
      expect(await journal.unresolvedIntents()).toEqual([]);

      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(gateway.submitProposal(turn({ turn: 2 }), symbolEnvelope(['S02'])))
        .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
      expect(journal.isQuarantined()).toBe(true);
      expect(await journal.unresolvedIntents()).toHaveLength(1);

      const database = openEvidenceDatabase(databasePath);
      try {
        const reader = new SqliteEvidenceWriter({
          database,
          signers: InMemorySignerRegistry.generate(context.runId),
        });
        expect(reader.readEvents(context.runId, 'channel')).toHaveLength(1);
        expect(reader.readEvents(context.runId, 'baby-a-ledger')).toHaveLength(1);
      } finally {
        database.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
