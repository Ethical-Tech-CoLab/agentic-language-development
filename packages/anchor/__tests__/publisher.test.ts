/**
 * ALD-018 (receipt storage), ALD-020 (Sepolia client), ALD-021 (confirmation
 * + retry/backoff), ALD-022 (mainnet opt-in) behavioural suite, against the
 * real `SqliteEvidenceWriter` and the deterministic fake chain.
 */
import { join } from 'node:path';

import { decodeHash } from '@ald/hashing';
import { AnchorReceiptSchema } from '@ald/types';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_CHAIN_IDS,
  AnchorSubmissionFailedError,
  BASE_BLOCK_TIME_SECONDS,
  BaseAnchorPublisher,
  DEFAULT_CONFIRMATION_POLL_ATTEMPTS,
  DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_RETRY_ATTEMPTS,
  FakeChainTransport,
  InvalidFinalityPolicyError,
  MAINNET_ANCHORING_ENV_VAR,
  MainnetAnchoringDisabledError,
  SAFE_TAG_CONFIRMATION_PROXY,
  UnknownAnchorCheckpointError,
  UnknownAnchorRunError,
  anchorInputData,
  readPendingSubmissions,
  requiredConfirmations,
  verifyAnchorReceipt,
} from '../src/index.js';
import type { AnchorTestContext } from './support.js';
import {
  ANCHOR_ADDRESS,
  cleanupTemporaryDirectories,
  createAnchorContext,
  immediateSleep,
} from './support.js';

const openContexts: AnchorTestContext[] = [];

async function context(): Promise<AnchorTestContext> {
  const created = await createAnchorContext();
  openContexts.push(created);
  return created;
}

interface PublisherOptions {
  finalityPolicy?: string;
  /** Send-retry budget. */
  attempts?: number;
  /** Confirmation-poll budget; defaults to the production default. */
  pollAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  pendingFile?: string;
  allowMainnet?: boolean;
}

function publisherFor(
  ctx: AnchorTestContext,
  transport: FakeChainTransport,
  options: PublisherOptions = {},
): BaseAnchorPublisher {
  return new BaseAnchorPublisher({
    transport,
    anchorClass: 'simulated',
    evidence: ctx.writer,
    clock: ctx.clock,
    anchorAddress: ANCHOR_ADDRESS,
    finalityPolicy: options.finalityPolicy ?? '1-confirmation',
    retry: {
      attempts: options.attempts ?? 5,
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      sleep: options.sleep ?? immediateSleep,
    },
    confirmationPoll: {
      intervalMs: 1,
      ...(options.pollAttempts === undefined
        ? {}
        : { attempts: options.pollAttempts }),
    },
    ...(options.pendingFile === undefined
      ? {}
      : { pendingFile: options.pendingFile }),
    ...(options.allowMainnet === undefined
      ? {}
      : { allowMainnet: options.allowMainnet }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  for (const open of openContexts.splice(0)) {
    open.close();
  }
  await cleanupTemporaryDirectories();
});

describe('BaseAnchorPublisher.submit (ALD-020)', () => {
  it('anchors the bare 32-byte checkpoint digest and nothing else', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport);

    const receipt = await publisher.submit(manifest);

    const digestHex = decodeHash(manifest.checkpointHash).toString('hex');
    expect(receipt.inputData).toBe(`0x${digestHex}`);
    expect(receipt.inputData).toBe(anchorInputData(manifest.checkpointHash));
    expect(receipt.inputData).toHaveLength(66);
    expect(transport.submissions[0]?.inputData).toBe(receipt.inputData);

    expect(receipt.status).toBe('submitted');
    expect(receipt.blockNumber).toBeNull();
    expect(receipt.blockHash).toBeNull();
    expect(receipt.confirmations).toBe(0);
    expect(receipt.network).toBe('base-sepolia');
    expect(receipt.chainId).toBe(ANCHOR_CHAIN_IDS['base-sepolia']);
    expect(receipt.to).toBe(ANCHOR_ADDRESS);
    expect(receipt.runId).toBe(ctx.runId);
    expect(receipt.checkpointSequence).toBe(0);
    expect(receipt.rpcEndpointLabel).toBe(transport.endpointLabel);
    expect(AnchorReceiptSchema.safeParse(receipt).success).toBe(true);

    // The append-only row is written at a terminal decision, not at submit.
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(0);
  });

  it('defaults to Base Sepolia with no opt-in (ALD-020 criterion 2)', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport);

    expect(publisher.network).toBe('base-sepolia');
    expect(publisher.chainId).toBe(84532);
    await expect(publisher.submit(manifest)).resolves.toMatchObject({
      network: 'base-sepolia',
      chainId: 84532,
    });
  });

  it('refuses to anchor a checkpoint that is not in the evidence store', async () => {
    const ctx = await context();
    const stored = await ctx.addCheckpoint();
    const publisher = publisherFor(ctx, new FakeChainTransport());

    const foreign = {
      ...stored,
      checkpointHash: `sha256:${'1'.repeat(64)}`,
    };
    await expect(publisher.submit(foreign)).rejects.toBeInstanceOf(
      UnknownAnchorCheckpointError,
    );
  });

  it('refuses a manifest whose runIdHash matches no run', async () => {
    const ctx = await context();
    const stored = await ctx.addCheckpoint();
    const publisher = publisherFor(ctx, new FakeChainTransport());

    await expect(
      publisher.submit({ ...stored, runIdHash: `sha256:${'2'.repeat(64)}` }),
    ).rejects.toBeInstanceOf(UnknownAnchorRunError);
  });
});

