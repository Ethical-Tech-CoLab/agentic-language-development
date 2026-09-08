/**
 * The duplex request/response multiplexer that runs over one isolation
 * boundary (SPEC §4.1 item 5, §4.2, §12.7).
 *
 * The boundary is symmetric on purpose. The runtime calls the host to drive
 * the `LearnerAdapter` methods of SPEC §6.2, and the host calls *back* for
 * exactly one thing: `ledger.append`. That reverse direction is not a
 * convenience — the Ledger Writer and the Evidence Store live in the Nursery
 * trust zone (SPEC §4.1 item 7, §4.2 "Symbol Gateway ⇄ Evidence Writer"), so
 * a Baby host must never hold a database handle, a signer, or a file path. It
 * holds one RPC that the runtime binds to the authenticated Baby identity and
 * the current turn, precisely as `PrivateLedgerClient` promises.
 *
 * Everything else about this file is bookkeeping in service of two
 * properties: one frame sequence is written synchronously so messages never
 * interleave, and a closed channel fails every in-flight call with a typed
 * error instead of hanging a turn.
 */
import { z } from 'zod';

import {
  HOST_ERROR_CODES,
  IsolationError,
  type HostErrorCode,
  type IsolationErrorCode,
} from './errors.js';
import {
  DEFAULT_FRAME_SIZE,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FrameAssembler,
  LineReader,
  assertValidFrameSize,
  correlationId,
  decodeFrameLine,
  encodeFrames,
  type FrameOriginator,
} from './frames.js';
import { systemTimer, type IsolationTimer } from './timer.js';

/** One byte-stream to a learner host: a child's stdio, or a TCP socket. */
export interface FrameChannel {
  readonly kind: 'process' | 'tcp' | 'loopback';
  /** OS process id of the peer when the transport knows it. */
  readonly processId?: number;
  /** Write a complete frame sequence. Implementations must not reorder. */
  write(lines: readonly string[]): void;
  onLine(handler: (line: string) => void): void;
  /** Called once when the peer or transport goes away. */
  onClose(handler: () => void): void;
  /**
   * Why the channel closed, when the transport can tell: a child that exited
   * is `host-exited`, a dropped socket or a closed pipe is `host-unavailable`.
   * Both are `adapter-crash` under SPEC §14.5; the distinction is for the
   * operator's audit record, not for the handling path.
   */
  closeCode?(): IsolationErrorCode;
  close(): void;
}

const RequestPayloadSchema = z.strictObject({
  m: z.string().min(1).max(64),
  p: z.unknown().optional(),
});

const ResponsePayloadSchema = z.union([
  z.strictObject({ ok: z.literal(1), r: z.unknown().optional() }),
  z.strictObject({
    error: z.strictObject({ code: z.enum(HOST_ERROR_CODES) }),
  }),
]);

/** Serves an inbound request. Rejecting with a `HostProtocolError` is typed. */
export type FrameRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export interface FrameConnectionOptions {
  channel: FrameChannel;
  /** Namespace for this side's correlation ids. */
  originator: FrameOriginator;
  frameSize?: number;
  maxPayloadBytes?: number;
  handler?: FrameRequestHandler;
  timer?: IsolationTimer;
  /** Maps a thrown handler error to the wire code. Default: `internal`. */
  errorCodeFor?: (error: unknown) => HostErrorCode;
}

export interface ConnectionStats {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  requestsOut: number;
  requestsIn: number;
  responsesDropped: number;
  timeouts: number;
  protocolViolations: number;
}

interface PendingRequest {
  method: string;
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
}

/**
 * Request/response correlation over one {@link FrameChannel}.
 *
 * A response for an id that is no longer pending (a late answer to a call
 * that already hit its deadline) is counted and dropped: re-delivering it
 * would put the caller's turn out of order, and reporting it would leak the
 * host's timing after the fact.
 */
export class FrameConnection {
  readonly stats: ConnectionStats = {
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    requestsOut: 0,
    requestsIn: 0,
    responsesDropped: 0,
    timeouts: 0,
    protocolViolations: 0,
  };

  private readonly channel: FrameChannel;
  private readonly originator: FrameOriginator;
  private readonly frameSize: number;
  private readonly maxPayloadBytes: number;
  private readonly handler: FrameRequestHandler | undefined;
  private readonly timer: IsolationTimer;
  private readonly errorCodeFor: (error: unknown) => HostErrorCode;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly assembler: FrameAssembler;
  private readonly reader: LineReader;
  private counter = 0;
  private closed = false;
  private closeReason: IsolationError | undefined;

