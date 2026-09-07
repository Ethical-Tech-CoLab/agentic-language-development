/**
 * ALD-020 / ALD-021 / ALD-022 — the Base anchoring client.
 *
 * One checkpoint manifest in, one Anchor Receipt out (LEDGER §10): a
 * zero-value transaction from the dedicated anchor wallet to a designated
 * project address, carrying the 32-byte checkpoint digest as calldata and
 * nothing else (LEDGER §12).
 *
 * Three properties drive the design:
 *
 * 1. **Exactly one submission per checkpoint per chain.** A send that returns
 *    a hash is never retried; only a send that *threw* — meaning nothing
 *    reached the chain — is retried with exponential backoff. Before sending,
 *    an existing stored receipt or pending entry for the same
 *    `(chainId, checkpointHash)` short-circuits and the existing state is
 *    returned (ALD-018: at most one receipt per chain per checkpoint).
 * 2. **`anchor_receipts` is append-only.** `submit` therefore does *not*
 *    insert: it returns a `submitted` receipt and records the transaction
 *    hash in the pending sidecar. The single row is inserted by
 *    `awaitConfirmation` at a terminal decision — `confirmed`, `failed`, or
 *    "gave up waiting" — so the stored row is never contradicted by a later
 *    row it cannot replace.
 * 3. **Mainnet is off unless asked for twice** (ALD-022, SPEC §13.4): both
 *    the `allowMainnet` option and `ALD_ALLOW_MAINNET_ANCHORING=true`. The
 *    check runs before any RPC call, so a default-configured mainnet
 *    publisher makes zero chain calls.
 */
import { hashRunId } from '@ald/hashing';
import { AnchorReceiptSchema } from '@ald/types';
import type { AnchorPublisher, AnchorReceipt, CheckpointManifest, Clock } from '@ald/types';

import {
  AnchorNetworkMismatchError,
  AnchorPayloadMismatchError,
  AnchorSubmissionFailedError,
  InvalidFinalityPolicyError,
  MainnetAnchoringDisabledError,
  UnknownAnchorCheckpointError,
  UnknownAnchorRunError,
} from './errors.js';
import {
  addPendingSubmission,
  findPendingSubmission,
  readPendingSubmissions,
  removePendingSubmission,
  type PendingAnchorSubmission,
} from './pending.js';
import { anchorInputData } from './transport.js';
import type { AnchorNetwork, ChainTransport } from './transport.js';
import { expectedChainId } from './verify-anchor.js';

/** Environment opt-in required in addition to the constructor option. */
export const MAINNET_ANCHORING_ENV_VAR = 'ALD_ALLOW_MAINNET_ANCHORING';

/**
 * Interim confirmation depth used for the `safe-tag` policy.
 *
 * SPEC §19 ADR-05 defers the final mainnet finality-tag semantics to the
 * chosen RPC provider (ADR-01). Until that is resolved, `safe-tag` is
 * implemented as a confirmation depth of 32 blocks — one Ethereum epoch,
 * which is what Base's `safe` tag tracks — so the policy string can already
 * be recorded in run configs and receipts without depending on a
 * provider-specific tag the fake chain cannot offer.
 */
export const SAFE_TAG_CONFIRMATION_PROXY = 32;

export const DEFAULT_RETRY_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 8_000;

const NUMBERED_CONFIRMATIONS = /^(\d+)-confirmations$/u;

/**
 * Parse a `finalityPolicy` string into the confirmation depth a receipt must
 * reach before it may be reported as `confirmed` (SPEC §13.4).
 */
export function requiredConfirmations(policy: string): number {
  if (policy === '1-confirmation') {
    return 1;
  }
  if (policy === 'safe-tag') {
    return SAFE_TAG_CONFIRMATION_PROXY;
  }
  const match = NUMBERED_CONFIRMATIONS.exec(policy);
  if (match?.[1] !== undefined) {
    const depth = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(depth) && depth > 0) {
      return depth;
    }
  }
  throw new InvalidFinalityPolicyError(policy);
}

/**
 * The slice of the Evidence Writer/Reader the publisher uses. Narrowed so a
 * test double (or a future remote evidence service) can stand in for
 * `SqliteEvidenceWriter` without implementing the whole contract.
 */
export interface AnchorEvidenceStore {
  insertAnchorReceipt(receipt: AnchorReceipt): void;
  readCheckpoints(runId: string): CheckpointManifest[];
  readAnchorReceipts(runId: string): AnchorReceipt[];
  listRuns(): string[];
}

