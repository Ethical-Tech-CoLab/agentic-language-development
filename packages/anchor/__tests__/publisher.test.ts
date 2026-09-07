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
  BaseAnchorPublisher,
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
  attempts?: number;
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
      attempts: 6,
      // Each backoff advances the fake chain by one block.
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

  it("stays 'submitted' until the confirmation depth is reached", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      finalityPolicy: '3-confirmations',
      attempts: 2,
    });

    const submitted = await publisher.submit(manifest);
    transport.mineBlock(1);
    const result = await publisher.awaitConfirmation(submitted);

    expect(result.status).toBe('submitted');
    expect(ctx.writer.readAnchorReceipts(ctx.runId)[0]?.status).toBe(
      'submitted',
    );
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

  it("gives up as 'submitted' and keeps the pending entry when never mined", async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const pendingFile = join(ctx.directory, 'pending.json');
    const publisher = publisherFor(ctx, transport, {
      pendingFile,
      attempts: 3,
    });

    const submitted = await publisher.submit(manifest);
    const result = await publisher.awaitConfirmation(submitted);

    expect(result.status).toBe('submitted');
    expect(result.blockNumber).toBeNull();
    const stored = ctx.writer.readAnchorReceipts(ctx.runId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('submitted');
    expect(publisher.pendingSubmissions()).toHaveLength(1);
    expect(publisher.pendingSubmissions()[0]?.transactionHash).toBe(
      submitted.transactionHash,
    );
  });

  it('anchorAndConfirm submits and waits in one call', async () => {
    const ctx = await context();
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = publisherFor(ctx, transport, {
      attempts: 3,
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
