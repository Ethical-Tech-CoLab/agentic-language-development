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
 *
 * `anchorTxConfirmed` stays receipt-derived in the offline mode: bundle
 * format §8 states chain retrieval "is performed only when an independent RPC
 * URL is supplied", so the on-chain rule does not apply when none was, and
 * SPEC §11.10 fixes the thirteen report booleans. What §8 does require is that
 * the report record whether the check ran, which is why every run emits either
 * {@link CHAIN_NOT_CHECKED_CODE} or its `anchor-chain-checked` counterpart
 * into `gaps` — the only channel the fixed report shape leaves open.
 */
import { decodeHash } from '@ald/hashing';
import { AnchorReceiptSchema, type AnchorReceipt, type RunConfig } from '@ald/types';

import {
  bundlePath,
  formatIssues,
  readCanonicalJsonFile,
  unknownFieldDetail,
} from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedCheckpoint } from './checkpoints.js';
import { describeRedacted, redactUrls } from './redact.js';

/** LEDGER §10: the two networks a run may anchor to, and their chain ids. */
export const NETWORK_CHAIN_IDS: Record<AnchorReceipt['network'], number> = {
  'base-sepolia': 84_532,
  'base-mainnet': 8_453,
};

/**
 * Interim confirmation depth of the `safe-tag` policy (SPEC §13.4, §19
 * ADR-05), in Base blocks: Base's `safe` tag tracks the L1 justified
 * checkpoint one Ethereum epoch behind (32 slots x 12 s = 384 s) and Base
 * produces a block every 2 s, so one epoch is 384 / 2 = 192 Base blocks.
 *
 * Mirrors `SAFE_TAG_CONFIRMATION_PROXY` in packages/anchor/src/publisher.ts.
 * The value is duplicated rather than imported so the verifier keeps sharing
 * no code with the publisher (LEDGER §14 step 10); a verifier depth shallower
 * than the publisher's would accept as `safe-tag`-final a receipt the
 * publisher would still be polling.
 */
export const SAFE_TAG_CONFIRMATION_PROXY = 192;

const NUMBERED_CONFIRMATIONS = /^(\d+)-confirmations$/u;

/**
 * Confirmation depth a receipt must reach before it may be reported as
 * `confirmed` (SPEC §13.4), parsed exactly as the publisher parses it.
 * Returns `undefined` for a policy string neither side can interpret.
 */
export function requiredConfirmations(policy: string): number | undefined {
  if (policy === '1-confirmation') {
    return 1;
  }
  if (policy === 'safe-tag') {
    return SAFE_TAG_CONFIRMATION_PROXY;
  }
  const match = NUMBERED_CONFIRMATIONS.exec(policy);
  const digits = match?.[1];
  if (digits !== undefined) {
    const depth = Number.parseInt(digits, 10);
    if (Number.isSafeInteger(depth) && depth > 0) {
      return depth;
    }
  }
  return undefined;
}

/**
 * Gap recorded whenever LEDGER §14 steps 10-11 did not run, so a published
 * `verification-report.json` can never be mistaken for one whose anchor was
 * corroborated by an independent provider (bundle format §8: "the report
 * records whether that check ran").
 */
export const CHAIN_NOT_CHECKED_CODE = 'anchor-chain-not-checked';

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
  /** Secret-free label of the endpoint, recorded in the report. */
  readonly endpointLabel?: string | undefined;
}

export interface AnchorVerificationInput {
  bundleDir: string;
  checkpoints: readonly LoadedCheckpoint[];
  accumulator: VerificationAccumulator;
  chainReader?: ChainReader | undefined;
  /**
   * The hash-bound run configuration (bundle format §7). It is the only
   * authenticated statement of which chain and finality policy the run
   * declared, so the receipts are compared with it rather than only with
   * themselves (LEDGER §14 step 11, §17 "anchor transaction on the wrong
   * chain").
   */
  config?: RunConfig | undefined;
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
  const { accumulator, checkpoints, chainReader, config, allowUnanchored } = input;
  const path = bundlePath(input.bundleDir, 'anchors', 'base-receipts.json');
  const raw = await readCanonicalJsonFile(path);
  const result: AnchorVerificationResult = {
    receipts: [],
    anchoredThroughCheckpoint: null,
    chainChecked: chainReader !== undefined,
  };

