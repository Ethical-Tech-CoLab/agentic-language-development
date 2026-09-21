import { chmodSync, lstatSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import {
  AnchorReceiptSchema,
  CheckpointManifestSchema,
  ExperimentRecordSchema,
  InterventionEventSchema,
  SignerPublicKeyRecordSchema,
  TurnRecordSchema,
  type EvidenceWriter,
} from '@ald/types';

import type { SqliteEvidenceWriter } from './writer.js';

const METHODS = [
  'registerRun', 'readRunMetadata', 'chainHead', 'readEvents',
  'readCheckpoints', 'readAnchorReceipts', 'readExperimentRecords',
  'readAnalysisAttachments', 'readRunSigners', 'readForkArtifacts',
  'appendTurnRecord', 'appendInterventionEvent', 'appendAnalysisAttachment',
  'appendExperimentRecord', 'recover',
] as const;
type ControllerMethod = (typeof METHODS)[number];
type WriterMethods = EvidenceWriter & Pick<SqliteEvidenceWriter, 'readForkArtifacts'>;
type AsyncMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>> : never;

export type ControllerEvidencePort = {
  [K in ControllerMethod]: AsyncMethod<WriterMethods[K]>;
};

const PROTOCOL = 'controller-evidence-v1';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function privateSocket(socketPath: string, requireSocket: boolean): void {
  if (!socketPath.startsWith('/')) throw new Error('controller evidence socket must be absolute');
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0) {
    throw new Error('controller evidence socket directory is not private');
  }
  if (requireSocket) {
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() ||
        (socket.mode & 0o077) !== 0) {
      throw new Error('controller evidence socket is not private');
    }
  }
}

function callRunId(method: ControllerMethod, args: unknown[]): unknown {
  const first = args[0];
  return method === 'registerRun' || method.startsWith('append')
    ? record(first) ? first['runId'] : undefined
    : first;
}

