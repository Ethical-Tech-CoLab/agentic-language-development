/**
 * Errors raised by the Nursery Controller runtime.
 *
 * Every error carries a machine-readable `code` so the DTSF route layer
 * (SPEC §12.3) can map it to a response body without string matching, in the
 * same style as `@ald/evidence` and `@ald/gateway`.
 */
import type { RunEvent, RunState } from '@ald/types';

export type RuntimeErrorCode =
  | 'unknown-run'
  | 'duplicate-run'
  | 'invalid-configuration'
  | 'configuration-mismatch'
  | 'invalid-run-state'
  | 'verifier-not-configured'
  | 'anchor-policy'
  | 'unsupported-condition';

export class NurseryRuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** No run with this id is loaded in the runtime (SPEC §12.5). */
export class UnknownRunError extends NurseryRuntimeError {
  constructor(readonly runId: string) {
    super('unknown-run', `run "${runId}" is not loaded in this runtime`);
  }
}

export class DuplicateRunError extends NurseryRuntimeError {
  constructor(readonly runId: string) {
    super('duplicate-run', `run "${runId}" is already loaded in this runtime`);
  }
}

/** `validateRunConfig` rejected the configuration (SPEC §11.1). */
export class RunConfigurationError extends NurseryRuntimeError {
  readonly errors: readonly { path: string; message: string }[];

  constructor(errors: readonly { path: string; message: string }[]) {
    super(
      'invalid-configuration',
      `invalid run configuration: ${errors
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * A pre-registered bundle hash in the configuration disagrees with the hash
 * of the artifact the runtime actually loaded (SPEC §15.1: the run is bound
 * to its pre-registered scenario and prompt bundles).
 */
export class ConfigurationMismatchError extends NurseryRuntimeError {
  constructor(
    readonly field: 'scenarioBundleHash' | 'promptBundleHash',
    readonly declared: string,
    readonly actual: string,
  ) {
    super(
      'configuration-mismatch',
      `${field} in the run configuration is ${declared} but the loaded artifact hashes to ${actual}`,
    );
  }
}

/** The requested operation is not legal in the run's current state (§7.2). */
export class RunStateError extends NurseryRuntimeError {
  constructor(
    readonly runId: string,
    readonly state: RunState,
    readonly expected: RunState | RunEvent,
  ) {
    super(
      'invalid-run-state',
      `run "${runId}" is in state "${state}"; this operation requires "${expected}" (SPECIFICATION.md §7.2)`,
    );
  }
}

export class VerifierNotConfiguredError extends NurseryRuntimeError {
  constructor() {
    super(
      'verifier-not-configured',
      'no verifier was injected into this runtime; verification runs out of band (SPEC §4.1 item 9)',
    );
  }
}

/**
 * SPEC §13.4/§7.2: skipping the Base anchor is only ever admissible for a
 * prototype-mode run, and an anchoring run needs a publisher.
 */
export class AnchorPolicyError extends NurseryRuntimeError {
  constructor(message: string) {
    super('anchor-policy', message);
  }
}

/** A §9.6 condition this runtime cannot execute with the declared tracks. */
export class UnsupportedConditionError extends NurseryRuntimeError {
  constructor(message: string) {
    super('unsupported-condition', message);
  }
}
