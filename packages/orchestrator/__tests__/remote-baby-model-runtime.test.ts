import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import {
  connectAuditEvidenceRpc,
  connectCheckpointEvidenceRpc,
  connectControllerEvidenceRpc,
} from '@ald/evidence';
import {
  connectGatewayEvidenceRpc,
  connectSymbolGatewayRpc,
} from '@ald/gateway';
import { connectDomainSignerRpc } from '@ald/hashing';
import {
  createBabyContainerAdapterFactory,
  type BabyContainerAdapterFactory,
} from '@ald/isolation';
import type { BabyRole, SignerRegistry } from '@ald/types';

import {
  createNurseryRuntime,
  type EvidenceWriterCapabilitySockets,
} from '../src/index.js';
import {
  anchorPublisherFor,
  noLearningOverrides,
  testConfig,
} from './helpers.js';

const writerFixture = fileURLToPath(new URL(
  './fixtures/evidence-writer-host-child.mjs', import.meta.url));
const gatewayFixture = fileURLToPath(new URL(
  '../../gateway/__tests__/fixtures/symbol-gateway-child.mjs', import.meta.url));
const signerFixture = fileURLToPath(new URL(
  '../../hashing/__tests__/fixtures/domain-signer-child.mjs', import.meta.url));
const babyHost = fileURLToPath(new URL(
  '../../isolation/bin/ald-baby-host.js', import.meta.url));
const modelHost = fileURLToPath(new URL(
  '../../isolation/bin/ald-learner-host.js', import.meta.url));

