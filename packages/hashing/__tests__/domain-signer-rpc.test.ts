import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SIGNER_DOMAINS, type SignerDomain } from '@ald/types';

import { domainHash, verifyHashSignature } from '../src/index.js';
import {
  connectDomainSignerRegistryRpc,
  connectDomainSignerRpc,
} from '../src/domain-signer-rpc.js';

const fixture = fileURLToPath(new URL('./fixtures/domain-signer-child.mjs', import.meta.url));
const runId = 'signer-process-qualification';
const domain = 'baby-a-ledger';

function rawRequest(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${message}\n`));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('one-domain Unix-socket signer process', () => {
  it('keeps the key in a distinct process and rejects wrong identity and frames', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-signer-rpc-'));
    const socketPath = join(directory, 'signer.sock');
    const child = spawn(process.execPath, [fixture, socketPath, runId, domain], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('signer fixture did not start')), 5_000);
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString() === 'ready\n') resolve();
          else reject(new Error('signer fixture readiness malformed'));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('signer fixture exited before ready')));
      });
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const { signer, processId } = await connectDomainSignerRpc(socketPath, runId, domain);
      expect(processId).toBe(child.pid);
      expect(processId).not.toBe(process.pid);
      expect(Object.keys(signer).sort()).toEqual(['domain', 'keyId', 'publicKey', 'sign']);
      const hash = domainHash('dtsf-test-v1', 'remote-signer');
      const signature = await signer.sign(hash);
      expect(verifyHashSignature(hash, signature, signer.publicKey)).toBe(true);
      chmodSync(directory, 0o755);
      await expect(connectDomainSignerRpc(socketPath, runId, domain)).rejects.toThrow();
      chmodSync(directory, 0o700);
      await expect(connectDomainSignerRpc(socketPath, 'another-run', domain)).rejects.toThrow();
      await expect(connectDomainSignerRpc(socketPath, runId, 'baby-b-ledger')).rejects.toThrow();
      await expect(signer.sign('not-a-hash')).rejects.toThrow();
      expect(await rawRequest(socketPath, JSON.stringify({ op: 'sign', runId, hash,
        domain: 'baby-b-ledger' }))).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, JSON.stringify({ op: 'sign',
        runId: 'another-run', hash }))).toBe('{"ok":false}\n');
      expect(await rawRequest(socketPath, JSON.stringify({ op: 'sign',
        runId, hash: 'not-a-hash' }))).toBe('{"ok":false}\n');
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect(signer.sign(hash)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('assembles six distinct processes into a writer-compatible registry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-signer-registry-'));
    const sockets = {} as Record<SignerDomain, string>;
    const children = SIGNER_DOMAINS.map((signerDomain) => {
      const socketPath = join(directory, `${signerDomain}.sock`);
      sockets[signerDomain] = socketPath;
      return spawn(process.execPath, [fixture, socketPath, runId, signerDomain], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });
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
      const registry = await connectDomainSignerRegistryRpc(runId, sockets);
      expect(registry.runId).toBe(runId);
      expect(registry.publicKeys()).toHaveLength(SIGNER_DOMAINS.length);
      const hash = domainHash('dtsf-test-v1', 'six-process-registry');
      for (const { domain: signerDomain, publicKey } of registry.publicKeys()) {
        const signature = await registry.signer(signerDomain).sign(hash);
        expect(verifyHashSignature(hash, signature, publicKey)).toBe(true);
      }
      await expect(connectDomainSignerRegistryRpc('wrong-run', sockets)).rejects.toThrow();
      await expect(connectDomainSignerRegistryRpc(runId, {
        ...sockets,
        'baby-b-ledger': sockets['baby-a-ledger'],
      })).rejects.toThrow();
    } finally {
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