  constructor(options: FrameConnectionOptions) {
    this.channel = options.channel;
    this.originator = options.originator;
    this.frameSize = assertValidFrameSize(options.frameSize ?? DEFAULT_FRAME_SIZE);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.handler = options.handler;
    this.timer = options.timer ?? systemTimer;
    this.errorCodeFor = options.errorCodeFor ?? ((): HostErrorCode => 'internal');
    this.assembler = new FrameAssembler(this.maxPayloadBytes);
    this.reader = new LineReader(
      this.frameSize,
      (line) => {
        this.acceptLine(line);
      },
      (error) => {
        this.fail(error);
      },
    );

    this.channel.onLine((chunk) => {
      this.stats.bytesIn += Buffer.byteLength(chunk, 'utf8');
      this.reader.push(chunk);
    });
    this.channel.onClose(() => {
      this.fail(new IsolationError(this.channel.closeCode?.() ?? 'host-unavailable'));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Call `method` on the peer.
   *
   * `deadlineMs` is the SPEC §8.3 per-call budget. On expiry the call rejects
   * with `deadline-exceeded` and the id is abandoned; the channel stays usable
   * so the runtime's §14.5 retry can decide what to do next.
   */
  async request<T>(
    method: string,
    params: unknown,
    deadlineMs?: number,
  ): Promise<T> {
    if (this.closed) {
      throw this.closeReason ?? new IsolationError('host-unavailable', { method });
    }
    this.counter += 1;
    const id = correlationId(this.originator, this.counter);
    const lines = encodeFrames(
      params === undefined ? { m: method } : { m: method, p: params },
      {
        kind: 'req',
        id,
        frameSize: this.frameSize,
        maxPayloadBytes: this.maxPayloadBytes,
        method,
      },
    );

    const outcome = new Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>(
      (resolve) => {
        this.pending.set(id, { method, settle: resolve });
      },
    );

    try {
      this.writeLines(lines);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    this.stats.requestsOut += 1;

    const budget =
      deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs <= 0
        ? undefined
        : this.timer.delay(deadlineMs);
    const settled =
      budget === undefined
        ? await outcome
        : await Promise.race([
            outcome,
            budget.promise.then(
              () => ({ ok: false as const, error: 'deadline' as const }),
            ),
          ]);
    budget?.cancel();

    if (settled.ok) {
      return settled.value as T;
    }
    if (settled.error === 'deadline') {
      this.pending.delete(id);
      this.stats.timeouts += 1;
      throw new IsolationError('deadline-exceeded', { method });
    }
    throw settled.error;
  }

  /** Reject every in-flight call and close the channel. */
  close(reason?: IsolationError): void {
    this.fail(reason ?? new IsolationError('host-unavailable'));
    this.channel.close();
  }

  private writeLines(lines: readonly string[]): void {
    this.channel.write(lines);
    this.stats.framesOut += lines.length;
    for (const line of lines) {
      this.stats.bytesOut += Buffer.byteLength(line, 'utf8');
    }
  }

  private fail(error: IsolationError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeReason = error;
    const inflight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inflight) {
      entry.settle({
        ok: false,
        error: new IsolationError(error.code, {
          method: entry.method,
          cause: error,
        }),
      });
    }
  }

  private acceptLine(line: string): void {
    this.stats.framesIn += 1;
    let message: { kind: 'req' | 'res'; id: string; payload: unknown } | undefined;
    try {
      message = this.assembler.push(decodeFrameLine(line, this.frameSize));
    } catch (error) {
      this.stats.protocolViolations += 1;
      this.fail(
        error instanceof IsolationError
          ? error
          : new IsolationError('protocol-violation', { cause: error }),
      );
      return;
    }
    if (message === undefined) {
      return;
    }
    if (message.kind === 'req') {
      void this.serve(message.id, message.payload);
      return;
    }
    this.resolve(message.id, message.payload);
  }

  private resolve(id: string, payload: unknown): void {
    const entry = this.pending.get(id);
    const parsed = ResponsePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      this.stats.protocolViolations += 1;
      this.fail(new IsolationError('protocol-violation', { cause: parsed.error }));
      return;
    }
    if (entry === undefined) {
      this.stats.responsesDropped += 1;
      return;
    }
    this.pending.delete(id);
    if ('error' in parsed.data) {
      entry.settle({
        ok: false,
        error: new IsolationError('host-error', {
          method: entry.method,
          hostCode: parsed.data.error.code,
        }),
      });
      return;
    }
    entry.settle({ ok: true, value: parsed.data.r });
  }

  private async serve(id: string, payload: unknown): Promise<void> {
    this.stats.requestsIn += 1;
    let response: unknown;
    const parsed = RequestPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      response = { error: { code: 'invalid-frame' satisfies HostErrorCode } };
    } else if (this.handler === undefined) {
      response = { error: { code: 'unknown-method' satisfies HostErrorCode } };
    } else {
      try {
        const value = await this.handler(parsed.data.m, parsed.data.p);
        response = value === undefined ? { ok: 1 } : { ok: 1, r: value };
      } catch (error) {
        response = { error: { code: this.errorCodeFor(error) } };
      }
    }

    if (this.closed) {
      return;
    }
    try {
      this.writeLines(
        encodeFrames(response, {
          kind: 'res',
          id,
          frameSize: this.frameSize,
          maxPayloadBytes: this.maxPayloadBytes,
        }),
      );
    } catch {
      // The result itself could not be represented (a `Map`, a function, a
      // class instance): answer with the text-free code instead, so the
      // caller sees a typed refusal rather than a hang.
      try {
        this.writeLines(
          encodeFrames(
            { error: { code: 'non-serializable-result' satisfies HostErrorCode } },
            { kind: 'res', id, frameSize: this.frameSize },
          ),
        );
      } catch {
        this.fail(new IsolationError('protocol-violation'));
      }
    }
  }
}
