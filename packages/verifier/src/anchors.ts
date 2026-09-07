/**
 * Anchor verification: steps 10-11 of LEDGER-INTEGRITY-DESIGN.md §14 and the
 * receipt rules of docs/evidence-bundle-format.md §8.
 *
 * The pure half runs with no network at all: `anchors/base-receipts.json` must
 * bind each receipt to a checkpoint of this bundle, the calldata must be
 * exactly the 32-byte checkpoint digest, and the chain id must be the one
 * belonging to the declared network. The on-chain half runs only when an
 * independent {@link ChainReader} is injected (`--rpc-url`), so the verifier
 * has no chain dependency of its own (SPEC §4.2, BACKLOG ALD-015/ALD-021).
 */
import { decodeHash } from '@ald/hashing';
import { AnchorReceiptSchema, type AnchorReceipt } from '@ald/types';

import { bundlePath, formatIssues, readCanonicalJsonFile } from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedCheckpoint } from './checkpoints.js';

/** LEDGER §10: the two networks a run may anchor to, and their chain ids. */
export const NETWORK_CHAIN_IDS: Record<AnchorReceipt['network'], number> = {
  'base-sepolia': 84_532,
  'base-mainnet': 8_453,
};

export interface ChainTransaction {
  to: string | null;
  input: string;
  blockNumber: number | null;
  blockHash: string | null;
}

export interface ChainTransactionReceipt {
  status: 'success' | 'reverted';
  blockNumber: number;
  blockHash: string;
}

/**
 * Minimal read-only chain access the verifier needs. Injected so the library
 * never imports a chain client and the CLI can build one from a plain
 * JSON-RPC endpoint (`@ald/anchor` is deliberately not a dependency).
 */
export interface ChainReader {
  readonly chainId: number;
  getTransaction(transactionHash: string): Promise<ChainTransaction | null>;
  getTransactionReceipt(
    transactionHash: string,
  ): Promise<ChainTransactionReceipt | null>;
}

export interface AnchorVerificationInput {
  bundleDir: string;
  checkpoints: readonly LoadedCheckpoint[];
  accumulator: VerificationAccumulator;
  chainReader?: ChainReader | undefined;
  /** `--allow-unanchored`: a missing anchor is reported but not fatal. */
  allowUnanchored: boolean;
}

export interface AnchorVerificationResult {
  receipts: AnchorReceipt[];
  /** Highest checkpoint sequence covered by a confirmed anchor, else `null`. */
  anchoredThroughCheckpoint: number | null;
  /** `true` when the chain half ran (an RPC reader was supplied). */
  chainChecked: boolean;
}

/** Bundle §8: calldata is `0x` + the 32-byte checkpoint digest. */
export function expectedInputData(checkpointHash: string): string {
  return `0x${decodeHash(checkpointHash).toString('hex')}`;
}