describe('BaseAnchorPublisher.awaitConfirmation (ALD-021)', () => {
  it("confirms at depth 1 after one block under '1-confirmation'", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      pendingFile: join(ctx.directory, 'pending.json'),
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const confirmed = await publisher.awaitConfirmation(submitted);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmations).toBe(1);
    expect(confirmed.blockNumber).toBe(1);
    expect(confirmed.blockHash).not.toBeNull();
    expect(AnchorReceiptSchema.safeParse(confirmed).success).toBe(true);

    const stored = ctx.writer.readAnchorReceipts(ctx.runId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('confirmed');
    expect(stored[0]?.checkpointHash).toBe(manifest.checkpointHash);
    expect(publisher.pendingSubmissions()).toHaveLength(0);
  });

  it("requires three blocks under '3-confirmations'", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      pollAttempts: 6,
      // Each poll interval advances the fake chain by one block.
      sleep: async () => {
        transport.mineBlock(1);
      },
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    expect(publisher.requiredConfirmations).toBe(3);

    const confirmed = await publisher.awaitConfirmation(submitted);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmations).toBe(3);
    expect(confirmed.blockNumber).toBe(1);
    expect(transport.blockNumber).toBe(3);
  });

  it("stays 'submitted', unstored, and carries the observed depth", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      pollAttempts: 2,
      pendingFile,
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const result = await publisher.awaitConfirmation(submitted);

    // Giving up is not a terminal decision: LEDGER §10 allows only one
    // append-only row per (chainId, transactionHash), and a 'submitted' row
    // could never be upgraded to the confirmation that follows.
    expect(result.status).toBe('submitted');
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(0);
    // What the poll did observe is reported to the caller.
    expect(result.blockNumber).toBe(1);
    expect(result.blockHash).not.toBeNull();
    expect(result.confirmations).toBe(1);
    expect(readPendingSubmissions(pendingFile)).toHaveLength(1);
  });

  it("records 'failed' for a reverted transaction", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, { pendingFile });

    const submitted = await publisher.submit(manifest);
    transport.failNext();
    transport.mineBlock(1);
    const failed = await publisher.awaitConfirmation(submitted);

    expect(failed.status).toBe('failed');
    expect(failed.blockNumber).toBe(1);
    expect(AnchorReceiptSchema.safeParse(failed).success).toBe(true);
    expect(ctx.writer.readAnchorReceipts(ctx.runId)[0]?.status).toBe('failed');
    expect(readPendingSubmissions(pendingFile)).toHaveLength(0);
  });

  it("gives up as 'submitted', writes no row, and keeps the pending entry", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, {
      pendingFile,
      pollAttempts: 3,
    });

    const submitted = await publisher.submit(manifest);
    const result = await publisher.awaitConfirmation(submitted);

    expect(result.status).toBe('submitted');
    expect(result.blockNumber).toBeNull();
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(0);
    expect(publisher.pendingSubmissions()).toHaveLength(1);
    expect(publisher.pendingSubmissions()[0]?.transactionHash).toBe(
      submitted.transactionHash,
    );
  });

  it('records the confirmation when a given-up poll is resumed later', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      pollAttempts: 2,
      pendingFile,
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const gaveUp = await publisher.awaitConfirmation(submitted);
    expect(gaveUp.status).toBe('submitted');
    expect(gaveUp.confirmations).toBe(1);

    // SPEC §7.2 `sealing-blocked` -> retry succeeds -> `sealing`: an operator
    // resumes the poll over the surviving pending entry.
    transport.mineBlock(10);
    const resumed = await publisher.awaitConfirmation(gaveUp);

    expect(resumed.status).toBe('confirmed');
    expect(resumed.blockNumber).toBe(1);
    const stored = ctx.writer.readAnchorReceipts(ctx.runId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('confirmed');
    expect(stored[0]?.transactionHash).toBe(submitted.transactionHash);
    expect(stored[0]?.confirmations).toBeGreaterThanOrEqual(3);
    expect(readPendingSubmissions(pendingFile)).toHaveLength(0);
    await expect(
      verifyAnchorReceipt(
        stored[0] ?? resumed,
        manifest.checkpointHash,
        transport,
      ),
    ).resolves.toMatchObject({ ok: true });

    // A further poll and a further submit neither duplicate the row nor
    // contradict it, and no second transaction is ever paid for.
    const again = await publisher.awaitConfirmation(resumed);
    expect(again.status).toBe('confirmed');
    const resubmitted = await publisher.submit(manifest);
    expect(resubmitted.status).toBe('confirmed');
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(1);
    expect(transport.submissions).toHaveLength(1);
  });

  it('resumes a given-up submission from the sidecar after a restart', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      pollAttempts: 1,
      pendingFile,
    });

    const submitted = await publisher.submit(manifest);
    await publisher.awaitConfirmation(submitted);
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(0);

    transport.mineBlock(4);
    const restarted = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      pollAttempts: 1,
      pendingFile,
    });
    const recovered = await restarted.submit(manifest);
    expect(recovered.transactionHash).toBe(submitted.transactionHash);
    const confirmed = await restarted.awaitConfirmation(recovered);

    expect(confirmed.status).toBe('confirmed');
    expect(transport.submissions).toHaveLength(1);
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(1);
    expect(readPendingSubmissions(pendingFile)).toHaveLength(0);
  });

  it('anchorAndConfirm submits and waits in one call', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      pollAttempts: 3,
      sleep: async () => {
        transport.mineBlock(1);
      },
    });

    const receipt = await publisher.anchorAndConfirm(manifest);
    expect(receipt.status).toBe('confirmed');
    expect(receipt.confirmations).toBeGreaterThanOrEqual(1);
  });
});

