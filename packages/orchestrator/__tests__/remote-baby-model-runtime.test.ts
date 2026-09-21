import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { connectCheckpointServiceRpc } from '@ald/checkpoint';
import {
  connectAuditEvidenceRpc,
  connectControllerEvidenceRpc,
} from '@ald/evidence';
import {
  connectGatewayEvidenceRpc,
  connectSymbolGatewayRpc,
  createGatewayRelayAdapterFactory,
  type GatewayRelayAdapterFactory,
} from '@ald/gateway';
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
const checkpointFixture = fileURLToPath(new URL(
  '../../checkpoint/__tests__/fixtures/checkpoint-service-child.mjs', import.meta.url));
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
  let relayFactories: GatewayRelayAdapterFactory[] = [];

  afterEach(async () => {
    await Promise.all(relayFactories.map((factory) => factory.dispose()));
    for (const child of [...children].reverse()) await stop(child);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    relayFactories = [];
    children = [];
    directory = undefined;
  });

  it('commits and exports one turn through Gateway relays, Babies, and model boundaries', async () => {
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
    const checkpointServiceSocket = join(directory, 'checkpoint-service.sock');
    const roles: BabyRole[] = ['baby-a', 'baby-b'];
    const adapterFactories = new Map<BabyRole, GatewayRelayAdapterFactory>();
    const babyProcesses = new Map<BabyRole, ChildProcess>();
    const modelProcesses = new Map<BabyRole, ChildProcess>();
    const relayBindings: Record<string, {
      socketPath: string;
      babyHost: string;
      babyPort: number;
    }> = {};
    for (const role of roles) {
      const babyPort = await availablePort();
      const modelSocket = join(directory, `${role}-model.sock`);
      const modelProcess = spawn(process.execPath, [
        modelHost,
        '--transport=unix',
        `--socket-path=${modelSocket}`,
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
        `--model-socket=${modelSocket}`,
        `--model-host-label=${role}-model-adapter`,
      ], {
        env: { ALD_CONTAINER_ID: `${role}-baby-container` },
        stdio: 'ignore',
      });
      children.push(modelProcess, babyProcess);
      modelProcesses.set(role, modelProcess);
      babyProcesses.set(role, babyProcess);
      const relaySocket = join(directory, `${role}-learner.sock`);
      relayBindings[role] = {
        socketPath: relaySocket,
        babyHost: '127.0.0.1',
        babyPort,
      };
      const factory = createGatewayRelayAdapterFactory({
        track: 'no-learning',
        timing: 'normalized',
        deadlineMs: 1_000,
        socketPath: relaySocket,
        hostLabel: `${role}-gateway-relay`,
      });
      adapterFactories.set(role, factory);
      relayFactories.push(factory);
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

    const checkpointProcess = spawn(process.execPath, [
      checkpointFixture,
      checkpointServiceSocket,
      sockets.checkpoint,
      witnessSocket,
      runId,
      softwareCommit,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(checkpointProcess);
    expect(await readyLine(checkpointProcess, 'checkpoint service')).toBe('ready\n');

    const [controller, gatewayWriter, audit, checkpointService] =
      await Promise.all([
        connectControllerEvidenceRpc(sockets.controller, runId),
        connectGatewayEvidenceRpc(sockets.gateway, runId),
        connectAuditEvidenceRpc(sockets.audit, runId),
        connectCheckpointServiceRpc(checkpointServiceSocket, runId),
      ]);
    const signers: SignerRegistry = {
      runId,
      signer: () => { throw new Error('Controller holds no signer client'); },
      publicKeys: () => writerReady.publicKeys,
    };
    let gatewayProcessId: number | undefined;
    const runtime = createNurseryRuntime({
      bundleRoot: join(directory, 'bundles'),
      softwareCommit,
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      signerProvider: () => signers,
      adapterFactoryFor: (_runConfig, role) => adapterFactories.get(role)!,
      evidenceContextFactory: () => ({
        controller: controller.port,
        gateway: gatewayWriter.port,
        privateLedger: {
          appendLedgerEvent: gatewayWriter.port.appendLedgerEvent,
        },
        audit: audit.port,
        checkpoints: checkpointService.service,
      }),
      gatewayFactory: async (input) => {
        const gatewayProcess = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          sockets.gateway,
          input.journalDirectory,
          JSON.stringify(input.context.config),
          JSON.stringify(relayBindings),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(gatewayProcess);
        expect(await readyLine(gatewayProcess, 'Gateway')).toBe('ready\n');
        const connected = await connectSymbolGatewayRpc(gatewaySocket, input.context);
        gatewayProcessId = connected.processId;
        return connected.gateway;
      },
    });

    await runtime.createRun(config);
    const babyProcessIds = [...adapterFactories.values()].map(
      (factory) => factory.adapters[0]?.isolation.processId,
    );
    expect(babyProcessIds.every(Number.isInteger)).toBe(true);
    expect(babyProcessIds).toEqual(roles.map((role) => babyProcesses.get(role)?.pid));
    expect(roles.map((role) => adapterFactories.get(role)?.adapters[0]?.isolation))
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
      checkpointProcess.pid,
      ...babyProcessIds,
      ...modelProcessIds,
    ]).size).toBe(9);
    expect(checkpointService.processId).toBe(checkpointProcess.pid);
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
    expect([...adapterFactories.values()].flatMap((factory) => factory.adapters)
      .reduce((sum, adapter) => sum + adapter.diagnostics.ledgerAppends, 0))
      .toBe(0);
    expect(await controller.port.readCheckpoints(runId)).not.toHaveLength(0);
    const manifest = await runtime.exportBundle(runId, join(directory, 'export'));
    expect(manifest.runId).toBe(runId);
  }, 30_000);
});
