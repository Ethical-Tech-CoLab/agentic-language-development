/**
 * Closed error-code union for `@ald/ops` (SPECIFICATION.md §14.1, §14.4-§14.6).
 *
 * Every operations failure is one of these codes. Nothing here is ever shown
 * to a Baby: `@ald/ops` sits entirely on the researcher/operator side of the
 * §4.2 trust boundary (telemetry, snapshots, retention, process supervision),
 * so these messages are operator-facing by construction and no Baby context
 * can observe them.
 */

/** Every failure `@ald/ops` raises. Closed by design (BACKLOG quality bar). */
export type OpsErrorCode =
  /** A telemetry record did not satisfy `TelemetryRecordSchema`. */
  | 'invalid-telemetry-record'
  /** A telemetry sink was used after `close()`. */
  | 'telemetry-sink-closed'
  /** A telemetry query named an impossible range (`from` after `to`). */
  | 'invalid-telemetry-query'
  /** No snapshot file exists in the snapshot directory. */
  | 'snapshot-not-found'
  /** A snapshot file is not canonical JSON or fails `RuntimeSnapshotSchema`. */
  | 'snapshot-invalid'
  /** A snapshot file's recomputed digest differs from the recorded one. */
  | 'snapshot-digest-mismatch'
  /** A snapshot id/path would escape the configured snapshot directory. */
  | 'snapshot-path-escape'
  /** `runRetentionJob` was given contradictory or unusable options. */
  | 'retention-invalid-options'
  /** A retention target path would escape the configured bundle root. */
  | 'retention-path-escape'
  /** A supervised background task exhausted its retry budget. */
  | 'supervised-task-failed';

export class OpsError extends Error {
  constructor(
    readonly code: OpsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export class TelemetryError extends OpsError {
  constructor(
    code: Extract<
      OpsErrorCode,
      'invalid-telemetry-record' | 'telemetry-sink-closed' | 'invalid-telemetry-query'
    >,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = 'TelemetryError';
  }
}

export class SnapshotError extends OpsError {
  constructor(
    code: Extract<
      OpsErrorCode,
      | 'snapshot-not-found'
      | 'snapshot-invalid'
      | 'snapshot-digest-mismatch'
      | 'snapshot-path-escape'
    >,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = 'SnapshotError';
  }
}

export class RetentionError extends OpsError {
  constructor(
    code: Extract<
      OpsErrorCode,
      'retention-invalid-options' | 'retention-path-escape'
    >,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = 'RetentionError';
  }
}

export class SupervisedTaskError extends OpsError {
  constructor(
    readonly taskName: string,
    readonly attempts: number,
    readonly cause: unknown,
  ) {
    super(
      'supervised-task-failed',
      `Background task "${taskName}" failed after ${String(attempts)} attempt(s)`,
      { taskName, attempts },
    );
    this.name = 'SupervisedTaskError';
  }
}

/** Type guard used by hosts that map ops failures onto their own envelopes. */
export function isOpsError(value: unknown): value is OpsError {
  return value instanceof OpsError;
}