describe('retry and idempotency (ALD-021 criterion 2, ALD-018 criterion 3)', () => {
  it('retries a transient send failure without duplicate submission', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    transport.dropNext(2);
    const publisher = publisherFor(ctx, transport, { attempts: 5 });

    const receipt = await publisher.submit(manifest);

    expect(transport.sendAttempts).toBe(3);
    expect(transport.submissions).toHaveLength(1);
    expect(receipt.transactionHash).toBe(
      transport.submissions[0]?.transactionHash,
    );
  });

  it('fails after the attempt budget without submitting anything', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    transport.dropNext(5);
    const publisher = publisherFor(ctx, transport, { attempts: 3 });

    await expect(publisher.submit(manifest)).rejects.toBeInstanceOf(
      AnchorSubmissionFailedError,
    );
    expect(transport.sendAttempts).toBe(3);
    expect(transport.submissions).toHaveLength(0);
  });

  it('returns the existing pending state for a duplicate submit', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      pendingFile: join(ctx.directory, 'pending.json'),
    });

    const first = await publisher.submit(manifest);
    const second = await publisher.submit(manifest);

    expect(second).toEqual(first);
    expect(transport.submissions).toHaveLength(1);
  });

  it('returns the stored receipt and never re-anchors a confirmed checkpoint', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      pendingFile: join(ctx.directory, 'pending.json'),
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const confirmed = await publisher.awaitConfirmation(submitted);

    const again = await publisher.submit(manifest);
    expect(again).toEqual(confirmed);
    expect(transport.submissions).toHaveLength(1);

    // One receipt per chain per checkpoint, even across repeated polls.
    await publisher.awaitConfirmation(submitted);
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(1);
  });

  it('returns the first submission for a duplicate submit with no pendingFile', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    // The documented default: no sidecar configured at all.
    const publisher = publisherFor(ctx, transport);

    const first = await publisher.submit(manifest);
    const second = await publisher.submit(manifest);

    expect(second).toEqual(first);
    expect(transport.submissions).toHaveLength(1);

    transport.mineBlock(1);
    await publisher.awaitConfirmation(first);
    await publisher.awaitConfirmation(second);

    const rows = ctx.writer.readAnchorReceipts(ctx.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('confirmed');
  });

  it('collapses concurrent submits for one checkpoint into one transaction', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport);

    const [first, second, third] = await Promise.all([
      publisher.submit(manifest),
      publisher.submit(manifest),
      publisher.submit(manifest),
    ]);

    expect(second.transactionHash).toBe(first.transactionHash);
    expect(third.transactionHash).toBe(first.transactionHash);
    expect(transport.submissions).toHaveLength(1);
  });

  it('round-trips the pending file so a crash cannot lose the tx hash', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, { pendingFile });

    const submitted = await publisher.submit(manifest);

    const persisted = readPendingSubmissions(pendingFile);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      version: 1,
      runId: ctx.runId,
      checkpointHash: manifest.checkpointHash,
      transactionHash: submitted.transactionHash,
      from: transport.from,
      to: ANCHOR_ADDRESS,
      inputData: submitted.inputData,
      chainId: 84532,
    });
    expect(persisted[0]?.submittedAt).toBe(submitted.recordedAt);

    // A fresh publisher (process restart) recovers the submission instead of
    // paying for a second transaction.
    const restarted = publisherFor(ctx, transport, { pendingFile });
    const recovered = await restarted.submit(manifest);
    expect(recovered.transactionHash).toBe(submitted.transactionHash);
    expect(transport.submissions).toHaveLength(1);

    transport.mineBlock(1);
    const confirmed = await restarted.awaitConfirmation(recovered);
    expect(confirmed.status).toBe('confirmed');
    expect(readPendingSubmissions(pendingFile)).toHaveLength(0);
  });
});

