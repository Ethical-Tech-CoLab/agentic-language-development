/**
 * ALD-021, verifier half: validate one Anchor Receipt with no trust in the
 * process that produced it.
 *
 * Two layers, in this order:
 *
 * 1. **Pure checks** (no network): the receipt's calldata is exactly the
 *    32-byte digest of the checkpoint hash the caller recomputed locally
 *    (LEDGER §10/§12), its chain id matches its declared network, and its
 *    status is `confirmed`. An offline bundle check passes `reader: null` and
 *    still gets all three.
 * 2. **Chain checks** (only with a reader): the transaction exists on an
 *    independently configured RPC, its calldata and destination match the
 *    receipt, its own receipt says `success`, and it is included in a block.
 *
 * Nothing here throws for a *failed* check — a verifier reports, it does not
 * crash. Only a reader that itself rejects a call propagates, and that is
 * caught and turned into a problem string.
 */
import type { AnchorReceipt } from '@ald/types';

import { ANCHOR_CHAIN_IDS, anchorInputData } from './transport.js';
import type { AnchorNetwork, ChainReader } from './transport.js';

/** Chain id Base fixes for `network`; the receipt must agree with it. */
export function expectedChainId(network: AnchorNetwork): number {
  return ANCHOR_CHAIN_IDS[network];
}

/**
 * `null` means "not evaluated" — either no reader was supplied, or an earlier
 * check (reader on the wrong chain, transaction absent) made the later ones
 * meaningless.
 */
export interface AnchorVerificationChecks {
  /**
   * Calldata is `0x` + the raw digest of `expectedCheckpointHash`, and the
   * receipt commits to that same checkpoint hash.
   */
  inputDataMatchesCheckpoint: boolean;
  chainIdMatchesNetwork: boolean;
  statusConfirmed: boolean;
  chainTransactionFound: boolean | null;
  chainInputMatches: boolean | null;
  chainToMatches: boolean | null;
  receiptStatusSuccess: boolean | null;
  blockIncluded: boolean | null;
}

export interface AnchorVerificationResult {
  ok: boolean;
  checks: AnchorVerificationChecks;
  problems: string[];
}

function sameHex(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return false;
  }
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Verify one receipt against the checkpoint hash the caller recomputed from
 * the local bundle, and (optionally) against the chain itself.
 *
 * @param receipt - receipt as stored in the evidence bundle.
 * @param expectedCheckpointHash - locally recomputed `sha256:<hex>` digest.
 * @param reader - independently configured RPC, or `null` for offline mode.
 */
export async function verifyAnchorReceipt(
  receipt: AnchorReceipt,
  expectedCheckpointHash: string,
  reader: ChainReader | null,
): Promise<AnchorVerificationResult> {
  const problems: string[] = [];
  const checks: AnchorVerificationChecks = {
    inputDataMatchesCheckpoint: false,
    chainIdMatchesNetwork: false,
    statusConfirmed: false,
    chainTransactionFound: null,
    chainInputMatches: null,
    chainToMatches: null,
    receiptStatusSuccess: null,
    blockIncluded: null,
  };

  // --- Pure check 1: the on-chain payload is this checkpoint and nothing else.
  let expectedInput: string | null = null;
  try {
    expectedInput = anchorInputData(expectedCheckpointHash);
  } catch (error) {
    problems.push(
      `expected checkpoint hash is not a sha256 digest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (receipt.checkpointHash !== expectedCheckpointHash) {
    problems.push(
      `receipt commits to checkpoint ${receipt.checkpointHash}, expected ${expectedCheckpointHash}`,
    );
  }
  if (expectedInput !== null) {
    if (!sameHex(receipt.inputData, expectedInput)) {
      problems.push(
        `receipt inputData ${receipt.inputData} is not the 32-byte checkpoint digest ${expectedInput}`,
      );
    } else if (receipt.checkpointHash === expectedCheckpointHash) {
      checks.inputDataMatchesCheckpoint = true;
    }
  }

  // --- Pure check 2: declared network and chain id agree.
  const chainId = expectedChainId(receipt.network);
  checks.chainIdMatchesNetwork = receipt.chainId === chainId;
  if (!checks.chainIdMatchesNetwork) {
    problems.push(
      `receipt chainId ${receipt.chainId} does not match network ${receipt.network} (expected ${chainId})`,
    );
  }

  // --- Pure check 3: only a confirmed receipt counts as anchored.
  checks.statusConfirmed = receipt.status === 'confirmed';
  if (!checks.statusConfirmed) {
    problems.push(`receipt status is '${receipt.status}', not 'confirmed'`);
  }

  if (reader === null) {
    return { ok: problems.length === 0, checks, problems };
  }

  // --- Chain checks. A reader pointed at another chain proves nothing about
  // this receipt, so refuse rather than "verify" against the wrong chain.
  if (reader.chainId !== receipt.chainId) {
    problems.push(
      `chain reader is connected to chain ${reader.chainId} (${reader.network}), receipt anchors to chain ${receipt.chainId} (${receipt.network})`,
    );
    return { ok: false, checks, problems };
  }

  let transaction;
  try {
    transaction = await reader.getTransaction(receipt.transactionHash);
  } catch (error) {
    problems.push(
      `chain reader failed to fetch transaction ${receipt.transactionHash}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, checks, problems };
  }

  checks.chainTransactionFound = transaction !== null;
  if (transaction === null) {
    problems.push(
      `transaction ${receipt.transactionHash} does not exist on chain ${receipt.chainId}`,
    );
    return { ok: false, checks, problems };
  }

  checks.chainInputMatches =
    sameHex(transaction.input, receipt.inputData) &&
    (expectedInput === null || sameHex(transaction.input, expectedInput));
  if (!checks.chainInputMatches) {
    problems.push(
      `on-chain calldata ${transaction.input} does not match receipt inputData ${receipt.inputData}`,
    );
  }

  checks.chainToMatches = sameHex(transaction.to, receipt.to);
  if (!checks.chainToMatches) {
    problems.push(
      `on-chain destination ${String(transaction.to)} does not match receipt destination ${receipt.to}`,
    );
  }

  checks.blockIncluded =
    transaction.blockNumber !== null &&
    (receipt.blockNumber === null ||
      transaction.blockNumber === receipt.blockNumber) &&
    (receipt.blockHash === null ||
      sameHex(transaction.blockHash, receipt.blockHash));
  if (!checks.blockIncluded) {
    problems.push(
      `transaction ${receipt.transactionHash} is not included in the block the receipt claims ` +
        `(receipt block ${String(receipt.blockNumber)}, chain block ${String(transaction.blockNumber)})`,
    );
  }

  let chainReceipt;
  try {
    chainReceipt = await reader.getTransactionReceipt(receipt.transactionHash);
  } catch (error) {
    problems.push(
      `chain reader failed to fetch the receipt for ${receipt.transactionHash}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, checks, problems };
  }

  checks.receiptStatusSuccess = chainReceipt?.status === 'success';
  if (chainReceipt === null) {
    problems.push(
      `transaction ${receipt.transactionHash} has no chain receipt yet`,
    );
  } else if (!checks.receiptStatusSuccess) {
    problems.push(
      `on-chain transaction status is '${chainReceipt.status}', not 'success'`,
    );
  }

  return { ok: problems.length === 0, checks, problems };
}
