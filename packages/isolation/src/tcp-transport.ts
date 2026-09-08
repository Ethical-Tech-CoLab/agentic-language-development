/**
 * Separate-container transport: the same frames over a TCP socket on a
 * container-internal network (SPEC §5.2, §5.3; ALD-055).
 *
 * The socket carries no authority of its own. It is reachable only from the
 * network the Nursery and that one Baby share (`deploy/mode-r/docker-compose.yml`
 * puts `baby-a` on `net-a`, `baby-b` on `net-b`, and only the `nursery`
 * service on both, with both networks `internal: true`), so the topology —
 * not this file — is what denies the Baby-to-Baby route and the internet.
 *
 * A host serves **one** connection at a time by default: one container is one
 * Baby (SPEC §4.1 item 5, "one `LearnerAdapter` process per Baby per track"),
 * and a second concurrent connection would mean two Babies sharing one
 * address space, which is exactly what Mode R exists to prevent.
 */
import { createServer, Socket, type Server } from 'node:net';

import { IsolationError } from './errors.js';
import type { FrameChannel } from './channel.js';

/** One TCP socket as a {@link FrameChannel}. */
export class TcpFrameChannel implements FrameChannel {
  readonly kind = 'tcp' as const;

  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(private readonly socket: Socket) {
    this.socket.setEncoding('utf8');
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: string) => {
      this.lineHandler?.(chunk);
    });
    this.socket.on('error', () => {
      this.settle();
    });
    this.socket.on('close', () => {
      this.settle();
    });
    this.socket.on('end', () => {
      this.settle();
    });
  }

  /** A remote container's process id is reported by `describe_isolation`. */
  get processId(): number | undefined {
    return undefined;
  }

  get remoteLabel(): string {
    return `${this.socket.remoteAddress ?? 'unknown'}:${String(this.socket.remotePort ?? 0)}`;
  }

  write(lines: readonly string[]): void {
    if (this.closed) {
      throw new IsolationError('host-unavailable');
    }
    for (const line of lines) {
      this.socket.write(line);
    }
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) {
      handler();
    }
  }

  close(): void {
    if (!this.closed) {
      this.socket.end();
      this.socket.destroy();
    }
    this.settle();
  }

  private settle(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.();
  }
}

export interface TcpConnectOptions {
  host: string;
  port: number;
  /** Connection deadline. Default 10 s, which is a container start, not a turn. */
  timeoutMs?: number;
  /** Attempts before giving up, for a container that is still booting. */
  attempts?: number;
  /** Delay between attempts. */
  retryDelayMs?: number;
}

/** Connect to a container-hosted learner, retrying while it boots. */
export async function connectTcpFrameChannel(
  options: TcpConnectOptions,
): Promise<TcpFrameChannel> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const timeoutMs = options.timeoutMs ?? 10_000;
  let lastCause: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await connectOnce(options.host, options.port, timeoutMs);
    } catch (cause) {
      lastCause = cause;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.retryDelayMs ?? 250);
        });
      }
    }
  }
  throw new IsolationError('connect-failed', { cause: lastCause });
}

async function connectOnce(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TcpFrameChannel> {
  return new Promise<TcpFrameChannel>((resolve, reject) => {
    const socket = new Socket();
    const fail = (cause: unknown): void => {
      socket.destroy();
      reject(cause instanceof Error ? cause : new Error('connect failed'));
    };
    socket.setTimeout(timeoutMs, () => {
      fail(new Error('connect timed out'));
    });
    socket.once('error', fail);
    socket.connect(port, host, () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(new TcpFrameChannel(socket));
    });
  });
}

export interface TcpFrameServerOptions {
  port: number;
  /** Bind address. Default `0.0.0.0` so a container network can reach it. */
  host?: string;
  /** Concurrent connections allowed. Default 1: one container, one Baby. */
  maxConnections?: number;
  onChannel: (channel: TcpFrameChannel) => void;
}

export interface TcpFrameServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/** Listen for exactly one Baby's runtime connection. */
export async function createTcpFrameServer(
  options: TcpFrameServerOptions,
): Promise<TcpFrameServer> {
  const limit = options.maxConnections ?? 1;
  let open = 0;
  const server = createServer((socket) => {
    if (open >= limit) {
      // Refusing rather than queueing: a second concurrent connection would
      // mean two Babies inside one host process.
      socket.destroy();
      return;
    }
    open += 1;
    socket.on('close', () => {
      open -= 1;
    });
    options.onChannel(new TcpFrameChannel(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : options.port,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