function sameHex(left: string | null | undefined, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

export async function verifyAnchors(
  input: AnchorVerificationInput,
): Promise<AnchorVerificationResult> {
  const { accumulator, checkpoints, chainReader, allowUnanchored } = input;
  const path = bundlePath(input.bundleDir, 'anchors', 'base-receipts.json');
  const raw = await readCanonicalJsonFile(path);
  const result: AnchorVerificationResult = {
    receipts: [],
    anchoredThroughCheckpoint: null,
    chainChecked: chainReader !== undefined,
  };

  if (!raw.ok) {
    if (raw.code === 'canonical-json-invalid') {
      accumulator.fail(
        'canonicalJsonValid',
        raw.code,
        `anchors/base-receipts.json: ${raw.detail}`,
      );
    } else {
      accumulator.failStructural(
        raw.code,
        `anchors/base-receipts.json: ${raw.detail}`,
      );
    }
    accumulator.fail(
      'anchorTxConfirmed',
      'anchor-receipts-unreadable',
      'anchors/base-receipts.json could not be read',
      { escalate: !allowUnanchored },
    );
    return result;
  }

  if (!Array.isArray(raw.value)) {
    accumulator.failStructural(
      'schema-invalid',
      'anchors/base-receipts.json: expected a JSON array of anchor receipts',
    );
    accumulator.fail(
      'anchorTxConfirmed',
      'anchor-receipts-unreadable',
      'anchors/base-receipts.json is not an array',
      { escalate: !allowUnanchored },
    );
    return result;
  }

  const byCheckpointHash = new Map<string, LoadedCheckpoint>();
  for (const checkpoint of checkpoints) {
    byCheckpointHash.set(checkpoint.manifest.checkpointHash, checkpoint);
  }
  const finalCheckpoint = checkpoints.at(-1);

  const entries: unknown[] = raw.value;
  entries.forEach((entry, index) => {
    const parsed = AnchorReceiptSchema.safeParse(entry);
    if (!parsed.success) {
      accumulator.failStructural(
        'schema-invalid',
        `anchors/base-receipts.json[${String(index)}]: ${formatIssues(parsed.error.issues)}`,
      );
      return;
    }
    result.receipts.push(parsed.data);
  });

  for (const receipt of result.receipts) {
    const at = `anchor ${receipt.transactionHash}`;
    const expectedChainId = NETWORK_CHAIN_IDS[receipt.network];
    if (receipt.chainId !== expectedChainId) {
      accumulator.fail(
        'anchorChainIdMatches',
        'anchor-chain-id-mismatch',
        `${at}: network ${receipt.network} requires chainId ${String(expectedChainId)}, receipt claims ${String(receipt.chainId)}`,
      );
    }
    if (chainReader !== undefined && chainReader.chainId !== receipt.chainId) {
      accumulator.fail(
        'anchorChainIdMatches',
        'anchor-chain-id-mismatch',
        `${at}: RPC endpoint reports chainId ${String(chainReader.chainId)}, receipt claims ${String(receipt.chainId)}`,
      );
    }

    const checkpoint = byCheckpointHash.get(receipt.checkpointHash);
    if (checkpoint === undefined) {
      accumulator.failStructural(
        'anchor-checkpoint-unknown',
        `${at}: checkpointHash ${receipt.checkpointHash} is not a checkpoint of this bundle`,
      );
      continue;
    }
    if (checkpoint.sequence !== receipt.checkpointSequence) {
      accumulator.failStructural(
        'anchor-checkpoint-sequence-mismatch',
        `${at}: receipt claims checkpoint ${String(receipt.checkpointSequence)}, the hash belongs to checkpoint ${String(checkpoint.sequence)}`,
      );
    }

    const expectedCalldata = expectedInputData(receipt.checkpointHash);
    if (!sameHex(receipt.inputData, expectedCalldata)) {
      accumulator.failStructural(
        'anchor-input-mismatch',
        `${at}: inputData ${receipt.inputData} is not the checkpoint digest ${expectedCalldata}`,
      );
      continue;
    }

    if (receipt.status !== 'confirmed') {
      accumulator.fail(
        'anchorTxConfirmed',
        'anchor-not-confirmed',
        `${at}: status is ${receipt.status}`,
        { escalate: !allowUnanchored },
      );
      continue;
    }

    let chainOk = true;
    if (chainReader !== undefined) {
      chainOk = await verifyOnChain(receipt, expectedCalldata, chainReader, accumulator);
    }

    if (chainOk) {
      result.anchoredThroughCheckpoint = Math.max(
        result.anchoredThroughCheckpoint ?? 0,
        checkpoint.sequence,
      );
    }
  }

  if (finalCheckpoint === undefined) {
    accumulator.fail(
      'anchorTxConfirmed',
      'anchor-no-checkpoint',
      'the bundle commits no checkpoint that could be anchored',
      { escalate: !allowUnanchored },
    );
    return result;
  }
  if (result.anchoredThroughCheckpoint !== finalCheckpoint.sequence) {
    accumulator.fail(
      'anchorTxConfirmed',
      'anchor-final-checkpoint-unanchored',
      `checkpoint ${String(finalCheckpoint.sequence)} (${finalCheckpoint.manifest.checkpointHash}) has no confirmed anchor transaction`,
      { escalate: !allowUnanchored },
    );
  }

  return result;
}

/**
 * LEDGER §14 item 11: retrieve the transaction from an independent provider
 * and confirm calldata, recipient, receipt status, and block inclusion.
 */
async function verifyOnChain(
  receipt: AnchorReceipt,
  expectedCalldata: string,
  chainReader: ChainReader,
  accumulator: VerificationAccumulator,
): Promise<boolean> {
  const at = `anchor ${receipt.transactionHash}`;
  const fail = (code: string, detail: string): void => {
    accumulator.fail('anchorTxConfirmed', code, `${at}: ${detail}`);
  };

  let transaction: ChainTransaction | null;
  let chainReceipt: ChainTransactionReceipt | null;
  try {
    transaction = await chainReader.getTransaction(receipt.transactionHash);
    chainReceipt = await chainReader.getTransactionReceipt(receipt.transactionHash);
  } catch (error) {
    fail(
      'anchor-rpc-error',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }

  if (transaction === null) {
    fail('anchor-tx-missing', 'the RPC endpoint does not know this transaction');
    return false;
  }

  let ok = true;
  if (!sameHex(transaction.input, expectedCalldata)) {
    fail(
      'anchor-tx-input-mismatch',
      `on-chain calldata ${transaction.input} is not the checkpoint digest ${expectedCalldata}`,
    );
    ok = false;
  }
  if (!sameHex(transaction.to, receipt.to)) {
    fail(
      'anchor-tx-to-mismatch',
      `on-chain recipient ${String(transaction.to)} does not match the receipt (${receipt.to})`,
    );
    ok = false;
  }
  if (chainReceipt === null) {
    fail('anchor-tx-unmined', 'the transaction has no receipt on chain');
    return false;
  }
  if (chainReceipt.status !== 'success') {
    fail('anchor-tx-reverted', `on-chain receipt status is ${chainReceipt.status}`);
    ok = false;
  }
  if (
    receipt.blockNumber !== null &&
    receipt.blockNumber !== chainReceipt.blockNumber
  ) {
    fail(
      'anchor-tx-block-mismatch',
      `receipt claims block ${String(receipt.blockNumber)}, chain reports ${String(chainReceipt.blockNumber)}`,
    );
    ok = false;
  }
  if (receipt.blockHash !== null && !sameHex(chainReceipt.blockHash, receipt.blockHash)) {
    fail(
      'anchor-tx-block-mismatch',
      `receipt claims block hash ${receipt.blockHash}, chain reports ${chainReceipt.blockHash}`,
    );
    ok = false;
  }
  return ok;
}
