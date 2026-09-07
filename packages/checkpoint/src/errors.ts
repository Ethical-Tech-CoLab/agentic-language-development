/**
 * Checkpoint service error taxonomy (ALD-013, ALD-014).
 *
 * Every rule the checkpoint service enforces surfaces as one of these
 * classes with a machine-readable `code`, following the Evidence Writer
 * convention so the Nursery Controller can map both taxonomies onto one
 * error shape. Unregistered runs reuse `UnknownRunError` from `@ald/evidence`
 * rather than adding a second name for the same condition.
 */
export type CheckpointErrorCode =
  | 'checkpoint-not-found'
  | 'checkpoint-integrity'
  | 'checkpoint-proof-range'
  | 'checkpoint-invalid-request';

export class CheckpointServiceError extends Error {
  constructor(
    readonly code: CheckpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A proof was requested against a checkpoint sequence the run never wrote. */
export class CheckpointNotFoundError extends CheckpointServiceError {
  constructor(
    readonly runId: string,
    readonly checkpointSequence: number,
  ) {
    super(
      'checkpoint-not-found',
      `Run ${runId} has no checkpoint ${String(checkpointSequence)}`,
    );
  }
}

/**
 * LEDGER §17: the evidence in the store no longer reproduces what a
 * checkpoint committed — a rewritten prefix, a renumbered event, or a
 * shrinking tree. This is the detector, so it never degrades to a warning.
 */
export class CheckpointIntegrityError extends CheckpointServiceError {
  constructor(message: string) {
    super('checkpoint-integrity', message);
  }
}

/** The requested sequence or checkpoint pair lies outside the committed tree. */
export class CheckpointProofRangeError extends CheckpointServiceError {
  constructor(message: string) {
    super('checkpoint-proof-range', message);
  }
}

/** A structurally valid request that the checkpoint policy refuses. */
export class InvalidCheckpointRequestError extends CheckpointServiceError {
  constructor(message: string) {
    super('checkpoint-invalid-request', message);
  }
}
