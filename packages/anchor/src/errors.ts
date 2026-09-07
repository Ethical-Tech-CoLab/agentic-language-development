/**
 * Anchoring error taxonomy.
 *
 * Anchoring is a background, best-effort activity: a failure to reach the
 * chain must never take the run down (SPECIFICATION.md §14.5 — anchoring
 * failure is a named, handled failure mode). Every condition the anchor
 * publisher refuses outright therefore carries a machine-readable `code` so
 * the caller can decide between "retry later", "pause the run", and
 * "operator misconfiguration".
 *
 * No error message in this module ever embeds an anchoring private key
 * (LEDGER-INTEGRITY-DESIGN.md §11).
 */

export type AnchorErrorCode =
  /** ALD-022: mainnet requested without both explicit opt-ins. */
  | 'MAINNET_ANCHORING_DISABLED'
  /** Transport chain id does not match its declared network. */
  | 'ANCHOR_NETWORK_MISMATCH'
  /** Every send attempt threw; nothing was submitted. */
  | 'ANCHOR_SUBMISSION_FAILED'
  /** A transport returned calldata that is not the bare checkpoint digest. */
  | 'ANCHOR_PAYLOAD_MISMATCH'
  /** `finalityPolicy` string could not be parsed into a confirmation depth. */
  | 'INVALID_FINALITY_POLICY'
  /** `runIdHash` in the manifest matches no run in the evidence store. */
  | 'UNKNOWN_ANCHOR_RUN'
  /** The manifest being anchored is not stored, so no receipt could link to it. */
  | 'UNKNOWN_ANCHOR_CHECKPOINT'
  /**
   * Key file missing, malformed, not a valid secp256k1 scalar, world/group
   * readable, or sitting in a group/other-writable directory.
   */
  | 'ANCHOR_KEY_FILE'
  /** Retryable RPC/transport failure; no transaction was submitted. */
  | 'TRANSIENT_CHAIN_ERROR'
  /** Pending-submission sidecar file could not be read. */
  | 'PENDING_FILE_INVALID';

/** Base class for every anchoring failure this package raises. */
export class AnchorError extends Error {
  constructor(
    readonly code: AnchorErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function isAnchorError(value: unknown): value is AnchorError {
  return value instanceof AnchorError;
}

/**
 * ALD-022 / SPEC §13.4: Base Sepolia is the unconditional default. Mainnet
 * requires BOTH a constructor opt-in and `ALD_ALLOW_MAINNET_ANCHORING=true`
 * in the environment; either one alone is refused before any RPC call.
 */
export class MainnetAnchoringDisabledError extends AnchorError {
  constructor(readonly reason: 'missing-option' | 'missing-env' | 'both') {
    super(
      'MAINNET_ANCHORING_DISABLED',
      'Base mainnet anchoring is disabled: it requires both the ' +
        '`allowMainnet: true` publisher option and ' +
        '`ALD_ALLOW_MAINNET_ANCHORING=true` in the environment ' +
        `(missing: ${reason})`,
    );
  }
}

export class AnchorNetworkMismatchError extends AnchorError {
  constructor(network: string, declaredChainId: number, expected: number) {
    super(
      'ANCHOR_NETWORK_MISMATCH',
      `Transport reports chain id ${declaredChainId} for network ${network}, expected ${expected}`,
    );
  }
}

export class AnchorSubmissionFailedError extends AnchorError {
  constructor(readonly attempts: number, options?: { cause?: unknown }) {
    super(
      'ANCHOR_SUBMISSION_FAILED',
      `Anchor transaction was not submitted after ${attempts} attempt(s)`,
      options,
    );
  }
}

export class AnchorPayloadMismatchError extends AnchorError {
  constructor(expected: string, actual: string) {
    super(
      'ANCHOR_PAYLOAD_MISMATCH',
      `Anchor calldata must be exactly the 32-byte checkpoint digest ${expected}, got ${actual}`,
    );
  }
}

export class InvalidFinalityPolicyError extends AnchorError {
  constructor(policy: string) {
    super(
      'INVALID_FINALITY_POLICY',
      `Unsupported finality policy '${policy}': expected '1-confirmation', 'safe-tag', or '<n>-confirmations'`,
    );
  }
}

export class UnknownAnchorRunError extends AnchorError {
  constructor(runIdHash: string) {
    super(
      'UNKNOWN_ANCHOR_RUN',
      `No run in the evidence store hashes to runIdHash ${runIdHash}`,
    );
  }
}

/**
 * ALD-018 criterion 1: a receipt always references an existing checkpoint
 * manifest. Checked before submitting, so a missing manifest costs no gas
 * instead of failing later on the `anchor_receipts` foreign key.
 */
export class UnknownAnchorCheckpointError extends AnchorError {
  constructor(runId: string, checkpointHash: string) {
    super(
      'UNKNOWN_ANCHOR_CHECKPOINT',
      `Run ${runId} has no stored checkpoint manifest with hash ${checkpointHash}`,
    );
  }
}

/**
 * Never carries the key material itself — only the path and the reason
 * (LEDGER §11: the anchoring private key is never logged or telemetered).
 *
 * `cause` is therefore attached only for failures raised by the filesystem;
 * a curve-library rejection is re-raised without one, because its message
 * prints the candidate scalar — i.e. the file's bytes.
 */
export class AnchorKeyFileError extends AnchorError {
  constructor(
    readonly path: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super('ANCHOR_KEY_FILE', `Anchor key file ${path}: ${reason}`, options);
  }
}

/** Signals to the publisher that a retry is safe: nothing was submitted. */
export class TransientChainError extends AnchorError {
  readonly transient = true as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSIENT_CHAIN_ERROR', message, options);
  }
}

export class PendingFileInvalidError extends AnchorError {
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      'PENDING_FILE_INVALID',
      `Pending anchor submission file ${path} is not a valid canonical pending-file document`,
      options,
    );
  }
}
