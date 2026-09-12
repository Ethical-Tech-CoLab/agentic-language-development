/**
 * ALD-021 verifier half: a genuine receipt verifies against the chain, and
 * every wrong-chain / false-anchor / failed / missing case fails with a
 * located problem (LEDGER §17 anchor mutation cases, E00 readiness).
 */
import { decodeHash } from '@ald/hashing';
import type { AnchorReceipt } from '@ald/types';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BaseAnchorPublisher,
  FakeChainTransport,
  expectedChainId,
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

interface Anchored {
  ctx: AnchorTestContext;
  transport: FakeChainTransport;
  receipt: AnchorReceipt;
  checkpointHash: string;
}

async function anchored(): Promise<Anchored> {
  const ctx = await createAnchorContext();
  openContexts.push(ctx);
  const manifest = await ctx.addCheckpoint();
  const transport = new FakeChainTransport();
  const publisher = new BaseAnchorPublisher({
    transport,
    anchorClass: 'simulated',
    evidence: ctx.writer,
    clock: ctx.clock,
    anchorAddress: ANCHOR_ADDRESS,
    finalityPolicy: '1-confirmation',
    retry: { attempts: 3, initialBackoffMs: 1, sleep: immediateSleep },
  });
  const submitted = await publisher.submit(manifest);
  transport.mineBlock(1);
  const receipt = await publisher.awaitConfirmation(submitted);
  return {
    ctx,
    transport,
    receipt,
    checkpointHash: manifest.checkpointHash,
  };
}

afterAll(async () => {
  for (const open of openContexts.splice(0)) {
    open.close();
  }
  await cleanupTemporaryDirectories();
});

describe('expectedChainId', () => {
  it('pins the Base chain ids', () => {
    expect(expectedChainId('base-sepolia')).toBe(84532);
    expect(expectedChainId('base-mainnet')).toBe(8453);
  });
});

