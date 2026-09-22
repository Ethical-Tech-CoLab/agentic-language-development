import { chmodSync, lstatSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import {
  SIGNER_DOMAINS,
  SIGNER_KEY_IDS,
  type DomainSigner,
  type SignerDomain,
  type SignerRegistry,
} from '@ald/types';

import { decodePublicKey, verifyHashSignature } from './ed25519.js';
import { isSha256Hash } from './sha256.js';

const MAX_FRAME_BYTES = 512;
const RPC_TIMEOUT_MS = 1_000;

function assertPrivateSocketDirectory(socketPath: string): void {
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0) {
    throw new Error('signer RPC socket directory is not private');
  }
}

type PublicReply = {
  ok: true;
  domain: SignerDomain;
  runId: string;
  keyId: string;
  publicKey: string;
  processId: number;
};
type SignReply = { ok: true; signature: string };
type FailureReply = { ok: false };

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}

/**
 * One domain per local Unix-socket process. Socket ownership and container
 * mounts are the caller's authority boundary; this protocol never carries a
 * seed or private key. It does not itself qualify a Mode R deployment.
 */
export async function createDomainSignerRpcServer(
  socketPath: string,
  runId: string,
  signer: DomainSigner,
): Promise<Server> {
  if (!socketPath.startsWith('/')) throw new Error('signer socket must be absolute');
  if (runId.length === 0) throw new Error('signer run ID is required');
  assertPrivateSocketDirectory(socketPath);
  const server = createServer((socket) => {
    let frame = '';
    socket.setEncoding('utf8');
    // A caller may time out or tear down its container after sending a valid
    // request. That disconnect is local to this connection and must not take
    // down the one-domain signer process or unrelated evidence writers.
    socket.on('error', () => socket.destroy());
    socket.setTimeout(RPC_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = frame.indexOf('\n');
      if (newline < 0) return;
      const message = frame.slice(0, newline);
      if (frame.slice(newline + 1).length > 0) {
        socket.end(`${JSON.stringify({ ok: false } satisfies FailureReply)}\n`);
        return;
      }
      socket.removeAllListeners('data');
      void (async () => {
        let reply: PublicReply | SignReply | FailureReply = { ok: false };
        try {
          const parsed: unknown = JSON.parse(message);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const request = parsed as Record<string, unknown>;
            if (exactKeys(request, ['op', 'runId']) &&
                request['op'] === 'public-key' && request['runId'] === runId) {
              reply = {
                ok: true,
                domain: signer.domain,
                runId,
                keyId: signer.keyId,
                publicKey: signer.publicKey,
                processId: process.pid,
              };
            } else if (exactKeys(request, ['op', 'hash', 'runId']) &&
                request['op'] === 'sign' && request['runId'] === runId &&
                isSha256Hash(request['hash'])) {
              reply = { ok: true, signature: await signer.sign(request['hash']) };
            }
          }
        } catch {
          // No request bytes or private material appear in the failure frame.
        }
        socket.end(`${JSON.stringify(reply)}\n`);
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

function request(socketPath: string, payload: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let response = '';
    let done = false;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(RPC_TIMEOUT_MS, () => fail(new Error('signer RPC timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_FRAME_BYTES) {
        fail(new Error('signer RPC response exceeded frame limit'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline < 0 || done) return;
      if (response.slice(newline + 1).length > 0) {
        fail(new Error('signer RPC response contains extra frames'));
        return;
      }
      done = true;
      socket.destroy();
      try { resolve(JSON.parse(response.slice(0, newline)) as unknown); }
      catch { reject(new Error('signer RPC response is malformed')); }
    });
    socket.on('error', fail);
    socket.on('close', () => {
      if (!done) fail(new Error('signer RPC disconnected'));
    });
  });
}

/** Returns only the public face of one remote, fixed-domain signer. */
export async function connectDomainSignerRpc(
  socketPath: string,
  expectedRunId: string,
  expectedDomain: SignerDomain,
): Promise<{ signer: DomainSigner; processId: number }> {
  assertPrivateSocketDirectory(socketPath);
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0) {
    throw new Error('signer RPC socket is not private');
  }
  const raw = await request(socketPath, { op: 'public-key', runId: expectedRunId });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('signer RPC public-key response is malformed');
  }
  const reply = raw as Record<string, unknown>;
  if (!exactKeys(reply, ['ok', 'domain', 'runId', 'keyId', 'publicKey', 'processId']) ||
      reply['ok'] !== true || reply['domain'] !== expectedDomain ||
      reply['runId'] !== expectedRunId ||
      reply['keyId'] !== SIGNER_KEY_IDS[expectedDomain] ||
      typeof reply['publicKey'] !== 'string' ||
      !Number.isSafeInteger(reply['processId']) || Number(reply['processId']) < 1) {
    throw new Error('signer RPC public-key identity does not match');
  }
  decodePublicKey(reply['publicKey']);
  const publicKey = reply['publicKey'];
  return {
    processId: Number(reply['processId']),
    signer: {
      domain: expectedDomain,
      keyId: SIGNER_KEY_IDS[expectedDomain],
      publicKey,
      sign: async (hash) => {
        if (!isSha256Hash(hash)) throw new Error('signer RPC hash is malformed');
        const rawSignature = await request(socketPath,
          { op: 'sign', runId: expectedRunId, hash });
        if (typeof rawSignature !== 'object' || rawSignature === null ||
            Array.isArray(rawSignature)) {
          throw new Error('signer RPC signature response is malformed');
        }
        const signed = rawSignature as Record<string, unknown>;
        if (!exactKeys(signed, ['ok', 'signature']) || signed['ok'] !== true ||
            typeof signed['signature'] !== 'string' ||
            !verifyHashSignature(hash, signed['signature'], publicKey)) {
          throw new Error('signer RPC signature response is invalid');
        }
        return signed['signature'];
      },
    },
  };
}

/**
 * Preconnect all six fixed domains before the synchronous writer constructor.
 * Distinct socket endpoints and public keys prevent accidental reuse. PIDs
 * may repeat across container namespaces, so the selected topology must
 * verify container identities and mounts independently.
 */
export async function connectDomainSignerRegistryRpc(
  runId: string,
  sockets: Record<SignerDomain, string>,
): Promise<SignerRegistry> {
  if (new Set(SIGNER_DOMAINS.map((domain) => sockets[domain])).size !==
      SIGNER_DOMAINS.length) {
    throw new Error('signer domains must use distinct socket endpoints');
  }
  const connections = await Promise.all(SIGNER_DOMAINS.map((domain) =>
    connectDomainSignerRpc(sockets[domain], runId, domain)));
  if (new Set(connections.map(({ signer }) => signer.publicKey)).size !== SIGNER_DOMAINS.length) {
    throw new Error('signer domains must have distinct public keys');
  }
  const signers = new Map(SIGNER_DOMAINS.map((domain, index) => [
    domain,
    connections[index]!.signer,
  ]));
  return {
    runId,
    signer: (domain) => {
      const signer = signers.get(domain);
      if (!signer) throw new Error(`signer domain ${domain} is unavailable`);
      return signer;
    },
    publicKeys: () => SIGNER_DOMAINS.map((domain) => {
      const { keyId, publicKey } = signers.get(domain)!;
      return { domain, keyId, publicKey };
    }),
  };
}