describe('finality policy parsing (SPEC §13.4, ADR-05)', () => {
  it('parses the supported policies', () => {
    expect(requiredConfirmations('1-confirmation')).toBe(1);
    expect(requiredConfirmations('3-confirmations')).toBe(3);
    expect(requiredConfirmations('12-confirmations')).toBe(12);
    expect(requiredConfirmations('safe-tag')).toBe(
      SAFE_TAG_CONFIRMATION_PROXY,
    );
  });

  it("brackets Base's safe head with one L1 epoch of Base blocks", () => {
    // One Ethereum epoch = 32 slots x 12 s = 384 s; Base blocks are 2 s.
    const epochSeconds = 32 * 12;
    expect(SAFE_TAG_CONFIRMATION_PROXY).toBe(
      epochSeconds / BASE_BLOCK_TIME_SECONDS,
    );
    expect(SAFE_TAG_CONFIRMATION_PROXY).toBe(192);
  });

  it('budgets enough confirmation polls to reach the safe-tag depth', () => {
    const pollableBlocks =
      (DEFAULT_CONFIRMATION_POLL_ATTEMPTS *
        DEFAULT_CONFIRMATION_POLL_INTERVAL_MS) /
      1_000 /
      BASE_BLOCK_TIME_SECONDS;
    expect(pollableBlocks).toBeGreaterThanOrEqual(SAFE_TAG_CONFIRMATION_PROXY);

    // The old shared send-retry budget could not: 5 attempts of exponential
    // backoff from 500 ms is under four Base blocks.
    const retryBlocks =
      ((DEFAULT_RETRY_ATTEMPTS - 1) * DEFAULT_INITIAL_BACKOFF_MS) /
      1_000 /
      BASE_BLOCK_TIME_SECONDS;
    expect(retryBlocks).toBeLessThan(SAFE_TAG_CONFIRMATION_PROXY);
  });

  it("reaches the safe-tag depth under the default poll budget", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: 'safe-tag',
      // No pollAttempts: the production default has to suffice.
      sleep: async () => {
        transport.mineBlock(1);
      },
    });

    expect(publisher.requiredConfirmations).toBe(SAFE_TAG_CONFIRMATION_PROXY);
    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const confirmed = await publisher.awaitConfirmation(submitted);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmations).toBe(SAFE_TAG_CONFIRMATION_PROXY);

    // A publisher budgeted like the old shared send-retry path gives up
    // without ever writing a row.
    const secondManifest = await ctx.addCheckpoint('event-interval');
    const shallow = publisherFor(ctx, new FakeChainTransport(), {
      finalityPolicy: 'safe-tag',
      pollAttempts: DEFAULT_RETRY_ATTEMPTS,
    });
    const gaveUp = await shallow.anchorAndConfirm(secondManifest);
    expect(gaveUp.status).toBe('submitted');
    expect(
      ctx.writer
        .readAnchorReceipts(ctx.runId)
        .filter((row) => row.checkpointHash === secondManifest.checkpointHash),
    ).toHaveLength(0);
  });

  it('rejects an unparseable policy at construction time', async () => {
    const ctx = await context();
    expect(() => requiredConfirmations('eventually')).toThrow(
      InvalidFinalityPolicyError,
    );
    expect(() =>
      publisherFor(ctx, new FakeChainTransport(), {
        finalityPolicy: '0-confirmations',
      }),
    ).toThrow(InvalidFinalityPolicyError);
  });
});

