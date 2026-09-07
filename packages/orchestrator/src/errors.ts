/**
 * Errors raised by the Nursery Controller runtime.
 *
 * Every error carries a machine-readable `code` so the DTSF route layer
 * (SPEC §12.3) can map it to a response body without string matching, in the
 * same style as `@ald/evidence` and `@ald/gateway`.
 */
import type { BabyRole, RunEvent, RunState } from '@ald/types';

export type RuntimeErrorCode =
  | 'unknown-run'
  | 'duplicate-run'
  | 'invalid-configuration'
  | 'configuration-mismatch'
  | 'invalid-run-state'
  | 'verifier-not-configured'
  | 'anchor-policy'
  | 'unsupported-condition'
  | 'signer-registry-mismatch'
  | 'adapter-failure';

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

/**
 * LEDGER-INTEGRITY-DESIGN.md §11/§15: the signer registry handed to the
 * runtime does not hold the keys the run registered, so every event it signed
 * from here on would be unverifiable — and an already-committed tail can never
 * be re-signed. Recovery refuses rather than producing one.
 */
export class SignerRegistryMismatchError extends NurseryRuntimeError {
  readonly domains: readonly string[];

  constructor(
    readonly runId: string,
    domains: readonly string[],
  ) {
    super(
      'signer-registry-mismatch',
      `run "${runId}" registered different public keys for signer domain(s) ` +
        `${domains.join(', ')}; recovery would sign an unverifiable tail ` +
        '(LEDGER-INTEGRITY-DESIGN.md §11, §15)',
    );
    this.domains = Object.freeze([...domains]);
  }
}

/** A §9.6 condition this runtime cannot execute with the declared tracks. */
export class UnsupportedConditionError extends NurseryRuntimeError {
  constructor(message: string) {
    super('unsupported-condition', message);
  }
}

/** The `LearnerAdapter` methods the turn loop calls (SPEC §6.2, §8.1). */
export const ADAPTER_METHODS = [
  'observe',
  'act',
  'receive',
  'onOutcome',
  'updatePolicy',
] as const;

export type AdapterMethod = (typeof ADAPTER_METHODS)[number];

/**
 * SPEC §10.3, §14.5: an adapter's own error text is recorded, but never its
 * payload and never at unbounded length — a Baby must not be able to write
 * arbitrary content into the audit stream through a thrown message.
 */
export const ADAPTER_FAILURE_MESSAGE_LIMIT = 200;

/** First line of an error's message, truncated to the audit limit. */
export function adapterFailureMessage(cause: unknown): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : '';
  const firstLine = raw.split('\n', 1)[0] ?? '';
  return firstLine.length > ADAPTER_FAILURE_MESSAGE_LIMIT
    ? `${firstLine.slice(0, ADAPTER_FAILURE_MESSAGE_LIMIT)}…`
    : firstLine;
}

/**
 * SPEC §14.5 bullet 4: an adapter crash that survived its retry budget. The
 * runtime never lets this escape `step()` — it is the internal signal that the
 * turn must be forfeited, audited, and paused (never retried again, which
 * would be both an unbounded loop and a timing side channel, §10.3).
 */
export class AdapterFailureError extends NurseryRuntimeError {
  /** `name` of the adapter's own error, for the machine-readable audit entry. */
  readonly errorName: string;

  /** First line of the adapter's message, truncated; never a payload. */
  readonly detail: string;

  constructor(
    readonly role: BabyRole,
    readonly method: AdapterMethod,
    /** How many times the call was attempted, retries included. */
    readonly attempts: number,
    /** The adapter's own last error, kept for the caller's own logging. */
    readonly adapterError: unknown,
  ) {
    const errorName =
      adapterError instanceof Error ? adapterError.name : typeof adapterError;
    const detail = adapterFailureMessage(adapterError);
    super(
      'adapter-failure',
      `adapter for ${role} failed ${attempts} time(s) in ${method}(): ` +
        `${errorName}${detail === '' ? '' : `: ${detail}`} ` +
        '(SPECIFICATION.md §14.5)',
    );
    this.errorName = errorName;
    this.detail = detail;
  }
}
