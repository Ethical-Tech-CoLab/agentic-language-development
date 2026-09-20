import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectDomainSignerRegistryRpc,
  verifyHashSignature,
} from '@ald/hashing';
import { SIGNER_DOMAINS, type SignerDomain } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupTemporaryDirectories,
  createWriter,
  intentionDraft,
  proposal,
} from './fixtures/support.js';

const fixture = fileURLToPath(new URL(
  '../../hashing/__tests__/fixtures/domain-signer-child.mjs', import.meta.url));
const runId = 'run-test-001';

afterEach(cleanupTemporaryDirectories);

describe('evidence writer with six remote domain signers', () => {
  it('commits an atomic turn and rolls back after a signer process dies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-writer-signers-'));
    const sockets = {} as Record<SignerDomain, string>;
    const children = SIGNER_DOMAINS.map((domain) => {
      const socketPath = join(directory, `${domain}.sock`);
      sockets[domain] = socketPath;
      return spawn(process.execPath, [fixture, socketPath, runId, domain], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });
    let context: Awaited<ReturnType<typeof createWriter>> | undefined;
    try {
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('signer fixture did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString() === 'ready\n') resolve();
          else reject(new Error('signer fixture readiness malformed'));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('signer fixture exited before ready')));
      })));
      const signers = await connectDomainSignerRegistryRpc(runId, sockets);
      context = await createWriter({ signers });
      const request = (turn: number) => ({
        runId,
        turn,
        sender: 'baby-a' as const,
        recipient: 'baby-b' as const,
        carrier: 'fixed-token' as const,
        communicationCondition: 'normal' as const,
        proposal,
        intentionDraft: intentionDraft(),
        deliveredArtifact: proposal.publicArtifact,
      });
      const committed = await context.writer.commitTurn(request(1));
      for (const [domain, event] of [
        ['baby-a-ledger', committed.senderLedgerEvent],
        ['channel', committed.channelEvent],
      ] as const) {
        const key = signers.signer(domain).publicKey;
        expect(verifyHashSignature(event.entryHash, event.writerSignature, key)).toBe(true);
      }
      expect(context.writer.readEvents(runId, 'baby-a-ledger')).toHaveLength(1);
      expect(context.writer.readEvents(runId, 'channel')).toHaveLength(1);

      const roleIndex = SIGNER_DOMAINS.indexOf('baby-a-ledger');
      const roleProcess = children[roleIndex]!;
      roleProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => roleProcess.once('exit', () => resolve()));
      await expect(context.writer.commitTurn(request(2))).rejects.toThrow();
      expect(context.writer.readEvents(runId, 'baby-a-ledger')).toHaveLength(1);
      expect(context.writer.readEvents(runId, 'channel')).toHaveLength(1);
    } finally {
      context?.close();
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => child.once('exit', () => resolve()));
        }
      }));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