describe('mainnet policy switch (ALD-022)', () => {
  const mainnetTransport = (): FakeChainTransport =>
    new FakeChainTransport({ network: 'base-mainnet' });

  it('makes zero chain calls with no opt-in at all', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = mainnetTransport();
    const publisher = publisherFor(ctx, transport);

    await expect(publisher.submit(manifest)).rejects.toBeInstanceOf(
      MainnetAnchoringDisabledError,
    );
    await expect(
      publisher.awaitConfirmation({
        ...(await publisherFor(ctx, new FakeChainTransport()).submit(manifest)),
        network: 'base-mainnet',
        chainId: 8453,
      }),
    ).rejects.toBeInstanceOf(MainnetAnchoringDisabledError);
    expect(transport.rpcCalls).toBe(0);
    expect(transport.chainId).toBe(8453);
  });

  it('refuses with only the constructor opt-in', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = mainnetTransport();
    const publisher = publisherFor(ctx, transport, { allowMainnet: true });

    await expect(publisher.submit(manifest)).rejects.toMatchObject({
      code: 'MAINNET_ANCHORING_DISABLED',
      reason: 'missing-env',
    });
    expect(transport.rpcCalls).toBe(0);
  });

  it('refuses with only the environment opt-in', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    vi.stubEnv(MAINNET_ANCHORING_ENV_VAR, 'true');
    const transport = mainnetTransport();
    const publisher = publisherFor(ctx, transport);

    await expect(publisher.submit(manifest)).rejects.toMatchObject({
      reason: 'missing-option',
    });
    expect(transport.rpcCalls).toBe(0);
  });

  it('anchors to mainnet with both opt-ins, and reverts when either is removed', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    vi.stubEnv(MAINNET_ANCHORING_ENV_VAR, 'true');
    const transport = mainnetTransport();
    const publisher = publisherFor(ctx, transport, { allowMainnet: true });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const confirmed = await publisher.awaitConfirmation(submitted);

    expect(confirmed.network).toBe('base-mainnet');
    expect(confirmed.chainId).toBe(8453);
    expect(confirmed.status).toBe('confirmed');
    expect(AnchorReceiptSchema.safeParse(confirmed).success).toBe(true);

    // Flipping the environment switch off restores the refusal with no code
    // change; a Sepolia publisher over the same evidence store still works.
    vi.stubEnv(MAINNET_ANCHORING_ENV_VAR, '');
    const secondManifest = await ctx.addCheckpoint('event-interval');
    await expect(publisher.submit(secondManifest)).rejects.toBeInstanceOf(
      MainnetAnchoringDisabledError,
    );
    const sepolia = publisherFor(ctx, new FakeChainTransport());
    await expect(sepolia.submit(secondManifest)).resolves.toMatchObject({
      network: 'base-sepolia',
    });
  });
});
