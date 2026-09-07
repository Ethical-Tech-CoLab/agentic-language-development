/**
 * Error types raised by the learner adapters.
 *
 * Every error is a plain `Error` subclass with a stable `name` so the Nursery
 * Controller can map it onto a rejection reason code without string matching
 * on messages (SPEC §9.4).
 */

/** A track named in SPEC §6.1 that this package does not implement yet. */
export class NotImplementedTrackError extends Error {
  override readonly name = 'NotImplementedTrackError';

  constructor(
    readonly track: string,
    /** BACKLOG item that owns the missing implementation. */
    readonly backlogItem: string,
  ) {
    super(`Learner track "${track}" is not implemented (see ${backlogItem})`);
  }
}

/**
 * `UpdateBatch.learningSignal` names a signal this adapter cannot consume
 * (SPEC §6.2: tracks differ only in the reward/update-rule fields of
 * `UpdateBatch`).
 */
export class UnsupportedLearningSignalError extends Error {
  override readonly name = 'UnsupportedLearningSignalError';

  constructor(
    readonly learningSignal: string,
    readonly supported: readonly string[],
  ) {
    super(
      `Learning signal "${learningSignal}" is not supported; supported: ${supported.join(', ')}`,
    );
  }
}

/** An adapter method was called out of the SPEC §8.1 turn order. */
export class LearnerStateError extends Error {
  override readonly name = 'LearnerStateError';
}

/** A run configuration or factory option combination the adapter cannot honor. */
export class LearnerConfigurationError extends Error {
  override readonly name = 'LearnerConfigurationError';
}

/**
 * A learner-contract file violated a SPEC §6.4 lint rule. Loading such a
 * contract fails so a run can never reference it (ALD-043).
 */
export class LearnerContractLintError extends Error {
  override readonly name = 'LearnerContractLintError';

  constructor(
    readonly contractPath: string,
    readonly violations: readonly string[],
  ) {
    super(
      `Learner contract ${contractPath} violates §6.4 lint rules:\n${violations.join('\n')}`,
    );
  }
}

/** A conformance assertion in `runLearnerAdapterConformance` failed. */
export class LearnerConformanceError extends Error {
  override readonly name = 'LearnerConformanceError';
}
