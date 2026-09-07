/**
 * Evidence Writer error taxonomy.
 *
 * The writer is the only component allowed to write event tables
 * (SPECIFICATION.md §4.1 item 7, ALD-010 criterion 3), so every rule it
 * enforces surfaces as one of these classes rather than as a raw SQLite or
 * zod error. `code` is machine-readable and is what the Gateway and the
 * Nursery Controller map onto their own error shapes.
 */
import type { EventStream } from '@ald/types';

export type EvidenceErrorCode =
  | 'duplicate-run'
  | 'unknown-run'
  | 'duplicate-event'
  | 'fork-detected'
  | 'interpretation-binding'
  | 'integrity-blocked'
  | 'checkpoint-chain'
  | 'experiment-record-version'
  | 'invalid-request';

export class EvidenceWriterError extends Error {
  constructor(
    readonly code: EvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A run may be registered exactly once (409-style conflict). */
export class DuplicateRunError extends EvidenceWriterError {
  constructor(readonly runId: string) {
    super('duplicate-run', `Run ${runId} is already registered`);
  }
}

export class UnknownRunError extends EvidenceWriterError {
  constructor(readonly runId: string) {
    super('unknown-run', `Run ${runId} is not registered`);
  }
}

/**
 * The exact same event (identical entry hash) was submitted twice. The store
 * is append-only, so the second submission is refused rather than merged
 * (LEDGER §15: never reuse a sequence number).
 */
export class DuplicateEventError extends EvidenceWriterError {
  constructor(
    readonly stream: EventStream,
    readonly sequence: number,
    readonly entryHash: string,
  ) {
    super(
      'duplicate-event',
      `Event ${stream}#${sequence} with hash ${entryHash} is already committed`,
    );
  }
}

/**
 * LEDGER §15: two entries claim the same stream and sequence with different
 * hashes. Both artifacts are preserved in `fork_artifacts`, the run is
 * blocked, and the evidence stays invalid until a research-integrity review
 * acknowledges it.
 */
export class ForkDetectedError extends EvidenceWriterError {
  constructor(
    readonly stream: EventStream,
    readonly sequence: number,
    readonly entryHashes: string[],
  ) {
    super(
      'fork-detected',
      `Fork detected on ${stream}#${sequence}: ${entryHashes.join(' vs ')}`,
    );
  }
}

/**
 * SPEC §11.3: the receiver MUST echo the `channelEventHash` of a delivery
 * addressed to it. A hash that names another Baby's delivery, or no delivery
 * at all, is refused before anything is written.
 */
export class InterpretationBindingError extends EvidenceWriterError {
  constructor(message: string) {
    super('interpretation-binding', message);
  }
}

/** LEDGER §15: no new writes for a run with an unreviewed integrity failure. */
export class IntegrityBlockedError extends EvidenceWriterError {
  constructor(
    readonly runId: string,
    readonly reasons: string[],
  ) {
    super(
      'integrity-blocked',
      `Run ${runId} is blocked pending integrity review: ${reasons.join('; ')}`,
    );
  }
}

/** LEDGER §8: checkpoint manifests form their own hash chain. */
export class CheckpointChainError extends EvidenceWriterError {
  constructor(message: string) {
    super('checkpoint-chain', message);
  }
}

/** SPEC §11.9: experiment records are versioned append-only, `last + 1`. */
export class ExperimentRecordVersionError extends EvidenceWriterError {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      'experiment-record-version',
      `Experiment record version must be ${expected}, received ${received}`,
    );
  }
}

/** A structurally valid request that violates a writer-enforced protocol rule. */
export class InvalidRequestError extends EvidenceWriterError {
  constructor(message: string) {
    super('invalid-request', message);
  }
}
