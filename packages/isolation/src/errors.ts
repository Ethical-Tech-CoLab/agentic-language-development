/**
 * Error taxonomy for the Mode R isolation boundary (SPEC §5.2, §10.3, §14.5).
 *
 * Two closed enums live here and they are deliberately different:
 *
 * - {@link HOST_ERROR_CODES} is the *wire* enum. It is the only thing a
 *   learner host process ever says about a failure: an error response frame
 *   carries exactly `{ error: { code } }` — no message, no stack, no payload,
 *   no adapter text (SPEC §10.3 "normalized message envelope size and error
 *   behavior"). Adapter error text is withheld on purpose: it is
 *   model-influenced content on a path the runtime records, and a
 *   distinguishable error body is the error-message side channel §10.3
 *   enumerates.
 * - {@link ISOLATION_ERROR_CODES} is the *runtime-side* enum carried by
 *   {@link IsolationError}. It never crosses the boundary and never reaches a
 *   Baby context; it exists so the Nursery runtime can classify a failure
 *   without string matching, exactly as `@ald/orchestrator`'s
 *   `AdapterFailureError` does for in-process adapters.
 *
 * {@link ISOLATION_FAILURE_CLASSES} is the mapping the integrator needs: it
 * says, per code, which SPEC §14.5 handling path the failure belongs to. This
 * package deliberately does not import `@ald/orchestrator` (the dependency
 * runs the other way), so the mapping is data the runtime reads.
 */

/** Failure codes reported by a learner host on the wire. Text-free by design. */
export const HOST_ERROR_CODES = [
  /** A frame did not decode, was not canonical JSON, or broke the framing. */
  'invalid-frame',
  /** Method parameters failed their zod schema (unknown keys included). */
  'invalid-params',
  /** No such method in this protocol version. */
  'unknown-method',
  /** A turn method arrived before `init`. */
  'not-initialized',
  /** A second `init` arrived for the same host. */
  'already-initialized',
  /** The hosted adapter does not implement this optional method (SPEC §6.2). */
  'unsupported-method',
  /** The hosted adapter threw. Its message is withheld (§10.3). */
  'adapter-error',
  /** An inbound frame exceeded the negotiated frame size. */
  'frame-too-large',
  /** A payload exceeded the configured maximum. */
  'payload-too-large',
  /** The adapter returned a value canonical JSON cannot represent. */
  'non-serializable-result',
  /** Anything else. Never carries detail. */
  'internal',
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

const HOST_ERROR_CODE_SET: ReadonlySet<string> = new Set(HOST_ERROR_CODES);

export function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === 'string' && HOST_ERROR_CODE_SET.has(value);
}

/** Runtime-side classification of an isolation failure. */
export const ISOLATION_ERROR_CODES = [
  /** The factory/transport was configured in a way that cannot work. */
  'configuration',
  /** `child_process.spawn` failed or the host exited before the handshake. */
  'spawn-failed',
  /** A container/TCP host could not be reached. */
  'connect-failed',
  /** The channel is closed: the host exited, or the socket dropped. */
  'host-unavailable',
  /** The host process exited while a call was in flight. */
  'host-exited',
  /** No response inside the per-call deadline (SPEC §8.3). */
  'deadline-exceeded',
  /** The peer sent something this protocol does not allow. */
  'protocol-violation',
  /** An inbound frame was longer than the negotiated frame size. */
  'frame-too-large',
  /** An outbound payload exceeded the configured maximum. */
  'payload-too-large',
  /**
   * The value handed to the transport cannot be represented as canonical
   * JSON — a function, `Map`, `Set`, class instance, or circular graph. This
   * is the code an attempt to smuggle a live object reference across the
   * boundary produces (ALD-055 acceptance criterion 2).
   */
  'non-serializable-payload',
  /** The host answered with a typed `{ error: { code } }` frame. */
  'host-error',
  /** A turn method was called before `init` completed. */
  'not-initialized',
  /** `init` was called twice on one adapter. */
  'already-initialized',
  /** The adapter was disposed; it cannot be used again. */
  'disposed',
] as const;