  // Bundle format §8: the report must record whether chain retrieval ran.
  // `VerificationReportSchema` (SPEC §11.10) is a fixed shape, so the
  // conformant channel is a `gaps` line — informational, never escalating,
  // because the offline mode is the documented default (SPEC §4.2).
  if (chainReader === undefined) {
    accumulator.gap(
      CHAIN_NOT_CHECKED_CODE,
      'no independent RPC endpoint was supplied; anchor confirmation is taken from the bundle\'s own receipts (LEDGER §14 steps 10-11 did not run)',
    );
  } else {
    // The label is documented as secret-free, but it comes from the caller and
    // lands in a published artifact, so it is redacted here as well.
    accumulator.gap(
      'anchor-chain-checked',
      `anchor receipts were corroborated against an independent endpoint (chainId ${String(chainReader.chainId)}${
        chainReader.endpointLabel === undefined
          ? ''
          : `, ${redactUrls(chainReader.endpointLabel)}`
      })`,
    );
  }

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
    const at = `anchors/base-receipts.json[${String(index)}]`;
    const parsed = AnchorReceiptSchema.safeParse(entry);
    if (!parsed.success) {
      accumulator.failStructural(
        'schema-invalid',
        `${at}: ${formatIssues(parsed.error.issues)}`,
      );
      return;
    }
    const unknownFields = unknownFieldDetail(entry, parsed.data);
    if (unknownFields !== undefined) {
      accumulator.failStructural('receipt-unknown-field', `${at}: ${unknownFields}`);
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
    if (config !== undefined) {
      // LEDGER §17 "anchor transaction on the wrong chain": the run's
      // authenticated configuration, not the receipt itself, says which
      // network the run anchors to.
      if (receipt.network !== config.anchorNetwork) {
        accumulator.fail(
          'anchorChainIdMatches',
          'anchor-network-mismatch',
          `${at}: run-config.json declares anchorNetwork ${config.anchorNetwork}, receipt claims ${receipt.network}`,
        );
      } else if (receipt.chainId !== NETWORK_CHAIN_IDS[config.anchorNetwork]) {
        accumulator.fail(
          'anchorChainIdMatches',
          'anchor-chain-id-mismatch',
          `${at}: run-config.json declares anchorNetwork ${config.anchorNetwork} (chainId ${String(NETWORK_CHAIN_IDS[config.anchorNetwork])}), receipt claims ${String(receipt.chainId)}`,
        );
      }
      // SPEC §13.4: the declared finality policy and the depth it implies.
      if (receipt.finalityPolicy !== config.finalityPolicy) {
        accumulator.failStructural(
          'anchor-finality-policy-mismatch',
          `${at}: run-config.json declares finalityPolicy ${config.finalityPolicy}, receipt claims ${receipt.finalityPolicy}`,
        );
      }
      const depth = requiredConfirmations(config.finalityPolicy);
      if (depth === undefined) {
        accumulator.gap(
          'anchor-finality-policy-unknown',
          `${at}: finalityPolicy ${config.finalityPolicy} declares no confirmation depth this verifier can check`,
        );
      } else if (
        receipt.status === 'confirmed' &&
        receipt.confirmations < depth
      ) {
        accumulator.fail(
          'anchorTxConfirmed',
          'anchor-confirmations-insufficient',
          `${at}: ${String(receipt.confirmations)} confirmations do not satisfy ${config.finalityPolicy} (${String(depth)} required)`,
          { escalate: !allowUnanchored },
        );
      }
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
    // A managed endpoint carries its API key in the URL, and gaps are
    // published with the bundle, so nothing beyond the origin may be recorded.
    fail('anchor-rpc-error', describeRedacted(error));
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
