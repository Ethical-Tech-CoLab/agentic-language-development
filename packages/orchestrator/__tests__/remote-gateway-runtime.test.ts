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
  createNurseryRuntime,
  simpleCheckpointFactory,
} from '../src/index.js';
import { noLearningOverrides, testConfig } from './helpers.js';

const gatewayFixture = fileURLToPath(new URL(
  '../../gateway/__tests__/fixtures/symbol-gateway-child.mjs',
  import.meta.url,
));

function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
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
    child.once('exit', () => reject(new Error('Gateway exited before ready')));
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('Nursery remote Gateway provisioning', () => {
  let directory: string | undefined;
  let child: ChildProcess | undefined;
  let writerServer: Server | undefined;

  afterEach(async () => {
    await stop(child);
    if (writerServer !== undefined) {
      await new Promise<void>((resolve) => writerServer?.close(() => resolve()));
    }
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
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
        writerServer = await createGatewayEvidenceRpcServer(
          writerSocket,
          runId,
          localWriter,
        );
        return {
          localWriter,
          controller: controllerEvidencePortForWriter(runId, localWriter),
          gateway: localWriter,
          privateLedger: localWriter,
          audit: localWriter,
          checkpoints: checkpointFactory(localWriter, signers),
        };
      },
      gatewayFactory: async (input) => {
        recovering = input.recovering;
        child = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          writerSocket,
          input.journalDirectory,
          JSON.stringify(input.context.config),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      expect(gatewayProcessId).toBe(child?.pid);
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
});
