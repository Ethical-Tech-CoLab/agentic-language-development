import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { connectAuditEvidenceRpc, openEvidenceDatabase } from '../src/index.js';
import { AuditLedgerInterpreter } from '../../orchestrator/src/audit-interpreter.js';
import { runConfig } from './fixtures/support.js';

const fixture = fileURLToPath(new URL('./fixtures/audit-writer-child.mjs', import.meta.url));

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

describe('Audit Interpreter evidence port over a distinct writer process', () => {
  it('rejects malformed confirmed audit entries without retrying', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-audit-rpc-shape-'));
    const socketPath = join(directory, 'writer.sock');
    const runId = 'run-audit-malformed';
    let writes = 0;
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk: string) => {
        const message = JSON.parse(chunk.trim()) as { op: string };
        if (message.op !== 'hello') writes += 1;
        socket.end(message.op === 'hello'
          ? `${JSON.stringify({ ok: true, protocol: 'audit-evidence-v1',
            runId, processId: process.pid })}\n`
          : '{"ok":true,"result":{}}\n');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
      chmodSync(socketPath, 0o600);
      const { port } = await connectAuditEvidenceRpc(socketPath, runId);
      await expect(port.appendAuditLedgerEntry({ runId } as Parameters<
        typeof port.appendAuditLedgerEntry>[0])).rejects.toThrow();
      expect(writes).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('limits a real child writer to ledger reads and audit appends', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-audit-rpc-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const config = runConfig({ runId: 'run-audit-rpc' });
    const child = spawn(process.execPath,
      [fixture, socketPath, databasePath, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const ready = await new Promise<{ entryHash: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('audit writer did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(chunk.toString()) as { entryHash: string }); }
          catch { reject(new Error('audit writer readiness malformed')); }
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('audit writer exited before ready')));
      });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { port, processId } = await connectAuditEvidenceRpc(socketPath, config.runId);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      const graph = JSON.parse(readFileSync('protocols/mode-r-authority-graph.v2.json', 'utf8')) as {
        writerCapabilities: { 'audit-writer': { methods: string[] } };
      };
      expect(Object.keys(port).sort()).toEqual(graph.writerCapabilities['audit-writer'].methods.sort());
      const source = await port.readEvents(config.runId, 'baby-a-ledger');
      expect(source).toHaveLength(1);
      expect(source[0]?.entryHash).toBe(ready.entryHash);
      const interpreter = new AuditLedgerInterpreter(port);
      const request = {
        runId: config.runId,
        interpreterVersion: 'audit-port-fixture-v1',
        entries: [{
          babyId: 'A' as const,
          sourceEntryHash: ready.entryHash as `sha256:${string}`,
          content: { term: 'S01', hypothesis: 'test interpretation', evidence: 'signed source' },
        }],
      };
      await expect(interpreter.appendBatch(request, 1)).rejects.toMatchObject({
        code: 'source-not-eligible',
      });
      const [entry] = await interpreter.appendBatch(request, 2);
      expect(entry.sourceEntryHash).toBe(ready.entryHash);
      await expect(connectAuditEvidenceRpc(socketPath, 'wrong-run')).rejects.toThrow();
      chmodSync(directory, 0o755);
      await expect(connectAuditEvidenceRpc(socketPath, config.runId)).rejects.toThrow();
      chmodSync(directory, 0o700);
      await expect(port.readEvents(config.runId, 'channel' as 'baby-a-ledger')).rejects.toThrow();
      await expect(port.readEvents('wrong-run', 'baby-a-ledger')).rejects.toThrow();
      expect(await rawRequest(socketPath, {
        op: 'commitTurn', runId: config.runId, args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'readEvents', runId: config.runId, args: [config.runId, 'channel'],
      })).toBe('{"ok":false}\n');
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(port.readEvents(config.runId, 'baby-a-ledger')).rejects.toThrow();
      const database = openEvidenceDatabase(databasePath);
      try {
        expect(database.database.prepare('SELECT COUNT(*) AS count FROM audit_ledger_entries')
          .get()).toEqual({ count: 1 });
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