function validHash(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function resultFor(method: ControllerMethod, result: unknown, runId: string): unknown {
  if (method === 'registerRun') {
    if (!record(result) || !validHash(result['configurationHash'])) {
      throw new Error('controller evidence registration result is malformed');
    }
    return result;
  }
  if (method === 'appendTurnRecord') return TurnRecordSchema.parse(result);
  if (method === 'appendInterventionEvent') return InterventionEventSchema.parse(result);
  if (method === 'appendExperimentRecord') {
    if (result !== null) throw new Error('controller evidence append result is malformed');
    return undefined;
  }
  if (method === 'readRunMetadata') {
    if (result === null) return undefined;
    if (!record(result) || result['runId'] !== runId ||
        !validHash(result['configurationHash'])) {
      throw new Error('controller evidence metadata is malformed');
    }
    return result;
  }
  if (method === 'chainHead') {
    if (!record(result) || typeof result['stream'] !== 'string' ||
        !Number.isSafeInteger(result['size']) || Number(result['size']) < 0 ||
        !validHash(result['lastEntryHash'])) {
      throw new Error('controller evidence chain head is malformed');
    }
    return result;
  }
  if (method === 'appendAnalysisAttachment') {
    if (!record(result) || !record(result['descriptor']) ||
        typeof result['canonicalJson'] !== 'string') {
      throw new Error('controller evidence attachment result is malformed');
    }
    return result;
  }
  if (method === 'recover') {
    if (!record(result) || result['runId'] !== runId ||
        typeof result['ok'] !== 'boolean' || !Array.isArray(result['heads']) ||
        !Array.isArray(result['forks']) || !Array.isArray(result['chainViolations'])) {
      throw new Error('controller evidence recovery result is malformed');
    }
    return result;
  }
  if (!Array.isArray(result)) throw new Error('controller evidence read result is malformed');
  if (method === 'readCheckpoints') return result.map((row) => CheckpointManifestSchema.parse(row));
  if (method === 'readAnchorReceipts') return result.map((row) => AnchorReceiptSchema.parse(row));
  if (method === 'readExperimentRecords') return result.map((row) => ExperimentRecordSchema.parse(row));
  if (method === 'readRunSigners') return result.map((row) => SignerPublicKeyRecordSchema.parse(row));
  if (method === 'readEvents' && result.some((row) => !record(row) ||
      !validHash(row['entryHash']) || typeof row['canonicalJson'] !== 'string')) {
    throw new Error('controller evidence event read is malformed');
  }
  return result;
}

/** A caller-exclusive socket mount is required; this component alone is not B12. */
export async function createControllerEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: SqliteEvidenceWriter,
): Promise<Server> {
  privateSocket(socketPath, false);
  if (!runId) throw new Error('controller evidence run ID is required');
  const server = createServer((socket) => {
    let frame = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(RPC_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (received) { socket.destroy(); return; }
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const newline = frame.indexOf('\n');
      if (newline < 0) return;
      received = true;
      if (frame.slice(newline + 1).length > 0) {
        socket.end('{"ok":false}\n');
        return;
      }
      void (async () => {
        let reply: unknown = { ok: false };
        try {
          const message: unknown = JSON.parse(frame.slice(0, newline));
          if (record(message) && message['runId'] === runId &&
              message['op'] === 'hello' && exactKeys(message, ['op', 'runId'])) {
            reply = { ok: true, protocol: PROTOCOL, runId, processId: process.pid };
          } else if (record(message) && message['runId'] === runId &&
              typeof message['op'] === 'string' &&
              METHODS.includes(message['op'] as ControllerMethod) &&
              exactKeys(message, ['op', 'runId', 'args']) &&
              Array.isArray(message['args']) &&
              callRunId(message['op'] as ControllerMethod, message['args']) === runId) {
            const method = message['op'] as ControllerMethod;
            const operation = writer[method] as (...args: unknown[]) => unknown;
            const result: unknown = await operation.apply(writer, message['args']);
            reply = { ok: true, result: result ?? null };
          }
        } catch {
          // Do not echo private requests, drafts, or writer exceptions.
        }
        const response = `${JSON.stringify(reply)}\n`;
        socket.end(Buffer.byteLength(response) <= MAX_FRAME_BYTES
          ? response : '{"ok":false}\n');
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

function request(socketPath: string, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const serialized = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
      reject(new Error('controller evidence request exceeded frame limit'));
      return;
    }
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
    socket.setTimeout(RPC_TIMEOUT_MS, () => fail(new Error('controller evidence RPC timed out')));
    socket.on('connect', () => socket.write(serialized));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_FRAME_BYTES) {
        fail(new Error('controller evidence response exceeded frame limit'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline < 0 || done) return;
      if (response.slice(newline + 1).length > 0) {
        fail(new Error('controller evidence response contains extra frames'));
        return;
      }
      done = true;
      socket.destroy();
      try { resolve(JSON.parse(response.slice(0, newline)) as unknown); }
      catch { reject(new Error('controller evidence response is malformed')); }
    });
    socket.on('error', fail);
    socket.on('close', () => { if (!done) fail(new Error('controller evidence RPC disconnected')); });
  });
}

/** No request is retried after an uncertain response. */
export async function connectControllerEvidenceRpc(
  socketPath: string,
  runId: string,
): Promise<{ port: ControllerEvidencePort; processId: number }> {
  privateSocket(socketPath, true);
  const hello = await request(socketPath, { op: 'hello', runId });
  if (!record(hello) || !exactKeys(hello, ['ok', 'protocol', 'runId', 'processId']) ||
      hello['ok'] !== true || hello['protocol'] !== PROTOCOL ||
      hello['runId'] !== runId || !Number.isSafeInteger(hello['processId']) ||
      Number(hello['processId']) < 1) {
    throw new Error('controller evidence RPC identity does not match');
  }
  const port = Object.fromEntries(METHODS.map((method) => [method,
    async (...args: unknown[]) => {
      if (callRunId(method, args) !== runId) {
        throw new Error('controller evidence request run ID does not match');
      }
      const reply = await request(socketPath, { op: method, runId, args });
      if (!record(reply) || !exactKeys(reply, ['ok', 'result']) || reply['ok'] !== true) {
        throw new Error('controller evidence RPC result was not confirmed');
      }
      return resultFor(method, reply['result'], runId);
    },
  ])) as ControllerEvidencePort;
  return { port, processId: Number(hello['processId']) };
}
