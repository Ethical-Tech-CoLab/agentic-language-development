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
 *    an existing stored receipt, an in-memory reservation, or a pending
 *    sidecar entry for the same `(chainId, checkpointHash)` short-circuits and
 *    the existing state is returned (ALD-018: at most one receipt per chain
 *    per checkpoint). The reservation is unconditional, so the guard holds
 *    with or without a configured `pendingFile`.
 * 2. **`anchor_receipts` is append-only.** `submit` therefore does *not*
 *    insert: it returns a `submitted` receipt and records the transaction
 *    hash in the reservation map and the pending sidecar. The single row is
 *    inserted by `awaitConfirmation` at a *terminal* decision — `confirmed`
 *    or `failed` — so the stored row is never contradicted by a later row it
 *    cannot replace. "Gave up waiting" is deliberately **not** terminal: no
 *    row is written, the pending entry stays as the resume handle, and the
 *    unstored `submitted` receipt carries whatever confirmation depth was
 *    observed.
 * 3. **Two independent budgets.** `retry` bounds how long a *send* outage is
 *    ridden out; `confirmationPoll` bounds how long the publisher waits for
 *    the configured depth, and its defaults are sized to actually reach the
 *    `safe-tag` depth on Base (SPEC §13.4). Sharing one budget made the
 *    mainnet default unreachable.
 * 4. **Mainnet is off unless asked for twice** (ALD-022, SPEC §13.4): both
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
 * SPEC §13.4 requires mainnet runs to wait for the `safe` block tag "or
 * equivalent finality/confirmation-depth policy", and SPEC §19 ADR-05 defers
 * the provider-specific tag naming to ADR-01. Until that is resolved,
 * `safe-tag` is implemented as a confirmation *depth* that brackets Base's
 * safe head, so the policy string can already be recorded in run configs and
 * receipts without depending on a tag the fake chain cannot offer.
 *
 * The arithmetic, in Base blocks (the unit this depth is counted in): Base's
 * `safe` tag tracks the L1 justified checkpoint, one Ethereum epoch behind —
 * 32 slots x 12 s = 384 s — and Base produces one block every 2 s, so one L1
 * epoch is 384 / 2 = 192 Base blocks. A depth of 32 Base blocks (~64 s) would
 * be roughly a sixth of that and would report a checkpoint anchored-final
 * about five L1 blocks deep, so 192 is the depth this proxy uses.
 */
export const SAFE_TAG_CONFIRMATION_PROXY = 192;

/** Base block time in seconds; the unit {@link SAFE_TAG_CONFIRMATION_PROXY} counts. */
export const BASE_BLOCK_TIME_SECONDS = 2;

export const DEFAULT_RETRY_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 8_000;

/**
 * Confirmation polling is budgeted separately from send retries (SPEC §13.4):
 * a send retry is bounded by how long an RPC outage is worth riding out, while
 * a confirmation poll must be able to *reach* the configured depth. The
 * defaults poll once per Base block for 240 polls — 480 s of chain time —
 * which clears the 384 s (192-block) `safe-tag` depth above with margin. The
 * old shared `retry.attempts` budget (5 polls, ~7.5 s of backoff, under 4 Base
 * blocks) could never reach it.
 */
export const DEFAULT_CONFIRMATION_POLL_ATTEMPTS = 240;
export const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS =
  BASE_BLOCK_TIME_SECONDS * 1_000;

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
  /** Total *send* attempts. Default 5. Confirmation polls are separate. */
  attempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable delay; tests pass a synchronous stub that mines a block. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Confirmation-poll budget, independent of the send-retry budget: this one has
 * to be able to reach {@link BaseAnchorPublisher.requiredConfirmations}
 * (SPEC §13.4). Defaults: {@link DEFAULT_CONFIRMATION_POLL_ATTEMPTS} polls,
 * one per Base block ({@link DEFAULT_CONFIRMATION_POLL_INTERVAL_MS}).
 */
export interface AnchorConfirmationPollOptions {
  attempts?: number;
  intervalMs?: number;
}

