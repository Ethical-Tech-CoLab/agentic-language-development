import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { SignerRegistry } from '@ald/types';

import {
  createNurseryRuntime,
  type EvidenceWriterCapabilitySockets,
} from '../src/index.js';
import { noLearningOverrides, testConfig } from './helpers.js';

const writerFixture = fileURLToPath(new URL(
  './fixtures/evidence-writer-host-child.mjs', import.meta.url));
const gatewayFixture = fileURLToPath(new URL(
  '../../gateway/__tests__/fixtures/symbol-gateway-child.mjs', import.meta.url));
const signerFixture = fileURLToPath(new URL(
  '../../hashing/__tests__/fixtures/domain-signer-child.mjs', import.meta.url));

function firstLine(child: ChildProcess, label: string): Promise<string> {
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

describe('Nursery remote evidence provisioning', () => {
  let directory: string | undefined;
  let children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of [...children].reverse()) await stop(child);
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    children = [];
    directory = undefined;
  });

  it('executes without a Controller-owned database or writer handle', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ald-remote-evidence-runtime-'));
    const runId = 'remote-evidence-runtime';
    const softwareCommit = 'git:remote-evidence-runtime-test';
    const config = testConfig(noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: 'remote-evidence-runtime-seed',
      maxTurnsPerRun: 2,
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
    const signer = spawn(process.execPath, [
      signerFixture, witnessSocket, runId, 'witness',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(signer);
    expect(await firstLine(signer, 'witness signer')).toBe('ready\n');

    const writer = spawn(process.execPath, [
      writerFixture,
      join(directory, 'evidence.sqlite'),
      JSON.stringify(config),
      JSON.stringify(sockets),
      witnessSocket,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(writer);
    const writerReady = JSON.parse(
      await firstLine(writer, 'evidence writer'),
    ) as {
      processId: number;
      publicKeys: ReturnType<SignerRegistry['publicKeys']>;
    };
    expect(writerReady.processId).toBe(writer.pid);

    const [controller, gatewayWriter, checkpoint, audit, witness] =
      await Promise.all([
        connectControllerEvidenceRpc(sockets.controller, runId),
        connectGatewayEvidenceRpc(sockets.gateway, runId),
        connectCheckpointEvidenceRpc(sockets.checkpoint, runId),
        connectAuditEvidenceRpc(sockets.audit, runId),
        connectDomainSignerRpc(witnessSocket, runId, 'witness'),
      ]);
    for (const connection of [controller, gatewayWriter, checkpoint, audit]) {
      expect(connection.processId).toBe(writer.pid);
    }
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
    expect(writerReady.publicKeys.find((key) => key.domain === 'witness'))
      .toMatchObject({
        keyId: witness.signer.keyId,
        publicKey: witness.signer.publicKey,
      });
    const checkpoints = new EvidenceCheckpointService({
      evidence: checkpoint.port,
      signers,
      clock: { now: () => new Date().toISOString() },
      softwareCommit,
    });
    const gatewayProcessIds: number[] = [];
    const makeRuntime = () => createNurseryRuntime({
      bundleRoot: join(directory, 'bundles'),
      softwareCommit,
      anchorPolicy: 'skip',
      signerProvider: () => signers,
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
        const gateway = spawn(process.execPath, [
          gatewayFixture,
          gatewaySocket,
          sockets.gateway,
          input.journalDirectory,
          JSON.stringify(input.context.config),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(gateway);
        expect(await firstLine(gateway, 'Gateway')).toBe('ready\n');
        const connected = await connectSymbolGatewayRpc(
          gatewaySocket,
          input.context,
        );
        gatewayProcessIds.push(connected.processId);
        return connected.gateway;
      },
    });

    const runtime = makeRuntime();
    await runtime.createRun(config);
    expect(() => runtime.writerFor(runId)).toThrow(
      'local Evidence Writer inspection is unavailable',
    );
    const turn = await runtime.step(runId);
    expect(turn.turn).toBe(0);
    expect(gatewayProcessIds[0]).not.toBe(process.pid);
    expect(gatewayProcessIds[0]).not.toBe(writer.pid);
    expect(await controller.port.readEvents(runId, 'turns')).toHaveLength(1);
    expect(await controller.port.readEvents(runId, 'channel')).toHaveLength(1);
    expect(await controller.port.readCheckpoints(runId)).not.toHaveLength(0);
    const manifest = await runtime.exportBundle(runId, join(directory, 'export'));
    expect(manifest.runId).toBe(runId);

    await stop(children.at(-1)!);
    const restarted = makeRuntime();
    expect((await restarted.recover(runId)).state).toBe('running');
    expect(gatewayProcessIds).toHaveLength(2);
    expect(gatewayProcessIds[1]).not.toBe(gatewayProcessIds[0]);
    expect(() => restarted.writerFor(runId)).toThrow(
      'local Evidence Writer inspection is unavailable',
    );
    expect((await restarted.step(runId)).turn).toBe(1);
    expect(await controller.port.readEvents(runId, 'turns')).toHaveLength(2);
  }, 30_000);
});