function readyLine(child: ChildProcess, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(
      () => reject(new Error(`${label} did not start: ${stderr}`)),
      5_000,
    );
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString());
    });
    child.once('error', reject);
    child.once('exit', () => reject(
      new Error(`${label} exited before ready: ${stderr}`),
    ));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to reserve TCP port');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe('remote runtime with distinct Baby and model processes', () => {
  let directory: string | undefined;
  let children: ChildProcess[] = [];
  let babyFactories: BabyContainerAdapterFactory[] = [];

  afterEach(async () => {
    await Promise.all(babyFactories.map((factory) => factory.dispose()));
    for (const child of [...children].reverse()) await stop(child);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    babyFactories = [];
    children = [];
    directory = undefined;
  });

  it('commits and exports one turn through remote writer, Gateway, Baby, and model boundaries', async () => {
    if (process.platform !== 'linux') return;
    directory = mkdtempSync(join(tmpdir(), 'ald-remote-baby-model-runtime-'));
    const runId = 'remote-baby-model-runtime';
    const softwareCommit = 'git:remote-baby-model-runtime-test';
    const config = testConfig(noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: 'remote-baby-model-runtime-seed',
      deploymentMode: 'research-grade',
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
    }));
    const witnessSocket = join(directory, 'witness.sock');
    const sockets: EvidenceWriterCapabilitySockets = {
      controller: join(directory, 'controller.sock'),
      gateway: join(directory, 'gateway-writer.sock'),
      checkpoint: join(directory, 'checkpoint.sock'),
      anchor: join(directory, 'anchor.sock'),
      audit: join(directory, 'audit.sock'),
    };
    const gatewaySocket = join(directory, 'gateway-controller.sock');
    const roles: BabyRole[] = ['baby-a', 'baby-b'];
    const containerFactories = new Map<BabyRole, BabyContainerAdapterFactory>();
    const babyProcesses = new Map<BabyRole, ChildProcess>();
    const modelProcesses = new Map<BabyRole, ChildProcess>();
    for (const role of roles) {
      const modelPort = await availablePort();
      const babyPort = await availablePort();
      const modelProcess = spawn(process.execPath, [
        modelHost,
        '--transport=tcp',
        `--port=${String(modelPort)}`,
        '--bind=127.0.0.1',
        '--track=no-learning',
        `--host-label=${role}-model-adapter`,
      ], {
        env: { ALD_CONTAINER_ID: `${role}-model-container` },
        stdio: 'ignore',
      });
      const babyProcess = spawn(process.execPath, [
        babyHost,
        '--transport=tcp',
        `--port=${String(babyPort)}`,
        '--bind=127.0.0.1',
        '--track=no-learning',
        `--host-label=${role}`,
        '--model-host=127.0.0.1',
        `--model-port=${String(modelPort)}`,
        `--model-host-label=${role}-model-adapter`,
      ], {
        env: { ALD_CONTAINER_ID: `${role}-baby-container` },
        stdio: 'ignore',
      });
      children.push(modelProcess, babyProcess);
      modelProcesses.set(role, modelProcess);
      babyProcesses.set(role, babyProcess);
      const factory = createBabyContainerAdapterFactory({
        track: 'no-learning',
        timing: 'normalized',
        deadlineMs: 1_000,
        endpoint: {
          host: '127.0.0.1',
          port: babyPort,
          attempts: 20,
          retryDelayMs: 50,
          hostLabel: role,
        },
      });
      containerFactories.set(role, factory);
      babyFactories.push(factory);
    }

    const witnessProcess = spawn(process.execPath, [
      signerFixture, witnessSocket, runId, 'witness',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(witnessProcess);
    expect(await readyLine(witnessProcess, 'witness signer')).toBe('ready\n');

    const writerProcess = spawn(process.execPath, [
      writerFixture,
      join(directory, 'evidence.sqlite'),
      JSON.stringify(config),
      JSON.stringify(sockets),
      witnessSocket,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(writerProcess);
    const writerReady = JSON.parse(
      await readyLine(writerProcess, 'evidence writer'),
    ) as {
      processId: number;
      publicKeys: ReturnType<SignerRegistry['publicKeys']>;
    };

    const [controller, gatewayWriter, checkpoint, audit, witness] =
      await Promise.all([
        connectControllerEvidenceRpc(sockets.controller, runId),
        connectGatewayEvidenceRpc(sockets.gateway, runId),
        connectCheckpointEvidenceRpc(sockets.checkpoint, runId),
        connectAuditEvidenceRpc(sockets.audit, runId),
        connectDomainSignerRpc(witnessSocket, runId, 'witness'),
      ]);
    const signers: SignerRegistry = {
      runId,
      signer: (domain) => {
        if (domain !== 'witness') {
          throw new Error('Controller holds only the witness signer client');
        }
        return witness.signer;
      },
      publicKeys: () => writerReady.publicKeys,
    };
    const checkpoints = new EvidenceCheckpointService({
      evidence: checkpoint.port,
      signers,
      clock: { now: () => new Date().toISOString() },
      softwareCommit,
    });
    let gatewayProcessId: number | undefined;
    const runtime = createNurseryRuntime({
      bundleRoot: join(directory, 'bundles'),
      softwareCommit,
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      signerProvider: () => signers,
      adapterFactoryFor: (_runConfig, role) => containerFactories.get(role)!,
      evidenceContextFactory: () => ({
        controller: controller.port,
        gateway: gatewayWriter.port,
        privateLedger: {
          appendLedgerEvent: gatewayWriter.port.appendLedgerEvent,
        },
        audit: audit.port,
        checkpoints,
      }),
      gatewayFactory: async (input) => {
        const gatewayProcess = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          sockets.gateway,
          input.journalDirectory,
          JSON.stringify(input.context.config),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(gatewayProcess);
        expect(await readyLine(gatewayProcess, 'Gateway')).toBe('ready\n');
        const connected = await connectSymbolGatewayRpc(gatewaySocket, input.context);
        gatewayProcessId = connected.processId;
        return connected.gateway;
      },
    });

    await runtime.createRun(config);
    const babyProcessIds = [...containerFactories.values()].map(
      (factory) => factory.adapters[0]?.isolation.processId,
    );
    expect(babyProcessIds.every(Number.isInteger)).toBe(true);
    expect(babyProcessIds).toEqual(roles.map((role) => babyProcesses.get(role)?.pid));
    expect(roles.map((role) => containerFactories.get(role)?.adapters[0]?.isolation))
      .toEqual(roles.map((role) => expect.objectContaining({
        boundary: 'separate-container',
        containerId: `${role}-baby-container`,
        timingNormalization: 'normalized',
        turnDeadlineAuthority: 'adapter',
      })));
    const modelProcessIds = roles.map((role) => modelProcesses.get(role)?.pid);
    expect(gatewayProcessId).toBeDefined();
    expect(new Set([
      process.pid,
      witnessProcess.pid,
      writerProcess.pid,
      gatewayProcessId,
      ...babyProcessIds,
      ...modelProcessIds,
    ]).size).toBe(8);
    expect(() => runtime.writerFor(runId)).toThrow(
      'local Evidence Writer inspection is unavailable',
    );

    const turn = await runtime.step(runId);
    expect(turn.turn).toBe(0);
    expect(turn.channelEvent).not.toBeNull();
    expect(await controller.port.readEvents(runId, 'turns')).toHaveLength(1);
    expect(await controller.port.readEvents(runId, 'channel')).toHaveLength(1);
    expect(await controller.port.readEvents(runId, 'baby-a-ledger')).not.toHaveLength(0);
    expect(await controller.port.readEvents(runId, 'baby-b-ledger')).not.toHaveLength(0);
    expect([...containerFactories.values()].flatMap((factory) => factory.adapters)
      .reduce((sum, adapter) => sum + adapter.diagnostics.ledgerAppends, 0))
      .toBeGreaterThan(0);
    expect(await controller.port.readCheckpoints(runId)).not.toHaveLength(0);
    const manifest = await runtime.exportBundle(runId, join(directory, 'export'));
    expect(manifest.runId).toBe(runId);
  }, 30_000);
});
