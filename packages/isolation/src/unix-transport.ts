/** Private Unix-domain transport for Controller-to-Gateway learner relays. */
import { chmodSync, lstatSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

import type { FrameChannel } from './channel.js';
import { IsolationError } from './errors.js';
import type { HostTransport } from './remote-adapter.js';

function assertPrivateSocketDirectory(socketPath: string): void {
  if (!isAbsolute(socketPath)) throw new IsolationError('configuration');
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0) {
    throw new IsolationError('configuration');
  }
}

/** One Unix-domain socket as a framed learner channel. */
export class UnixFrameChannel implements FrameChannel {
  readonly kind = 'unix' as const;

  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(private readonly socket: Socket) {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.lineHandler?.(chunk));
    this.socket.on('error', () => this.settle());
    this.socket.on('close', () => this.settle());
    this.socket.on('end', () => this.settle());
  }

  write(lines: readonly string[]): void {
    if (this.closed) throw new IsolationError('host-unavailable');
    for (const line of lines) this.socket.write(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) handler();
  }

  close(): void {
    if (!this.closed) {
      this.socket.end();
      this.socket.destroy();
    }
    this.settle();
  }

  private settle(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}

export interface UnixConnectOptions {
  socketPath: string;
  timeoutMs?: number;
  hostLabel?: string;
}

export async function connectUnixFrameChannel(
  options: UnixConnectOptions,
): Promise<UnixFrameChannel> {
  assertPrivateSocketDirectory(options.socketPath);
  const target = lstatSync(options.socketPath);
  if (!target.isSocket() || target.isSymbolicLink() || (target.mode & 0o077) !== 0) {
    throw new IsolationError('connect-failed');
  }
  return new Promise<UnixFrameChannel>((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    const fail = (cause: unknown): void => {
      socket.destroy();
      reject(new IsolationError('connect-failed', { cause }));
    };
    socket.setTimeout(options.timeoutMs ?? 10_000, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(new UnixFrameChannel(socket));
    });
  });
}

export interface UnixFrameServerOptions {
  socketPath: string;
  onChannel: (channel: UnixFrameChannel) => void;
}

export interface UnixFrameServer {
  readonly socketPath: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** One private socket that admits exactly one Controller for its lifetime. */
export async function createUnixFrameServer(
  options: UnixFrameServerOptions,
): Promise<UnixFrameServer> {
  assertPrivateSocketDirectory(options.socketPath);
  let admitted = false;
  const server = createServer((socket) => {
    const channel = new UnixFrameChannel(socket);
    if (admitted) {
      channel.close();
      return;
    }
    admitted = true;
    options.onChannel(channel);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(options.socketPath, 0o600);
  } catch (cause) {
    server.close();
    throw new IsolationError('configuration', { cause });
  }
  return {
    socketPath: options.socketPath,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Controller-side transport whose only destination is one Gateway socket. */
export class UnixHostTransport implements HostTransport {
  readonly boundary = 'separate-container' as const;
  readonly hostLabel: string | undefined;
  private channel: UnixFrameChannel | undefined;

  constructor(private readonly options: UnixConnectOptions) {
    this.hostLabel = options.hostLabel;
  }

  current(): FrameChannel | undefined {
    return this.channel;
  }

  async open(): Promise<FrameChannel> {
    this.channel ??= await connectUnixFrameChannel(this.options);
    return this.channel;
  }

  terminate(): Promise<void> {
    this.channel?.close();
    this.channel = undefined;
    return Promise.resolve();
  }
}
