import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnchorReceiptSchema } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { connectAnchorEvidenceRpc, openEvidenceDatabase } from '../src/index.js';
import { runConfig } from './fixtures/support.js';

const fixture = fileURLToPath(new URL(
  '../../anchor/__tests__/fixtures/anchor-writer-child.mjs', import.meta.url));

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

describe('simulated Anchor evidence port over a distinct writer process', () => {
  it('scopes listRuns and persists only a bound simulated terminal receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-anchor-rpc-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const config = runConfig({ runId: 'run-anchor-rpc' });
    const child = spawn(process.execPath,
      [fixture, socketPath, databasePath, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk: Buffer) => { childError += chunk.toString(); });
    try {
      const ready = await new Promise<{ receipt: unknown; allRuns: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('anchor writer did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          try { resolve(JSON.parse(chunk.toString()) as {
            receipt: unknown; allRuns: string[];
          }); }
          catch { reject(new Error('anchor writer readiness malformed')); }
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`anchor writer exited before ready: ${childError}`)));
      });
      const receipt = AnchorReceiptSchema.parse(ready.receipt);
      expect(ready.allRuns).toHaveLength(2);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { port, processId } = await connectAnchorEvidenceRpc(socketPath, config.runId);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      const graph = JSON.parse(readFileSync('protocols/mode-r-authority-graph.v2.json', 'utf8')) as {
        writerCapabilities: { 'anchor-writer': { methods: string[] } };
      };
      expect(Object.keys(port).sort()).toEqual(
        graph.writerCapabilities['anchor-writer'].methods.sort());
      expect(await port.listRuns()).toEqual([config.runId]);
      expect(await port.readCheckpoints(config.runId)).toHaveLength(1);
      expect(await port.readAnchorReceipts(config.runId)).toEqual([]);
      await port.insertAnchorReceipt(receipt);
      expect((await port.readAnchorReceipts(config.runId))[0]?.transactionHash)
        .toBe(receipt.transactionHash);
      await expect(port.insertAnchorReceipt({ ...receipt,
        anchorClass: 'public-chain' })).rejects.toThrow();
      await expect(port.insertAnchorReceipt({ ...receipt,
        runId: 'run-anchor-other' })).rejects.toThrow();
      await expect(port.readCheckpoints('run-anchor-other')).rejects.toThrow();
      await expect(connectAnchorEvidenceRpc(socketPath, 'wrong-run')).rejects.toThrow();
      expect(await rawRequest(socketPath, {
        op: 'appendTurnRecord', runId: config.runId, args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'readAnchorReceipts', runId: config.runId, args: ['run-anchor-other'],
      })).toBe('{"ok":false}\n');
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(port.listRuns()).rejects.toThrow();
      const database = openEvidenceDatabase(databasePath);
      try {
        expect(database.database.prepare('SELECT COUNT(*) AS count FROM anchor_receipts')
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