export interface BaseAnchorPublisherOptions {
  transport: ChainTransport;
  /** Declares whether receipts came from a deterministic simulation or a public chain. */
  anchorClass: AnchorReceipt['anchorClass'];
  evidence: AnchorEvidenceStore;
  clock: Clock;
  /** Designated destination of the zero-value anchor transaction. */
  anchorAddress: string;
  /** `'1-confirmation'`, `'safe-tag'`, or `'<n>-confirmations'`. */
  finalityPolicy: string;
  retry?: AnchorRetryOptions;
  confirmationPoll?: AnchorConfirmationPollOptions;
  /** Path of the crash-durable pending-submission sidecar. */
  pendingFile?: string;
  /** ALD-022 first opt-in; the env var is the second. */
  allowMainnet?: boolean;
}

/** What a poll saw on chain: the block the transaction landed in, and depth. */
interface ObservedInclusion {
  blockNumber: number;
  blockHash: string;
  confirmations: number;
}

/** ALD-018 idempotency key: one receipt per chain per checkpoint. */
function reservationKey(chainId: number, checkpointHash: string): string {
  return `${String(chainId)}:${checkpointHash.toLowerCase()}`;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class BaseAnchorPublisher implements AnchorPublisher {
  readonly anchorClass: AnchorReceipt['anchorClass'];
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
  private readonly confirmationPollAttempts: number;
  private readonly confirmationPollIntervalMs: number;
  private readonly pendingFile: string | null;
  private readonly allowMainnet: boolean;
  /**
   * Unconditional `(chainId, checkpointHash)` reservations, so a second
   * `submit()` for the same checkpoint can never produce a second transaction
   * even when no `pendingFile` is configured (ALD-018).
   */
  private readonly reservations = new Map<string, PendingAnchorSubmission>();
  /** Reservations still being sent, so concurrent submits share one send. */
  private readonly inFlight = new Map<string, Promise<AnchorReceipt>>();

  constructor(options: BaseAnchorPublisherOptions) {
    this.anchorClass = options.anchorClass;
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
    this.confirmationPollAttempts =
      options.confirmationPoll?.attempts ?? DEFAULT_CONFIRMATION_POLL_ATTEMPTS;
    this.confirmationPollIntervalMs =
      options.confirmationPoll?.intervalMs ??
      DEFAULT_CONFIRMATION_POLL_INTERVAL_MS;
    this.pendingFile = options.pendingFile ?? null;
    this.allowMainnet = options.allowMainnet === true;

    const expected = expectedChainId(this.network);
    if (this.chainId !== expected) {
      throw new AnchorNetworkMismatchError(this.network, this.chainId, expected);
    }
    if (this.attempts < 1) {
      throw new RangeError('retry.attempts must be at least 1');
    }
    if (this.confirmationPollAttempts < 1) {
      throw new RangeError('confirmationPoll.attempts must be at least 1');
    }
    if (this.confirmationPollIntervalMs < 0) {
      throw new RangeError('confirmationPoll.intervalMs must not be negative');
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
   *
   * Idempotent by `(chainId, checkpointHash)` under every configuration: a
   * stored receipt wins, then an in-memory reservation, then the pending
   * sidecar, then a send already in flight. Only when all four miss does a
   * transaction reach the chain (ALD-018, LEDGER §10).
   */
  async submit(manifest: CheckpointManifest): Promise<AnchorReceipt> {
    this.assertNetworkAllowed();

    const runId = this.resolveRunId(manifest.runIdHash);
    this.assertCheckpointStored(runId, manifest.checkpointHash);
    const existing = this.storedReceiptFor(runId, manifest.checkpointHash);
    if (existing !== undefined) {
      return existing;
    }

    const key = reservationKey(this.chainId, manifest.checkpointHash);
    const reserved = this.reservedSubmission(key, manifest.checkpointHash);
    if (reserved !== undefined) {
      return this.receiptFromPending(reserved);
    }

    const started = this.inFlight.get(key);
    if (started !== undefined) {
      return await started;
    }

    const sending = this.sendAndReserve(runId, manifest, key);
    this.inFlight.set(key, sending);
    try {
      return await sending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Poll until the transaction reaches {@link requiredConfirmations} or
   * reverts, then insert the single append-only receipt row and return it.
   *
   * If the confirmation-poll budget runs out first that is *not* a terminal
   * decision: no row is inserted, the pending entry stays as the resume
   * handle, and the returned (unstored) `submitted` receipt carries the depth
   * observed so far, so a later call over the same pending entry can still
   * record the confirmation (SPEC §7.2 `sealing-blocked` -> retry -> `sealing`).
   */
  async awaitConfirmation(receipt: AnchorReceipt): Promise<AnchorReceipt> {
    this.assertNetworkAllowed();

    let observed: ObservedInclusion | null = null;

    for (
      let attempt = 1;
      attempt <= this.confirmationPollAttempts;
      attempt += 1
    ) {
      const chainReceipt = await this.transport.getTransactionReceipt(
        receipt.transactionHash,
      );

      if (chainReceipt !== null) {
        const head = await this.transport.latestBlockNumber();
        observed = {
          blockNumber: chainReceipt.blockNumber,
          blockHash: chainReceipt.blockHash,
          confirmations: Math.max(0, head - chainReceipt.blockNumber + 1),
        };

        if (chainReceipt.status === 'reverted') {
          return this.finalize({ ...receipt, status: 'failed', ...observed });
        }
        if (observed.confirmations >= this.requiredConfirmations) {
          return this.finalize({ ...receipt, status: 'confirmed', ...observed });
        }
      }

      if (attempt < this.confirmationPollAttempts) {
        await this.sleep(this.confirmationPollIntervalMs);
      }
    }

    return this.giveUp(receipt, observed);
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
      anchorClass: submission.anchorClass,
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

  /** Reservation for this checkpoint, in memory or in the sidecar. */
  private reservedSubmission(
    key: string,
    checkpointHash: string,
  ): PendingAnchorSubmission | undefined {
    return (
      this.reservations.get(key) ??
      findPendingSubmission(
        this.pendingSubmissions(),
        this.chainId,
        checkpointHash,
      )
    );
  }

  /**
   * Send once, then reserve the `(chainId, checkpointHash)` key in memory and
   * — when configured — in the crash-durable sidecar, before the receipt is
   * handed back. The in-memory half is what makes the guard unconditional.
   */
  private async sendAndReserve(
    runId: string,
    manifest: CheckpointManifest,
    key: string,
  ): Promise<AnchorReceipt> {
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
      anchorClass: this.anchorClass,
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
    this.reservations.set(key, submission);
    if (this.pendingFile !== null) {
      addPendingSubmission(this.pendingFile, submission);
    }

    return this.receiptFromPending(submission);
  }

  /**
   * Confirmation-poll budget exhausted: a non-terminal outcome, so nothing is
   * written to the append-only `anchor_receipts` table and nothing is removed
   * from the pending sidecar. The returned receipt reports the observed depth
   * and is explicitly *not* stored (LEDGER §10: only `confirmed` and `failed`
   * are terminal, and a `submitted` row could never be upgraded because
   * `(chainId, transactionHash)` is the primary key).
   */
  private giveUp(
    receipt: AnchorReceipt,
    observed: ObservedInclusion | null,
  ): AnchorReceipt {
    const stored = this.storedReceiptForTransaction(
      receipt.runId,
      receipt.transactionHash,
    );
    if (stored !== undefined) {
      return stored;
    }
    return AnchorReceiptSchema.parse({
      ...receipt,
      status: 'submitted',
      blockNumber: observed?.blockNumber ?? receipt.blockNumber,
      blockHash: observed?.blockHash ?? receipt.blockHash,
      confirmations: observed?.confirmations ?? receipt.confirmations,
      recordedAt: this.clock.now(),
    });
  }

  /**
   * Insert the one append-only row for this transaction, then drop the pending
   * entry and the reservation.
   *
   * If a row already exists it cannot be replaced, so the *stored* row is
   * returned — never the freshly computed one, which no caller may mistake for
   * persisted evidence — and the pending entry is left untouched: a call that
   * inserted nothing must not destroy another call's resume handle.
   */
  private finalize(receipt: AnchorReceipt): AnchorReceipt {
    const final = AnchorReceiptSchema.parse({
      ...receipt,
      recordedAt: this.clock.now(),
    });

    const alreadyStored = this.storedReceiptForTransaction(
      final.runId,
      final.transactionHash,
    );
    if (alreadyStored !== undefined) {
      return alreadyStored;
    }

    this.evidence.insertAnchorReceipt(final);
    this.reservations.delete(
      reservationKey(final.chainId, final.checkpointHash),
    );
    if (this.pendingFile !== null) {
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
