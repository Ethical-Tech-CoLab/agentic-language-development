import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemorySignerRegistry } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  SqliteEvidenceWriter,
  connectControllerEvidenceRpc,
  controllerEvidencePortForWriter,
  openEvidenceDatabase,
} from '../src/index.js';
import { hash, runConfig } from './fixtures/support.js';

const fixture = fileURLToPath(new URL('./fixtures/controller-writer-child.mjs', import.meta.url));

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

describe('Controller evidence port over a distinct writer process', () => {
  it('uses the same asynchronous run-bound capability in process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-controller-local-port-'));
    const config = runConfig({ runId: 'run-controller-local-port' });
    const database = openEvidenceDatabase(join(directory, 'evidence.sqlite'));
    const writer = new SqliteEvidenceWriter({
      database,
      signers: InMemorySignerRegistry.generate(config.runId),
      clock: { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() },
    });
    try {
      const port = controllerEvidencePortForWriter(config.runId, writer);
      expect(Object.keys(port).sort()).toEqual([
        'appendAnalysisAttachment', 'appendExperimentRecord', 'appendInterventionEvent',
        'appendTurnRecord', 'chainHead', 'readAnalysisAttachments',
        'readAnchorReceipts', 'readCheckpoints', 'readEvents', 'readExperimentRecords',
        'readForkArtifacts', 'readRunMetadata', 'readRunSigners', 'recover', 'registerRun',
      ]);
      const registration = await port.registerRun(config);
      expect((await port.readRunMetadata(config.runId))?.configurationHash)
        .toBe(registration.configurationHash);
      await port.appendInterventionEvent({
        runId: config.runId,
        eventType: 'annotate',
        actorId: 'controller-local-test',
        reasonCode: 'async-capability',
      });
      expect(await port.readEvents(config.runId, 'intervention')).toHaveLength(1);
      await expect(port.readRunMetadata('wrong-run')).rejects.toThrow();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a malformed confirmed turn result without retrying', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-controller-rpc-shape-'));
    const socketPath = join(directory, 'writer.sock');
    const runId = 'run-controller-malformed';
    let writes = 0;
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk: string) => {
        const message = JSON.parse(chunk.trim()) as { op: string };
        if (message.op !== 'hello') writes += 1;
        socket.end(message.op === 'hello'
          ? `${JSON.stringify({ ok: true, protocol: 'controller-evidence-v1',
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
      const { port } = await connectControllerEvidenceRpc(socketPath, runId);
      await expect(port.appendTurnRecord({ runId } as Parameters<
        typeof port.appendTurnRecord>[0])).rejects.toThrow();
      expect(writes).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds the exact capability to one run and does not expose Gateway writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-controller-rpc-'));
    const socketPath = join(directory, 'writer.sock');
    const databasePath = join(directory, 'evidence.sqlite');
    const config = runConfig();
    const child = spawn(process.execPath, [fixture, socketPath, databasePath, config.runId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('controller writer did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString() === 'ready\n') resolve();
          else reject(new Error('controller writer readiness malformed'));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('controller writer exited before ready')));
      });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { port, processId } = await connectControllerEvidenceRpc(socketPath, config.runId);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      expect(Object.keys(port).sort()).toEqual([
        'appendAnalysisAttachment', 'appendExperimentRecord', 'appendInterventionEvent',
        'appendTurnRecord', 'chainHead', 'readAnalysisAttachments',
        'readAnchorReceipts', 'readCheckpoints', 'readEvents', 'readExperimentRecords',
        'readForkArtifacts', 'readRunMetadata', 'readRunSigners', 'recover', 'registerRun',
      ]);
      const graph = JSON.parse(readFileSync('protocols/mode-r-authority-graph.v2.json', 'utf8')) as {
        writerCapabilities: { 'controller-writer': { methods: string[] } };
      };
      expect(Object.keys(port).sort()).toEqual(
        graph.writerCapabilities['controller-writer'].methods.sort());
      await expect(connectControllerEvidenceRpc(socketPath, 'wrong-run')).rejects.toThrow();
      chmodSync(directory, 0o755);
      await expect(connectControllerEvidenceRpc(socketPath, config.runId)).rejects.toThrow();
      chmodSync(directory, 0o700);
      const registration = await port.registerRun(config);
      expect(registration.configurationHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect((await port.readRunMetadata(config.runId))?.configurationHash)
        .toBe(registration.configurationHash);
      expect(await port.readRunSigners(config.runId)).toHaveLength(6);
      const turn = await port.appendTurnRecord({
        runId: config.runId,
        turn: 1,
        phase: 'running',
        roles: { sender: 'baby-a', receiver: 'baby-b' },
        communicationCondition: 'normal',
        scenarioRef: 'controller-component-fixture',
        scenarioStateHash: hash('1'),
        observationHashes: { babyA: hash('2'), babyB: hash('3') },
        babyProposalHash: hash('4'),
        deliveredArtifactHash: hash('5'),
        channelEventHash: hash('6'),
        actionHash: hash('7'),
        outcomeHash: hash('8'),
        outcome: { success: true, reward: 1 },
      });
      expect(turn.entryHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(await port.readEvents(config.runId, 'turns')).toHaveLength(1);
      const event = await port.appendInterventionEvent({
        runId: config.runId, eventType: 'annotate',
        actorId: 'controller-test', reasonCode: 'component-fixture',
      });
      expect(event.runId).toBe(config.runId);
      expect(await port.readEvents(config.runId, 'intervention')).toHaveLength(1);
      expect((await port.chainHead(config.runId, 'intervention')).size).toBe(1);
      await expect(port.readEvents('wrong-run', 'intervention')).rejects.toThrow();
      expect(await rawRequest(socketPath, {
        op: 'appendLedgerEvent', runId: config.runId,
        args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'appendAuditLedgerEntry', runId: config.runId,
        args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'commitTurn', runId: config.runId,
        args: [{ runId: config.runId }],
      })).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, {
        op: 'readEvents', runId: config.runId,
        args: ['wrong-run', 'turns'],
      })).toBe('{"ok":false}\n');
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(port.readCheckpoints(config.runId)).rejects.toThrow();
      const database = openEvidenceDatabase(databasePath);
      try {
        expect(database.database.prepare('SELECT COUNT(*) AS count FROM intervention_log')
          .get()).toEqual({ count: 1 });
        expect(database.database.prepare('SELECT COUNT(*) AS count FROM turn_records')
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
