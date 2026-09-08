/**
 * Fixed-size, newline-delimited canonical-JSON framing for the learner host
 * protocol (SPEC §10.3: "normalized message envelope size and error
 * behavior"; ALD-040 transport half).
 *
 * Every line written to the boundary is **exactly** `frameSize` bytes,
 * newline included, whatever it carries: an `init` request, an accepted
 * `act()` envelope, a rejected turn, or a text-free error. An observer of the
 * pipe or socket therefore learns the frame *count* and nothing else about
 * the content — and for every turn-path method the count is one frame in each
 * direction, so an accepted and a failed turn are byte-identical in size.
 *
 * The payload of a frame is RFC 8785 canonical JSON, base64-encoded and split
 * into fixed-capacity chunks. Base64 rather than raw JSON so that one frame's
 * capacity is a constant that does not depend on how the payload happens to
 * escape, and canonical JSON because:
 *
 * - `canonicalJson` from `@ald/hashing` *rejects* anything JSON cannot
 *   represent — a function, `Symbol`, `Map`, `Set`, `Buffer`, class instance,
 *   or circular graph — instead of silently dropping it. That rejection is
 *   the mechanism behind ALD-055 acceptance criterion 2: an attempt to smuggle
 *   a live object reference between two Baby hosts fails loudly at the
 *   boundary rather than arriving as `{}`;
 * - `parseCanonicalJson` on receipt requires the peer to have sent the
 *   canonical form, so the framing cannot be used to hide bytes (trailing
 *   junk, alternative escapes, key reordering) inside an otherwise valid
 *   message.
 *
 * The frame envelope's own key set is fixed and its numeric fields are
 * bounded, so the envelope overhead is a constant computed once from the
 * worst case rather than measured per message.
 */
import { z } from 'zod';
import { canonicalJson, parseCanonicalJson } from '@ald/hashing';

import { IsolationError } from './errors.js';

export const FRAME_VERSION = 1;

/** Default wire frame size in bytes, newline included (8 KiB). */
export const DEFAULT_FRAME_SIZE = 8192;

/** Smallest frame that still leaves room for a useful chunk. */
export const MIN_FRAME_SIZE = 1024;

/** Largest frame this implementation will negotiate (1 MiB). */
export const MAX_FRAME_SIZE = 1_048_576;

/** Default cap on one payload before chunking (4 MiB of canonical JSON). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 4_194_304;

/** Hard ceiling on the chunk count of one payload. */
export const MAX_CHUNKS = 999_999;

/** `r-` for the runtime side, `h-` for the host side. */
export type FrameOriginator = 'r' | 'h';

export type FrameKind = 'req' | 'res';

const CORRELATION_ID = /^[rh]-[0-9]{12}$/u;

/**
 * Frame envelope. Short keys because every byte of overhead is a byte of
 * payload capacity, and the shape is documented here rather than in the
 * names: `v` version, `t` kind, `i` correlation id, `q` chunk index, `n`
 * chunk count, `d` base64 chunk.
 */
export const FrameSchema = z.strictObject({
  v: z.literal(FRAME_VERSION),
  t: z.enum(['req', 'res']),
  i: z.string().regex(CORRELATION_ID),
  q: z.number().int().min(0).max(MAX_CHUNKS - 1),
  n: z.number().int().min(1).max(MAX_CHUNKS),
  d: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u),
});

export type Frame = z.infer<typeof FrameSchema>;

/**
 * Bytes an envelope costs at its worst case (six-digit chunk numbers, the
 * longest correlation id), plus the trailing newline. Computed from the
 * serializer rather than counted by hand so it cannot drift.
 */
export const FRAME_OVERHEAD_BYTES: number =
  Buffer.byteLength(
    canonicalJson({
      v: FRAME_VERSION,
      t: 'req',
      i: 'r-000000000000',
      q: MAX_CHUNKS - 1,
      n: MAX_CHUNKS,
      d: '',
    }),
    'utf8',
  ) + 1;

/** Base64 characters one frame of `frameSize` bytes can carry. */
export function frameCapacity(frameSize: number): number {
  return frameSize - FRAME_OVERHEAD_BYTES;
}

export function assertValidFrameSize(frameSize: number): number {
  if (
    !Number.isInteger(frameSize) ||
    frameSize < MIN_FRAME_SIZE ||
    frameSize > MAX_FRAME_SIZE
  ) {
    throw new IsolationError('configuration');
  }
  return frameSize;
}

/** Zero-padded correlation id, e.g. `r-000000000042`. */
export function correlationId(
  originator: FrameOriginator,
  counter: number,
): string {
  return `${originator}-${String(counter % 1_000_000_000_000).padStart(12, '0')}`;
}

/**
 * Canonical JSON for `value`, or {@link IsolationError} `non-serializable-payload`.
 *
 * The underlying rejection message from `@ald/hashing` names the offending
 * *path and type* — key names on that path can be adapter-chosen, so the
 * message is kept as `cause` for the operator and never interpolated into the
 * error this throws (SPEC §10.3, §14.2).
 */
export function canonicalPayload(value: unknown, method?: string): string {
  try {
    return canonicalJson(value);
  } catch (cause) {
    throw new IsolationError('non-serializable-payload', {
      ...(method === undefined ? {} : { method }),
      cause,
    });
  }
}