describe('verifyAnchorReceipt', () => {
  it('accepts a genuine anchored receipt against the chain', async () => {
    const { receipt, checkpointHash, transport } = await anchored();

    const result = await verifyAnchorReceipt(receipt, checkpointHash, transport);

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      inputDataMatchesCheckpoint: true,
      chainIdMatchesNetwork: true,
      statusConfirmed: true,
      chainTransactionFound: true,
      chainInputMatches: true,
      chainToMatches: true,
      receiptStatusSuccess: true,
      blockIncluded: true,
    });
  });

  it('verifies the pure checks offline with no reader', async () => {
    const { receipt, checkpointHash } = await anchored();

    const result = await verifyAnchorReceipt(receipt, checkpointHash, null);

    expect(result.ok).toBe(true);
    expect(result.checks.inputDataMatchesCheckpoint).toBe(true);
    expect(result.checks.chainTransactionFound).toBeNull();
    expect(result.checks.receiptStatusSuccess).toBeNull();
    expect(result.checks.blockIncluded).toBeNull();
  });

  it('fails when the reader is on the wrong chain', async () => {
    const { receipt, checkpointHash } = await anchored();
    const wrongChain = new FakeChainTransport({ network: 'base-mainnet' });

    const result = await verifyAnchorReceipt(
      receipt,
      checkpointHash,
      wrongChain,
    );

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/chain reader is connected/u);
    expect(result.checks.chainTransactionFound).toBeNull();
  });

  it('fails when the receipt chain id contradicts its network', async () => {
    const { receipt, checkpointHash } = await anchored();

    const result = await verifyAnchorReceipt(
      { ...receipt, chainId: 8453 },
      checkpointHash,
      null,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.chainIdMatchesNetwork).toBe(false);
  });

  it('fails when the calldata is not the checkpoint digest', async () => {
    const { receipt, checkpointHash } = await anchored();

    const tampered = await verifyAnchorReceipt(
      { ...receipt, inputData: `0x${'ab'.repeat(32)}` },
      checkpointHash,
      null,
    );
    expect(tampered.ok).toBe(false);
    expect(tampered.checks.inputDataMatchesCheckpoint).toBe(false);

    // Same receipt, but the verifier recomputed a different checkpoint hash:
    // a false anchor of some other checkpoint.
    const otherCheckpoint = await verifyAnchorReceipt(
      receipt,
      `sha256:${'9'.repeat(64)}`,
      null,
    );
    expect(otherCheckpoint.ok).toBe(false);
    expect(otherCheckpoint.checks.inputDataMatchesCheckpoint).toBe(false);
  });

  it('fails when the on-chain calldata differs from the receipt', async () => {
    const { receipt, checkpointHash } = await anchored();
    const forged = new FakeChainTransport();
    forged.setTransaction(
      {
        hash: receipt.transactionHash,
        from: receipt.from,
        to: receipt.to,
        input: `0x${'cd'.repeat(32)}`,
        blockNumber: 1,
        blockHash: receipt.blockHash,
      },
      { status: 'success', blockNumber: 1, blockHash: receipt.blockHash ?? '' },
    );

    const result = await verifyAnchorReceipt(receipt, checkpointHash, forged);

    expect(result.ok).toBe(false);
    expect(result.checks.chainInputMatches).toBe(false);
  });

  it('fails when the transaction does not exist on chain', async () => {
    const { receipt, checkpointHash } = await anchored();
    const emptyChain = new FakeChainTransport();

    const result = await verifyAnchorReceipt(
      receipt,
      checkpointHash,
      emptyChain,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.chainTransactionFound).toBe(false);
    expect(result.problems.join('\n')).toMatch(/does not exist on chain/u);
  });

  it('fails when the on-chain transaction reverted', async () => {
    const ctx = await createAnchorContext('run-anchor-reverted');
    openContexts.push(ctx);
    const manifest = await ctx.addCheckpoint();
    const transport = new FakeChainTransport();
    const publisher = new BaseAnchorPublisher({
      transport,
      anchorClass: 'simulated',
      evidence: ctx.writer,
      clock: ctx.clock,
      anchorAddress: ANCHOR_ADDRESS,
      finalityPolicy: '1-confirmation',
      retry: { attempts: 2, initialBackoffMs: 1, sleep: immediateSleep },
    });
    const submitted = await publisher.submit(manifest);
    transport.failNext();
    transport.mineBlock(1);
    const failed = await publisher.awaitConfirmation(submitted);

    const asStored = await verifyAnchorReceipt(
      failed,
      manifest.checkpointHash,
      transport,
    );
    expect(asStored.ok).toBe(false);
    expect(asStored.checks.statusConfirmed).toBe(false);

    // Even a receipt that *claims* confirmation fails on the chain receipt.
    const overclaimed = await verifyAnchorReceipt(
      { ...failed, status: 'confirmed' },
      manifest.checkpointHash,
      transport,
    );
    expect(overclaimed.ok).toBe(false);
    expect(overclaimed.checks.receiptStatusSuccess).toBe(false);
  });

  it('fails when the on-chain destination is not the receipt destination', async () => {
    const { receipt, checkpointHash } = await anchored();
    const forged = new FakeChainTransport();
    forged.setTransaction(
      {
        hash: receipt.transactionHash,
        from: receipt.from,
        to: `0x${'e1'.repeat(20)}`,
        input: `0x${decodeHash(checkpointHash).toString('hex')}`,
        blockNumber: 1,
        blockHash: receipt.blockHash,
      },
      { status: 'success', blockNumber: 1, blockHash: receipt.blockHash ?? '' },
    );

    const result = await verifyAnchorReceipt(receipt, checkpointHash, forged);

    expect(result.ok).toBe(false);
    expect(result.checks.chainToMatches).toBe(false);
  });

  it('fails when the transaction is not yet in the claimed block', async () => {
    const { receipt, checkpointHash } = await anchored();
    const mempoolOnly = new FakeChainTransport();
    mempoolOnly.setTransaction({
      hash: receipt.transactionHash,
      from: receipt.from,
      to: receipt.to,
      input: receipt.inputData,
      blockNumber: null,
      blockHash: null,
    });

    const result = await verifyAnchorReceipt(
      receipt,
      checkpointHash,
      mempoolOnly,
    );

    expect(result.ok).toBe(false);
    expect(result.checks.blockIncluded).toBe(false);
    expect(result.checks.receiptStatusSuccess).toBe(false);
  });
});
