import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import {
  connectAnchorEvidenceRpc,
  connectAuditEvidenceRpc,
  connectCheckpointEvidenceRpc,
  connectControllerEvidenceRpc,
  exportRunBundle,
  openEvidenceDatabase,
} from '@ald/evidence';
import { connectGatewayEvidenceRpc } from '@ald/gateway';
import { connectDomainSignerRpc, verifyHashSignature } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import type { SignerRegistry } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { AuditLedgerInterpreter } from '../src/audit-interpreter.js';
import type { EvidenceWriterCapabilitySockets } from '../src/evidence-writer-host.js';

const writerFixture = fileURLToPath(new URL(
  './fixtures/evidence-writer-host-child.mjs', import.meta.url));
const signerFixture = fileURLToPath(new URL(
  '../../hashing/__tests__/fixtures/domain-signer-child.mjs', import.meta.url));

function ready(child: ChildProcess, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let error = '';
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    const timer = setTimeout(() => reject(new Error(`${label} did not start: ${error}`)), 5_000);
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk.toString());
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`${label} exited before ready: ${error}`)));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

describe('single-owner Evidence Writer RPC host', () => {
  it('serves five exact capabilities from one writer process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-writer-host-'));
    const config = buildRunConfig({
      runId: 'run-writer-host',
      experimentId: 'E00',
      randomSeed: 'writer-host-seed',
      promptBundleHash: `sha256:${'b'.repeat(64)}`,
    });
    const witnessSocket = join(directory, 'witness.sock');
    const sockets: EvidenceWriterCapabilitySockets = {
      controller: join(directory, 'controller.sock'),
      gateway: join(directory, 'gateway.sock'),
      checkpoint: join(directory, 'checkpoint.sock'),
      anchor: join(directory, 'anchor.sock'),
      audit: join(directory, 'audit.sock'),
    };
    const databasePath = join(directory, 'evidence.sqlite');
    const signer = spawn(process.execPath,
      [signerFixture, witnessSocket, config.runId, 'witness'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let writer: ChildProcess | undefined;
    try {
      expect(await ready(signer, 'witness signer')).toBe('ready\n');
      const witness = await connectDomainSignerRpc(
        witnessSocket, config.runId, 'witness');
      writer = spawn(process.execPath, [writerFixture, databasePath,
        JSON.stringify(config), JSON.stringify(sockets), witnessSocket],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      const writerReady = JSON.parse(await ready(writer, 'evidence writer')) as {
        processId: number;
      };
      expect(writerReady.processId).toBe(writer.pid);

      const [controller, gateway, checkpoint, anchor, audit] = await Promise.all([
        connectControllerEvidenceRpc(sockets.controller, config.runId),
        connectGatewayEvidenceRpc(sockets.gateway, config.runId),
        connectCheckpointEvidenceRpc(sockets.checkpoint, config.runId),
        connectAnchorEvidenceRpc(sockets.anchor, config.runId),
        connectAuditEvidenceRpc(sockets.audit, config.runId),
      ]);
      for (const connection of [controller, gateway, checkpoint, anchor, audit]) {
        expect(connection.processId).toBe(writer.pid);
        expect(connection.processId).not.toBe(process.pid);
        expect(connection.processId).not.toBe(signer.pid);
      }
      const graph = JSON.parse(readFileSync(
        'protocols/mode-r-authority-graph.v2.json', 'utf8')) as {
        writerCapabilities: Record<string, { methods: string[] }>;
      };
      for (const [name, port] of [
        ['controller-writer', controller.port],
        ['gateway-writer', gateway.port],
        ['checkpoint-writer', checkpoint.port],
        ['anchor-writer', anchor.port],
        ['audit-writer', audit.port],
      ] as const) {
        expect(Object.keys(port).sort()).toEqual(
          [...(graph.writerCapabilities[name]?.methods ?? [])].sort());
      }

      const registration = await controller.port.registerRun(config);
      expect(registration.configurationHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const turn = await gateway.port.commitTurn({
        runId: config.runId,
        turn: 1,
        sender: 'baby-a',
        recipient: 'baby-b',
        carrier: 'fixed-token',
        communicationCondition: 'normal',
        proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
        intentionDraft: {
          eventType: 'intention.recorded',
          contentSchema: 'agent-native-ledger',
          subjectId: `sha256:${'d'.repeat(64)}`,
          content: { artifactRef: 'writer-host-artifact' },
          blindingNonce: 'writer-host-nonce',
          evidenceRefs: [],
        },
        deliveredArtifact: { symbols: ['S01'] },
      });
      expect(await controller.port.readEvents(config.runId, 'channel')).toHaveLength(1);
      expect((await checkpoint.port.readEvents(
        config.runId, 'baby-a-ledger'))[0]?.entryHash)
        .toBe(turn.senderLedgerEvent.entryHash);

      const interpreter = new AuditLedgerInterpreter(audit.port);
      const [auditEntry] = await interpreter.appendBatch({
        runId: config.runId,
        interpreterVersion: 'writer-host-audit-v1',
        entries: [{
          babyId: 'A',
          sourceEntryHash: turn.senderLedgerEvent.entryHash,
          content: { term: 'S01', hypothesis: 'fixture', evidence: 'signed source' },
        }],
      }, 3);
      expect(auditEntry.sourceEntryHash).toBe(turn.senderLedgerEvent.entryHash);

      const signers: SignerRegistry = {
        runId: config.runId,
        signer: (domain) => {
          if (domain !== 'witness') throw new Error('checkpoint client has only witness authority');
          return witness.signer;
        },
        publicKeys: () => [{
          domain: 'witness', keyId: witness.signer.keyId,
          publicKey: witness.signer.publicKey,
        }],
      };
      const checkpointService = new EvidenceCheckpointService({
        evidence: checkpoint.port,
        signers,
        clock: { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() },
        softwareCommit: 'git:writer-host-test',
      });
      const manifest = await checkpointService.createCheckpoint(
        config.runId, 'run-initialized');
      expect(verifyHashSignature(manifest.checkpointHash, manifest.witnessSignature,
        witness.signer.publicKey)).toBe(true);
      expect(await controller.port.readCheckpoints(config.runId)).toHaveLength(1);

      const chain = new FakeChainTransport();
      const publisher = new BaseAnchorPublisher({
        transport: chain,
        anchorClass: 'simulated',
        evidence: anchor.port,
        clock: { now: () => new Date('2026-01-01T00:00:01.000Z').toISOString() },
        anchorAddress: `0x${'1'.repeat(40)}`,
        finalityPolicy: '1-confirmation',
      });
      const submitted = await publisher.submit(manifest);
      chain.mineBlock(1);
      const confirmed = await publisher.awaitConfirmation(submitted);
      expect(confirmed.status).toBe('confirmed');
      expect(await controller.port.readAnchorReceipts(config.runId)).toHaveLength(1);

      const bundleDir = join(directory, 'bundle');
      const bundleManifest = await exportRunBundle(
        controller.port,
        config.runId,
        bundleDir,
        {
          softwareCommit: 'git:writer-host-test',
          learnerContracts: [...new Set([config.babyA.track, config.babyB.track])]
            .map((track) => ({ track, version: 'test', text: `# ${track}\n` })),
        },
      );
      expect(bundleManifest.runId).toBe(config.runId);
      expect(JSON.parse(readFileSync(
        join(bundleDir, 'anchors', 'base-receipts.json'), 'utf8'))).toHaveLength(1);
      expect(readFileSync(join(bundleDir, 'channel-transcript.jsonl'), 'utf8'))
        .toContain(turn.channelEvent.entryHash);

      await stop(writer);
      await expect(controller.port.readRunMetadata(config.runId)).rejects.toThrow();
      const database = openEvidenceDatabase(databasePath);
      try {
        expect(database.database.prepare(
          'SELECT COUNT(*) AS count FROM run_metadata').get()).toEqual({ count: 1 });
        expect(database.database.prepare(
          'SELECT COUNT(*) AS count FROM checkpoint_manifests').get()).toEqual({ count: 1 });
        expect(database.database.prepare(
          'SELECT COUNT(*) AS count FROM anchor_receipts').get()).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      if (writer) await stop(writer);
      await stop(signer);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
