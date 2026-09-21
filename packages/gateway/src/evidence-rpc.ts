import { chmodSync, lstatSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  AffectEventSchema,
  ChannelEventSchema,
  DeliveredChannelArtifactSchema,
  InterventionEventSchema,
  LedgerEventSchema,
} from '@ald/types';

import type { GatewayEvidencePort } from './evidence-port.js';

type WriteMethod = keyof GatewayEvidencePort;
const METHODS: readonly WriteMethod[] = [
  'commitTurn',
  'commitRejection',
  'commitControlArtifact',
  'appendLedgerEvent',
  'appendInterventionEvent',
  'appendAffectEvent',
];
const PROTOCOL = 'gateway-evidence-v1';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

export interface GatewayEvidenceRpcServerOptions {
  responseDelay?: {
    method: keyof GatewayEvidencePort;
    milliseconds: number;
  };
}

export interface GatewayEvidenceRpcClientOptions {
  timeoutMs?: number;
}

function timeout(value: number | undefined): number {
  const resolved = value ?? RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 120_000) {
    throw new Error('evidence RPC timeout must be an integer from 1 to 120000 ms');
  }
  return resolved;
}

function privateDirectory(socketPath: string): void {
  if (!socketPath.startsWith('/')) throw new Error('evidence RPC socket must be absolute');
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0) {
    throw new Error('evidence RPC socket directory is not private');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/**
 * One run-scoped local writer endpoint. Directory ownership and selected
 * container mounts must restrict callers; this component alone is not B12.
 */
export async function createGatewayEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: GatewayEvidencePort,
  options: GatewayEvidenceRpcServerOptions = {},
): Promise<Server> {
  privateDirectory(socketPath);
  if (runId.length === 0) throw new Error('evidence RPC run ID is required');
  const responseDelay = options.responseDelay;
  if (responseDelay !== undefined &&
      (!METHODS.includes(responseDelay.method) ||
       timeout(responseDelay.milliseconds) !== responseDelay.milliseconds)) {
    throw new Error('evidence RPC response delay is invalid');
  }
  const server = createServer((socket) => {
    let frame = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(RPC_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (received) {
        socket.destroy();
        return;
      }
      frame += chunk;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
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
              METHODS.includes(message['op'] as WriteMethod) &&
              exactKeys(message, ['op', 'runId', 'request']) &&
              record(message['request']) && message['request']['runId'] === runId) {
            const method = message['op'] as WriteMethod;
            const request = message['request'];
            const result = await (writer[method] as (value: unknown) => Promise<unknown>)
              .call(writer, request);
            if (responseDelay?.method === method) {
              await delay(responseDelay.milliseconds);
            }
            reply = { ok: true, result };
          }
        } catch {
          // No request body, writer error, or private draft is echoed.
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

function request(
  socketPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const serialized = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
      reject(new Error('evidence RPC request exceeded frame limit'));
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
    socket.setTimeout(timeoutMs, () => fail(new Error('evidence RPC timed out')));
    socket.on('connect', () => socket.write(serialized));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_FRAME_BYTES) {
        fail(new Error('evidence RPC response exceeded frame limit'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline < 0 || done) return;
      if (response.slice(newline + 1).length > 0) {
        fail(new Error('evidence RPC response contains extra frames'));
        return;
      }
      done = true;
      socket.destroy();
      try { resolve(JSON.parse(response.slice(0, newline)) as unknown); }
      catch { reject(new Error('evidence RPC response is malformed')); }
    });
    socket.on('error', fail);
    socket.on('close', () => {
      if (!done) fail(new Error('evidence RPC disconnected'));
    });
  });
}

/** Connect a six-write Gateway port; this client never retries an uncertain call. */
export async function connectGatewayEvidenceRpc(
  socketPath: string,
  runId: string,
  options: GatewayEvidenceRpcClientOptions = {},
): Promise<{ port: GatewayEvidencePort; processId: number }> {
  privateDirectory(socketPath);
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() ||
      (socket.mode & 0o077) !== 0) {
    throw new Error('evidence RPC socket is not private');
  }
  const timeoutMs = timeout(options.timeoutMs);
  const hello = await request(socketPath, { op: 'hello', runId }, timeoutMs);
  if (!record(hello) || !exactKeys(hello, ['ok', 'protocol', 'runId', 'processId']) ||
      hello['ok'] !== true || hello['protocol'] !== PROTOCOL ||
      hello['runId'] !== runId || !Number.isSafeInteger(hello['processId']) ||
      Number(hello['processId']) < 1) {
    throw new Error('evidence RPC identity does not match');
  }
  const call = async (op: WriteMethod, value: unknown): Promise<unknown> => {
    const reply = await request(socketPath, { op, runId, request: value }, timeoutMs);
    if (!record(reply) || !exactKeys(reply, ['ok', 'result']) || reply['ok'] !== true) {
      throw new Error('evidence RPC write was not confirmed');
    }
    return reply['result'];
  };
  return {
    processId: Number(hello['processId']),
    port: {
      commitTurn: async (value) => {
        const result = await call('commitTurn', value);
        if (!record(result) || !exactKeys(result,
          ['senderLedgerEvent', 'channelEvent', 'delivery'])) {
          throw new Error('evidence RPC turn result is malformed');
        }
        return {
          senderLedgerEvent: LedgerEventSchema.parse(result['senderLedgerEvent']),
          channelEvent: ChannelEventSchema.parse(result['channelEvent']),
          delivery: result['delivery'] === null
            ? null : DeliveredChannelArtifactSchema.parse(result['delivery']),
        };
      },
      commitRejection: async (value) => ChannelEventSchema.parse(
        await call('commitRejection', value)),
      commitControlArtifact: async (value) => {
        const result = await call('commitControlArtifact', value);
        if (!record(result) || !exactKeys(result, ['channelEvent', 'delivery'])) {
          throw new Error('evidence RPC control result is malformed');
        }
        return {
          channelEvent: ChannelEventSchema.parse(result['channelEvent']),
          delivery: DeliveredChannelArtifactSchema.parse(result['delivery']),
        };
      },
      appendLedgerEvent: async (value) => LedgerEventSchema.parse(
        await call('appendLedgerEvent', value)),
      appendInterventionEvent: async (value) => InterventionEventSchema.parse(
        await call('appendInterventionEvent', value)),
      appendAffectEvent: async (value) => AffectEventSchema.parse(
        await call('appendAffectEvent', value)),
    },
  };
}