export type IsolationErrorCode = (typeof ISOLATION_ERROR_CODES)[number];

/**
 * How the Nursery runtime should treat each code under SPEC §14.5.
 *
 * - `adapter-crash` — the §14.5 bullet 4 path: retry within the run's retry
 *   budget, then forfeit the turn, audit, and pause. `@ald/orchestrator`
 *   already implements exactly this for a thrown adapter error, so an
 *   `IsolationError` needs no new runtime path; it only needs to be wrapped in
 *   `AdapterFailureError` like any other adapter throw.
 * - `adapter-timeout` — the §8.3 deadline path: the turn is forfeited with a
 *   `timeout` rejection rather than retried with unbounded latency. A retry
 *   here would itself be the retry-count side channel §10.3 forbids.
 * - `operator-error` — a misconfiguration or misuse that no retry can fix; the
 *   run must not start (or must abort) and the operator must act.
 */
export const ISOLATION_FAILURE_CLASSES: Readonly<
  Record<IsolationErrorCode, 'adapter-crash' | 'adapter-timeout' | 'operator-error'>
> = Object.freeze({
  configuration: 'operator-error',
  'spawn-failed': 'operator-error',
  'connect-failed': 'operator-error',
  'host-unavailable': 'adapter-crash',
  'host-exited': 'adapter-crash',
  'deadline-exceeded': 'adapter-timeout',
  'protocol-violation': 'adapter-crash',
  'frame-too-large': 'adapter-crash',
  'payload-too-large': 'adapter-crash',
  'non-serializable-payload': 'adapter-crash',
  'host-error': 'adapter-crash',
  'not-initialized': 'operator-error',
  'already-initialized': 'operator-error',
  disposed: 'operator-error',
});

export interface IsolationErrorContext {
  /** Protocol method the failure happened in, when there was one. */
  method?: string;
  /** The host's own wire code, when the failure was a `host-error`. */
  hostCode?: HostErrorCode;
  /** Underlying cause, kept for the operator's own logging. Never reported. */
  cause?: unknown;
}

/**
 * A failure of the isolation boundary itself.
 *
 * The message is assembled from the code, the method name, and the host's
 * wire code only. It never interpolates the peer's error text, a payload, a
 * path, or any model-influenced string, so recording it verbatim in the audit
 * stream cannot become a content channel (SPEC §10.3, §14.2).
 */
export class IsolationError extends Error {
  readonly code: IsolationErrorCode;
  readonly method?: string;
  readonly hostCode?: HostErrorCode;
  readonly failureClass: 'adapter-crash' | 'adapter-timeout' | 'operator-error';

  constructor(code: IsolationErrorCode, context: IsolationErrorContext = {}) {
    const method = context.method === undefined ? '' : ` in ${context.method}()`;
    const hostCode =
      context.hostCode === undefined ? '' : ` (host code ${context.hostCode})`;
    super(`isolation boundary failed${method}: ${code}${hostCode}`);
    this.name = new.target.name;
    this.code = code;
    this.failureClass = ISOLATION_FAILURE_CLASSES[code];
    if (context.method !== undefined) {
      this.method = context.method;
    }
    if (context.hostCode !== undefined) {
      this.hostCode = context.hostCode;
    }
    if (context.cause !== undefined) {
      this.cause = context.cause;
    }
  }
}

export function isIsolationError(value: unknown): value is IsolationError {
  return value instanceof IsolationError;
}

/**
 * Host-side failure. Only its {@link HostErrorCode} is ever serialized; the
 * class exists so host code can throw something typed without inventing a
 * message that would then have to be suppressed at the boundary.
 */
export class HostProtocolError extends Error {
  constructor(readonly code: HostErrorCode) {
    super(`learner host refused the request: ${code}`);
    this.name = new.target.name;
  }
}

export function isHostProtocolError(value: unknown): value is HostProtocolError {
  return value instanceof HostProtocolError;
}
