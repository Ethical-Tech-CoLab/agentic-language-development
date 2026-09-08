/**
 * Test doubles for the isolation boundary, shipped in `src` for the same
 * reason `@ald/gateway` ships its own: the doubles are part of the contract
 * this package asks other packages to hold up, and the red-team harness
 * (ALD-067) reuses them.
 *
 * A loopback channel pair is *not* an isolation claim. It exercises the
 * protocol — framing, padding, error shape, capability reconciliation,
 * deadlines — inside one process, which is exactly what makes it useful for
 * measuring the transport (ALD-040) without the noise of process start-up.
 * Anything that claims process or container separation must use the real
 * transports; the README states that boundary.
 */
import type { FrameChannel } from './channel.js';
import type { HostTransport } from './remote-adapter.js';

/** In-memory channel: one half of a loopback pair. */
export class LoopbackChannel implements FrameChannel {
  readonly kind = 'loopback' as const;

  /** Every frame this side wrote, in order — the wire, verbatim. */
  readonly written: string[] = [];

  peer: LoopbackChannel | undefined;

  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  write(lines: readonly string[]): void {
    for (const line of lines) {
      this.written.push(line);
    }
    const peer = this.peer;
    if (peer === undefined || peer.closed) {
      return;
    }
    // Asynchronous delivery, so a loopback pair has the same interleaving
    // rules as a real pipe: a handler never runs inside `write`.
    setImmediate(() => {
      for (const line of lines) {
        peer.deliver(line);
      }
    });
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
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.();
    const peer = this.peer;
    if (peer !== undefined && !peer.closed) {
      setImmediate(() => {
        peer.close();
      });
    }
  }

  /** Bytes this side put on the wire. */
  get bytesWritten(): number {
    return this.written.reduce(
      (total, line) => total + Buffer.byteLength(line, 'utf8'),
      0,
    );
  }

  private deliver(line: string): void {
    if (this.closed) {
      return;
    }
    this.lineHandler?.(line);
  }
}

export interface LoopbackPair {
  runtime: LoopbackChannel;
  host: LoopbackChannel;
}

/** Two connected {@link LoopbackChannel}s: a runtime side and a host side. */
export function createLoopbackChannelPair(): LoopbackPair {
  const runtime = new LoopbackChannel();
  const host = new LoopbackChannel();
  runtime.peer = host;
  host.peer = runtime;
  return { runtime, host };
}

/**
 * A {@link HostTransport} over a channel that already exists.
 *
 * `boundary` is the caller's to declare, and the caller must declare it
 * honestly: a loopback pair is `in-process` unless a test is deliberately
 * simulating a descriptor.
 */
export class DirectHostTransport implements HostTransport {
  constructor(
    readonly boundary: HostTransport['boundary'],
    private readonly channel: FrameChannel,
    readonly hostLabel?: string,
  ) {}

  current(): FrameChannel {
    return this.channel;
  }

  open(): Promise<FrameChannel> {
    return Promise.resolve(this.channel);
  }

  terminate(): Promise<void> {
    this.channel.close();
    return Promise.resolve();
  }
}