export interface AnchorRetryOptions {
  /** Total send attempts, and total confirmation polls. Default 5. */
  attempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable delay; tests pass a synchronous stub that mines a block. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BaseAnchorPublisherOptions {
  transport: ChainTransport;
  evidence: AnchorEvidenceStore;
  clock: Clock;
  /** Designated destination of the zero-value anchor transaction. */
  anchorAddress: string;
  /** `'1-confirmation'`, `'safe-tag'`, or `'<n>-confirmations'`. */
  finalityPolicy: string;
  retry?: AnchorRetryOptions;
  /** Path of the crash-durable pending-submission sidecar. */
  pendingFile?: string;
  /** ALD-022 first opt-in; the env var is the second. */
  allowMainnet?: boolean;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class BaseAnchorPublisher implements AnchorPublisher {
  readonly network: AnchorNetwork;
  readonly chainId: number;
  readonly finalityPolicy: string;
  readonly requiredConfirmations: number;

  private readonly transport: ChainTransport;
  private readonly evidence: AnchorEvidenceStore;
  private readonly clock: Clock;
  private readonly anchorAddress: string;
  private readonly attempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pendingFile: string | null;
  private readonly allowMainnet: boolean;

  constructor(options: BaseAnchorPublisherOptions) {
    this.transport = options.transport;
    this.evidence = options.evidence;
    this.clock = options.clock;
    this.anchorAddress = options.anchorAddress;
    this.network = options.transport.network;
    this.chainId = options.transport.chainId;
    this.finalityPolicy = options.finalityPolicy;
    this.requiredConfirmations = requiredConfirmations(options.finalityPolicy);
    this.attempts = options.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.initialBackoffMs =
      options.retry?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sleep = options.retry?.sleep ?? defaultSleep;
    this.pendingFile = options.pendingFile ?? null;
    this.allowMainnet = options.allowMainnet === true;

    const expected = expectedChainId(this.network);
    if (this.chainId !== expected) {
      throw new AnchorNetworkMismatchError(this.network, this.chainId, expected);
    }
    if (this.attempts < 1) {
      throw new RangeError('retry.attempts must be at least 1');
    }
  }

  /** Pending submissions still awaiting a terminal receipt row. */
  pendingSubmissions(): PendingAnchorSubmission[] {
    return this.pendingFile === null
      ? []
      : readPendingSubmissions(this.pendingFile);
  }

  /**
   * Submit the checkpoint digest and return the `submitted` receipt. The
   * receipt is deliberately *not* stored yet; see the class comment.
   */
  async submit(manifest: CheckpointManifest): Promise<AnchorReceipt> {
    this.assertNetworkAllowed();

    const runId = this.resolveRunId(manifest.runIdHash);
    this.assertCheckpointStored(runId, manifest.checkpointHash);
    const existing = this.storedReceiptFor(runId, manifest.checkpointHash);
    if (existing !== undefined) {
      return existing;
    }

    const pending = findPendingSubmission(
      this.pendingSubmissions(),
      this.chainId,
      manifest.checkpointHash,
    );
    if (pending !== undefined) {
      return this.receiptFromPending(pending);
    }

    const inputData = anchorInputData(manifest.checkpointHash);
    const sent = await this.sendWithRetry(manifest.checkpointHash);
    if (sent.inputData.toLowerCase() !== inputData.toLowerCase()) {
      throw new AnchorPayloadMismatchError(inputData, sent.inputData);
    }

    const submission: PendingAnchorSubmission = {
      version: 1,
      runId,
      checkpointSequence: manifest.checkpointSequence,
      checkpointHash: manifest.checkpointHash,
      network: this.network,
      chainId: this.chainId,
      transactionHash: sent.transactionHash,
      from: sent.from,
      to: sent.to,
      inputData: sent.inputData,
      finalityPolicy: this.finalityPolicy,
      rpcEndpointLabel: this.transport.endpointLabel,
      submittedAt: this.clock.now(),
    };
    if (this.pendingFile !== null) {
      addPendingSubmission(this.pendingFile, submission);
    }

    return this.receiptFromPending(submission);
  }

  /**
   * Poll until the transaction reaches {@link requiredConfirmations}, reverts,
   * or the attempt budget runs out, then insert the single append-only receipt
   * row and return the final receipt.
   */
  async awaitConfirmation(receipt: AnchorReceipt): Promise<AnchorReceipt> {
    this.assertNetworkAllowed();

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const chainReceipt = await this.transport.getTransactionReceipt(
        receipt.transactionHash,
      );

      if (chainReceipt !== null) {
        const head = await this.transport.latestBlockNumber();
        const confirmations = Math.max(
          0,
          head - chainReceipt.blockNumber + 1,
        );

        if (chainReceipt.status === 'reverted') {
          return this.finalize({
            ...receipt,
            status: 'failed',
            blockNumber: chainReceipt.blockNumber,
            blockHash: chainReceipt.blockHash,
            confirmations,
          });
        }
        if (confirmations >= this.requiredConfirmations) {
          return this.finalize({
            ...receipt,
            status: 'confirmed',
            blockNumber: chainReceipt.blockNumber,
            blockHash: chainReceipt.blockHash,
            confirmations,
          });
        }
      }

      if (attempt < this.attempts) {
        await this.sleep(this.backoffFor(attempt));
      }
    }

    // Attempt budget exhausted. Record what is known — the transaction was
    // submitted, finality was not observed — and keep the pending entry so an
    // operator (or SPEC §14.5 failure handling) can resume the poll later.
    return this.finalize({ ...receipt, status: 'submitted' }, { keepPending: true });
  }

  /** Convenience for the common submit-then-wait path. */
  async anchorAndConfirm(manifest: CheckpointManifest): Promise<AnchorReceipt> {
    const submitted = await this.submit(manifest);
    if (submitted.status !== 'submitted') {
      return submitted;
    }
    return this.awaitConfirmation(submitted);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** ALD-022: both opt-ins, checked before any RPC call. */
  private assertNetworkAllowed(): void {
    if (this.network !== 'base-mainnet') {
      return;
    }
    const envAllows = process.env[MAINNET_ANCHORING_ENV_VAR] === 'true';
    if (this.allowMainnet && envAllows) {
      return;
    }
    if (!this.allowMainnet && !envAllows) {
      throw new MainnetAnchoringDisabledError('both');
    }
    throw new MainnetAnchoringDisabledError(
      this.allowMainnet ? 'missing-env' : 'missing-option',
    );
  }

  private backoffFor(attempt: number): number {
    return Math.min(
      this.maxBackoffMs,
      this.initialBackoffMs * 2 ** (attempt - 1),
    );
  }

  /** LEDGER §8 manifests carry `runIdHash`; receipts carry the run id. */
  private resolveRunId(runIdHash: string): string {
    for (const runId of this.evidence.listRuns()) {
      if (hashRunId(runId) === runIdHash) {
        return runId;
      }
    }
    throw new UnknownAnchorRunError(runIdHash);
  }

  /** ALD-018: the receipt's one-to-one manifest must already be stored. */
  private assertCheckpointStored(runId: string, checkpointHash: string): void {
    const stored = this.evidence
      .readCheckpoints(runId)
      .some((manifest) => manifest.checkpointHash === checkpointHash);
    if (!stored) {
      throw new UnknownAnchorCheckpointError(runId, checkpointHash);
    }
  }

  private storedReceiptFor(
    runId: string,
    checkpointHash: string,
  ): AnchorReceipt | undefined {
    return this.evidence
      .readAnchorReceipts(runId)
      .find(
        (candidate) =>
          candidate.chainId === this.chainId &&
          candidate.checkpointHash === checkpointHash,
      );
  }

  private storedReceiptForTransaction(
    runId: string,
    transactionHash: string,
  ): AnchorReceipt | undefined {
    return this.evidence
      .readAnchorReceipts(runId)
      .find(
        (candidate) =>
          candidate.chainId === this.chainId &&
          candidate.transactionHash.toLowerCase() ===
            transactionHash.toLowerCase(),
      );
  }

  private receiptFromPending(
    submission: PendingAnchorSubmission,
  ): AnchorReceipt {
    return AnchorReceiptSchema.parse({
      version: 1,
      runId: submission.runId,
      checkpointSequence: submission.checkpointSequence,
      checkpointHash: submission.checkpointHash,
      network: submission.network,
      chainId: submission.chainId,
      transactionHash: submission.transactionHash,
      from: submission.from,
      to: submission.to,
      inputData: submission.inputData,
      blockNumber: null,
      blockHash: null,
      status: 'submitted',
      confirmations: 0,
      finalityPolicy: submission.finalityPolicy,
      rpcEndpointLabel: submission.rpcEndpointLabel,
      recordedAt: submission.submittedAt,
    });
  }

  /**
   * Insert the one append-only row for this transaction and drop the pending
   * entry. If a row already exists (a previous give-up decision) it cannot be
   * replaced, so the freshly computed receipt is returned unstored rather
   * than crashing on the `(chainId, transactionHash)` primary key.
   */
  private finalize(
    receipt: AnchorReceipt,
    options: { keepPending?: boolean } = {},
  ): AnchorReceipt {
    const final = AnchorReceiptSchema.parse({
      ...receipt,
      recordedAt: this.clock.now(),
    });

    const alreadyStored = this.storedReceiptForTransaction(
      final.runId,
      final.transactionHash,
    );
    if (alreadyStored === undefined) {
      this.evidence.insertAnchorReceipt(final);
    }

    if (this.pendingFile !== null && options.keepPending !== true) {
      removePendingSubmission(
        this.pendingFile,
        final.chainId,
        final.transactionHash,
      );
    }
    return final;
  }

  private async sendWithRetry(
    checkpointHash: string,
  ): Promise<{ transactionHash: string; from: string; to: string; inputData: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await this.transport.sendAnchorTransaction({
          checkpointHash,
          to: this.anchorAddress,
        });
      } catch (error) {
        // A throw means the transport did not return a hash, so nothing was
        // submitted and retrying cannot duplicate a transaction.
        lastError = error;
        if (attempt < this.attempts) {
          await this.sleep(this.backoffFor(attempt));
        }
      }
    }
    throw new AnchorSubmissionFailedError(this.attempts, { cause: lastError });
  }
}
