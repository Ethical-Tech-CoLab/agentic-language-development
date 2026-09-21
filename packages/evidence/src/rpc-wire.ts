import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function privateSocket(socketPath: string, requireSocket: boolean): void {
  if (!socketPath.startsWith('/')) throw new Error('evidence RPC socket must be absolute');
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0) {
    throw new Error('evidence RPC socket directory is not private');
  }
  if (requireSocket) {
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() ||
        (socket.mode & 0o077) !== 0) {
      throw new Error('evidence RPC socket is not private');
    }
  }
}

/** Reclaim a dead Unix-socket inode without ever unlinking a reachable server. */
async function reclaimStaleSocket(socketPath: string): Promise<void> {
  let original;
  try {
    original = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!original.isSocket() || original.isSymbolicLink()) {
    throw new Error('evidence RPC path exists and is not a socket');
  }
  const reachable = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('existing evidence RPC socket did not answer promptly'));
    }, 250);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
  if (reachable) {
    throw new Error('evidence RPC socket already accepts connections');
  }
  let current;
  try {
    current = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!current.isSocket() || current.isSymbolicLink() ||
      current.dev !== original.dev || current.ino !== original.ino) {
    throw new Error('evidence RPC socket changed during stale-path check');
  }
  unlinkSync(socketPath);
}

/** The writer's private socket transport; callers supply an exact capability. */
export async function createEvidenceRpcServer(
  socketPath: string,
  runId: string,
  protocol: string,
  methods: readonly string[],
  validArgs: (method: string, args: unknown[]) => boolean,
  dispatch: (method: string, args: unknown[]) => Promise<unknown> | unknown,
): Promise<Server> {
  privateSocket(socketPath, false);
  await reclaimStaleSocket(socketPath);
  if (!runId) throw new Error('evidence RPC run ID is required');
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
            reply = { ok: true, protocol, runId, processId: process.pid };
          } else if (record(message) && message['runId'] === runId &&
              typeof message['op'] === 'string' && methods.includes(message['op']) &&
              exactKeys(message, ['op', 'runId', 'args']) &&
              Array.isArray(message['args']) &&
              validArgs(message['op'], message['args'])) {
            const result = await dispatch(message['op'], message['args']);
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
    socket.setTimeout(RPC_TIMEOUT_MS, () => fail(new Error('evidence RPC timed out')));
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
    socket.on('close', () => { if (!done) fail(new Error('evidence RPC disconnected')); });
  });
}

/** Handshake and one-shot calls; an uncertain response is never retried. */
export async function connectEvidenceRpc(
  socketPath: string,
  runId: string,
  protocol: string,
): Promise<{ processId: number; call: (method: string, args: unknown[]) => Promise<unknown> }> {
  privateSocket(socketPath, true);
  const hello = await request(socketPath, { op: 'hello', runId });
  if (!record(hello) || !exactKeys(hello, ['ok', 'protocol', 'runId', 'processId']) ||
      hello['ok'] !== true || hello['protocol'] !== protocol ||
      hello['runId'] !== runId || !Number.isSafeInteger(hello['processId']) ||
      Number(hello['processId']) < 1) {
    throw new Error('evidence RPC identity does not match');
  }
  return {
    processId: Number(hello['processId']),
    call: async (method, args) => {
      const reply = await request(socketPath, { op: method, runId, args });
      if (!record(reply) || !exactKeys(reply, ['ok', 'result']) || reply['ok'] !== true) {
        throw new Error('evidence RPC result was not confirmed');
      }
      return reply['result'];
    },
  };
}