export interface EncodeFramesOptions {
  kind: FrameKind;
  id: string;
  frameSize?: number;
  maxPayloadBytes?: number;
  /** Method name, for error attribution only. Never written to the wire. */
  method?: string;
}

/**
 * Encode one payload as a complete, padded frame sequence.
 *
 * The whole sequence is returned at once and callers write it in a single
 * synchronous burst, which is what lets the reader assume frames of one
 * message are never interleaved with another message's frames.
 */
export function encodeFrames(
  payload: unknown,
  options: EncodeFramesOptions,
): string[] {
  const frameSize = assertValidFrameSize(options.frameSize ?? DEFAULT_FRAME_SIZE);
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const canonical = canonicalPayload(payload, options.method);
  const bytes = Buffer.from(canonical, 'utf8');
  if (bytes.byteLength > maxPayloadBytes) {
    throw new IsolationError('payload-too-large', {
      ...(options.method === undefined ? {} : { method: options.method }),
    });
  }
  const base64 = bytes.toString('base64');
  const capacity = frameCapacity(frameSize);
  const chunkCount = Math.max(1, Math.ceil(base64.length / capacity));
  if (chunkCount > MAX_CHUNKS) {
    throw new IsolationError('payload-too-large', {
      ...(options.method === undefined ? {} : { method: options.method }),
    });
  }

  const lines: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const frame: Frame = {
      v: FRAME_VERSION,
      t: options.kind,
      i: options.id,
      q: index,
      n: chunkCount,
      d: base64.slice(index * capacity, (index + 1) * capacity),
    };
    const envelope = canonicalJson(frame);
    const padding = frameSize - 1 - Buffer.byteLength(envelope, 'utf8');
    if (padding < 0) {
      // Unreachable while FRAME_OVERHEAD_BYTES is the true worst case; kept
      // as a hard stop so a future envelope change cannot silently emit a
      // frame of a different size.
      throw new IsolationError('frame-too-large', {
        ...(options.method === undefined ? {} : { method: options.method }),
      });
    }
    lines.push(`${envelope}${' '.repeat(padding)}\n`);
  }
  return lines;
}

/**
 * Decode one received line (without its newline) into a frame.
 *
 * Padding is stripped, then the remainder must be *exactly* the canonical
 * form of the frame envelope: a peer cannot hide bytes in whitespace, key
 * order, or number formatting.
 */
export function decodeFrameLine(line: string, frameSize: number): Frame {
  if (Buffer.byteLength(line, 'utf8') + 1 > frameSize) {
    throw new IsolationError('frame-too-large');
  }
  const trimmed = line.replace(/ +$/u, '');
  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(trimmed);
  } catch (cause) {
    throw new IsolationError('protocol-violation', { cause });
  }
  const frame = FrameSchema.safeParse(parsed);
  if (!frame.success) {
    throw new IsolationError('protocol-violation', { cause: frame.error });
  }
  return frame.data;
}

/**
 * Reassembles chunked payloads for one direction of one channel.
 *
 * One message at a time: chunks must arrive in order, and a frame belonging
 * to a different message while one is incomplete is a protocol violation
 * rather than the start of an interleaved stream. Both sides write a whole
 * frame sequence synchronously, so in-order, non-interleaved arrival is a
 * property of the protocol and not an assumption about the transport.
 */
export class FrameAssembler {
  private partial:
    | { kind: FrameKind; id: string; count: number; next: number; chunks: string[] }
    | undefined;

  constructor(private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES) {}

  /** Feed one frame; returns the decoded payload once a message completes. */
  push(frame: Frame): { kind: FrameKind; id: string; payload: unknown } | undefined {
    if (this.partial === undefined) {
      if (frame.q !== 0) {
        throw new IsolationError('protocol-violation');
      }
      this.partial = {
        kind: frame.t,
        id: frame.i,
        count: frame.n,
        next: 0,
        chunks: [],
      };
    }
    const partial = this.partial;
    if (
      frame.t !== partial.kind ||
      frame.i !== partial.id ||
      frame.n !== partial.count ||
      frame.q !== partial.next
    ) {
      this.partial = undefined;
      throw new IsolationError('protocol-violation');
    }
    partial.chunks.push(frame.d);
    partial.next += 1;
    if (partial.next < partial.count) {
      return undefined;
    }

    this.partial = undefined;
    const bytes = Buffer.from(partial.chunks.join(''), 'base64');
    if (bytes.byteLength > this.maxPayloadBytes) {
      throw new IsolationError('payload-too-large');
    }
    let payload: unknown;
    try {
      payload = parseCanonicalJson(bytes.toString('utf8'));
    } catch (cause) {
      throw new IsolationError('protocol-violation', { cause });
    }
    return { kind: partial.kind, id: partial.id, payload };
  }

  /** True while a multi-frame message is still incomplete. */
  get pending(): boolean {
    return this.partial !== undefined;
  }
}

/**
 * Splits an incoming byte stream into frame lines, refusing any line longer
 * than the negotiated frame size before it can be buffered (a host that never
 * writes a newline must not be able to grow the runtime's heap).
 */
export class LineReader {
  private buffer = '';

  constructor(
    private readonly frameSize: number,
    private readonly onLine: (line: string) => void,
    private readonly onError: (error: IsolationError) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') >= this.frameSize) {
          this.buffer = '';
          this.onError(new IsolationError('frame-too-large'));
        }
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }
  }
}
