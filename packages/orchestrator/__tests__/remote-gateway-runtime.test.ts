import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteEvidenceWriter,
  controllerEvidencePortForWriter,
  openEvidenceDatabase,
} from '@ald/evidence';
import {
  connectSymbolGatewayRpc,
  createGatewayEvidenceRpcServer,
} from '@ald/gateway';
import { InMemorySignerRegistry } from '@ald/hashing';

import {
  AuditLedgerInterpreter,
  createNurseryRuntime,
  simpleCheckpointFactory,
} from '../src/index.js';
import { misbehavingFactory, noLearningOverrides, testConfig } from './helpers.js';

const gatewayFixture = fileURLToPath(new URL(
  '../../gateway/__tests__/fixtures/symbol-gateway-child.mjs',
  import.meta.url,
));

function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => reject(new Error('Gateway did not start')), 5_000);
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      if (chunk.toString() === 'ready\n') {
        resolve();
      } else {
        reject(new Error('Gateway readiness was malformed'));
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(
      `Gateway exited before ready${stderr === '' ? '' : `: ${stderr.trim()}`}`,
    )));
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('Nursery remote Gateway provisioning', () => {
  let directory: string | undefined;
  let children: ChildProcess[] = [];
  let writerServers: Server[] = [];

  afterEach(async () => {
    for (const child of children) await stop(child);
    for (const writerServer of writerServers) {
      await new Promise<void>((resolve) => writerServer.close(() => resolve()));
    }
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    children = [];
    writerServers = [];
  });

  it('executes a Nursery turn through a separately hosted Gateway', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ald-nursery-remote-gateway-'));
    const database = openEvidenceDatabase(join(directory, 'evidence.sqlite'));
    const writerSocket = join(directory, 'writer.sock');
    const gatewaySocket = join(directory, 'gateway.sock');
    const softwareCommit = 'git:remote-gateway-runtime-test';
    const checkpointFactory = simpleCheckpointFactory({ softwareCommit });
    let gatewayProcessId: number | undefined;
    let recovering: boolean | undefined;
    const runtime = createNurseryRuntime({
      database,
      bundleRoot: join(directory, 'bundles'),
      softwareCommit,
      anchorPolicy: 'skip',
      signerProvider: (runId) => InMemorySignerRegistry.generate(runId),
      evidenceContextFactory: async (runId, signers) => {
        const localWriter = new SqliteEvidenceWriter({
          database,
          signers,
          softwareCommit,
        });
        const writerServer = await createGatewayEvidenceRpcServer(
          writerSocket,
          runId,
          localWriter,
        );
        writerServers.push(writerServer);
        return {
          localWriter,
          controller: controllerEvidencePortForWriter(runId, localWriter),
          gateway: localWriter,
          privateLedger: localWriter,
          audit: new AuditLedgerInterpreter(localWriter),
          checkpoints: checkpointFactory(localWriter, signers),
        };
      },
      gatewayFactory: async (input) => {
        recovering = input.recovering;
        const child = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          writerSocket,
          input.journalDirectory,
          JSON.stringify(input.context.config),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        await ready(child);
        const connected = await connectSymbolGatewayRpc(
          gatewaySocket,
          input.context,
        );
        gatewayProcessId = connected.processId;
        return connected.gateway;
      },
    });
    try {
      const config = testConfig(noLearningOverrides({
        runId: 'remote-gateway-runtime',
        experimentId: 'E02',
        randomSeed: 'remote-gateway-runtime-seed',
        maxTurnsPerRun: 2,
        evaluationTurns: 1,
      }));
      await runtime.createRun(config);
      const result = await runtime.step(config.runId);

      expect(recovering).toBe(false);
      expect(gatewayProcessId).toBe(children.at(-1)?.pid);
      expect(gatewayProcessId).not.toBe(process.pid);
      expect(result.turn).toBe(0);
      expect(result.channelEvent).not.toBeNull();
      expect(runtime.writerFor(config.runId).readEvents(config.runId, 'channel'))
        .toHaveLength(1);
      expect(runtime.getRun(config.runId)?.operationalQuarantine).toBeUndefined();
    } finally {
      database.close();
    }
  }, 30_000);

  it('restores the signed rejection streak through a fresh remote Gateway', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ald-nursery-remote-recovery-'));
    const database = openEvidenceDatabase(join(directory, 'evidence.sqlite'));
    const writerSocket = join(directory, 'writer.sock');
    const gatewaySocket = join(directory, 'gateway.sock');
    const softwareCommit = 'git:remote-gateway-recovery-test';
    const checkpointFactory = simpleCheckpointFactory({ softwareCommit });
    const registries = new Map<string, InMemorySignerRegistry>();
    const signerProvider = (runId: string) => {
      const existing = registries.get(runId);
      if (existing !== undefined) return existing;
      const created = InMemorySignerRegistry.generate(runId);
      registries.set(runId, created);
      return created;
    };
    let writer: SqliteEvidenceWriter | undefined;
    const recovering: boolean[] = [];
    const runtime = () => createNurseryRuntime({
      database,
      bundleRoot: join(directory!, 'bundles'),
      softwareCommit,
      anchorPolicy: 'skip',
      signerProvider,
      adapterFactoryFor: () => misbehavingFactory,
      evidenceContextFactory: async (runId, signers) => {
        if (writer === undefined) {
          writer = new SqliteEvidenceWriter({ database, signers, softwareCommit });
          writerServers.push(await createGatewayEvidenceRpcServer(
            writerSocket,
            runId,
            writer,
          ));
        }
        return {
          controller: controllerEvidencePortForWriter(runId, writer),
          gateway: writer,
          privateLedger: writer,
          audit: new AuditLedgerInterpreter(writer),
          checkpoints: checkpointFactory(writer, signers),
        };
      },
      gatewayFactory: async (input) => {
        recovering.push(input.recovering);
        const child = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          writerSocket,
          input.journalDirectory,
          JSON.stringify(input.context.config),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        await ready(child);
        return (await connectSymbolGatewayRpc(gatewaySocket, input.context)).gateway;
      },
    });
    try {
      const config = testConfig(noLearningOverrides({
        runId: 'remote-gateway-recovery',
        experimentId: 'E02',
        randomSeed: 'remote-gateway-recovery-seed',
        maxTurnsPerRun: 10,
        evaluationTurns: 2,
        maxConsecutiveRejections: 5,
      }));
      const original = runtime();
      await original.createRun(config);
      expect(() => original.writerFor(config.runId)).toThrow(
        'local Evidence Writer inspection is unavailable',
      );
      await original.step(config.runId);
      await original.step(config.runId);
      expect(original.gatewayFor(config.runId).consecutiveRejections()).toBe(2);
      await stop(children.at(-1));

      const restarted = runtime();
      expect((await restarted.recover(config.runId)).state).toBe('running');
      expect(recovering).toEqual([false, true]);
      expect(restarted.gatewayFor(config.runId).consecutiveRejections()).toBe(2);
      expect((await restarted.step(config.runId)).state).toBe('running');
      expect((await restarted.step(config.runId)).state).toBe('running');
      expect((await restarted.step(config.runId)).state).toBe('paused');
      expect(restarted.gatewayFor(config.runId).consecutiveRejections()).toBe(5);
      expect(writer.readEvents(config.runId, 'channel')).toHaveLength(5);
    } finally {
      database.close();
    }
  }, 30_000);
});
