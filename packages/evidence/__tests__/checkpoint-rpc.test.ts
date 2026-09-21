import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRunId } from '@ald/hashing';
import { CheckpointManifestSchema } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { connectCheckpointEvidenceRpc, openEvidenceDatabase } from '../src/index.js';
import { runConfig } from './fixtures/support.js';

const fixture = fileURLToPath(new URL(
  '../../checkpoint/__tests__/fixtures/checkpoint-writer-child.mjs', import.meta.url));

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

describe('Checkpoint evidence port over a distinct writer process', () => {
  it('reads one run and inserts a witness-signed manifest through its exact capability', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-checkpoint-rpc-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const config = runConfig({ runId: 'run-checkpoint-rpc' });
    const child = spawn(process.execPath,
      [fixture, socketPath, databasePath, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk: Buffer) => { childError += chunk.toString(); });
    try {
      const ready = await new Promise<{ manifest: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('checkpoint writer did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(chunk.toString()) as { manifest: unknown }); }
          catch { reject(new Error('checkpoint writer readiness malformed')); }
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`checkpoint writer exited before ready: ${childError}`)));
      });
      const manifest = CheckpointManifestSchema.parse(ready.manifest);
      expect(manifest.runIdHash).toBe(hashRunId(config.runId));
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { port, processId } = await connectCheckpointEvidenceRpc(socketPath, config.runId);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      const graph = JSON.parse(readFileSync('protocols/mode-r-authority-graph.v2.json', 'utf8')) as {
        writerCapabilities: { 'checkpoint-writer': { methods: string[] } };
      };
      expect(Object.keys(port).sort()).toEqual(
        graph.writerCapabilities['checkpoint-writer'].methods.sort());
      expect((await port.readRunMetadata(config.runId))?.runId).toBe(config.runId);
      expect(await port.readEvents(config.runId, 'baby-a-ledger')).toEqual([]);
      expect(await port.readCheckpoints(config.runId)).toEqual([]);
      await port.insertCheckpointManifest(manifest);
      expect((await port.readCheckpoints(config.runId))[0]?.checkpointHash)
        .toBe(manifest.checkpointHash);
      await expect(port.readCheckpoints('wrong-run')).rejects.toThrow();
      await expect(port.insertCheckpointManifest({ ...manifest,
        runIdHash: hashRunId('wrong-run') })).rejects.toThrow();
      await expect(connectCheckpointEvidenceRpc(socketPath, 'wrong-run')).rejects.toThrow();
      expect(await rawRequest(socketPath, {
        op: 'appendTurnRecord', runId: config.runId, args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'readEvents', runId: config.runId, args: ['wrong-run', 'channel'],
      })).toBe('{"ok":false}\n');
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(port.readCheckpoints(config.runId)).rejects.toThrow();
      const database = openEvidenceDatabase(databasePath);
      try {
        expect(database.database.prepare('SELECT COUNT(*) AS count FROM checkpoint_manifests')
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
