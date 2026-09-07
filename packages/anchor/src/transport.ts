/**
 * The chain boundary of the anchoring subsystem.
 *
 * Everything above this interface is provider-agnostic (SPEC §19 ADR-01: the
 * RPC vendor is an operational choice, and the Verifier MUST work against any
 * provider that can confirm a chain id, return calldata, and report block
 * numbers). `ChainTransport` is the write+read half used by the publisher;
 * `ChainReader` is the strictly read-only half the independent verifier needs
 * (ALD-021) and is deliberately a `Pick<>` so a transport is always a valid
 * reader.
 *
 * The anchored payload is the bare 32-byte checkpoint digest and nothing else
 * (LEDGER-INTEGRITY-DESIGN.md §12: "Only checkpoint hashes are written
 * on-chain"). {@link anchorInputData} is the single place that encoding is
 * produced, and both the publisher and the verifier compare against it.
 */
import { decodeHash, isSha256Hash } from '@ald/hashing';
import type { AnchorReceipt } from '@ald/types';

/** The two Base networks this project anchors to (SPEC §13.4). */
export type AnchorNetwork = AnchorReceipt['network'];

/** Chain ids fixed by Base itself; never configurable. */
export const ANCHOR_CHAIN_IDS: Readonly<Record<AnchorNetwork, number>> =
  Object.freeze({
    'base-sepolia': 84532,
    'base-mainnet': 8453,
  });

/** Number of hex characters in a 32-byte payload plus the `0x` prefix. */
export const ANCHOR_INPUT_DATA_LENGTH = 66;

/**
 * LEDGER §10/§12 anchor payload: `0x` followed by the raw 32 bytes of the
 * checkpoint digest, lowercase hex, exactly 66 characters. No selector, no
 * ABI encoding, no run identifier, no content — a third party can therefore
 * compare calldata to a locally recomputed checkpoint hash byte for byte.
 */
export function anchorInputData(checkpointHash: string): string {
  if (!isSha256Hash(checkpointHash)) {
    throw new TypeError(
      `Checkpoint hash must be sha256:<64 hex>, got ${String(checkpointHash).slice(0, 80)}`,
    );
  }
  return `0x${decodeHash(checkpointHash).toString('hex')}`;
}

export interface AnchorTransactionInput {
  /** `sha256:<hex>` checkpoint digest to commit on chain. */
  checkpointHash: string;
  /** Destination address of the zero-value anchor transaction. */
  to: string;
}

export interface SentAnchorTransaction {
  transactionHash: string;
  from: string;
  to: string;
  /** MUST equal {@link anchorInputData} of the submitted checkpoint hash. */
  inputData: string;
}

export interface ChainTransactionReceipt {
  status: 'success' | 'reverted';
  blockNumber: number;
  blockHash: string;
}

export interface ChainTransaction {
  hash: string;
  from: string;
  /** `null` only for contract-creation transactions. */
  to: string | null;
  input: string;
  blockNumber: number | null;
  blockHash: string | null;
}

/**
 * Write+read chain access used by {@link import('./publisher.js').BaseAnchorPublisher}.
 *
 * Implementations must throw {@link import('./errors.js').TransientChainError}
 * (or any error) from `sendAnchorTransaction` only when nothing was submitted:
 * the publisher treats a throw as "safe to retry" and a returned hash as
 * "submitted exactly once". An implementation that can lose the *response* to
 * a broadcast (any HTTP transport) therefore has to sign at a pinned nonce and
 * reconcile against the chain before reporting a failure — see
 * `ViemChainTransport` — so that a retry replaces the same transaction instead
 * of paying for a second one (LEDGER §16 Phase 2: "retry and nonce
 * management").
 *
 * Error messages crossing this boundary must be secret-free: `endpointLabel`,
 * the RPC method, and the provider's error name/code, never the RPC URL, its
 * userinfo, or its query (LEDGER §11).
 */
export interface ChainTransport {
  readonly chainId: number;
  readonly network: AnchorNetwork;
  /** Human-readable, secret-free RPC label recorded in the receipt. */
  readonly endpointLabel: string;
  sendAnchorTransaction(
    input: AnchorTransactionInput,
  ): Promise<SentAnchorTransaction>;
  getTransactionReceipt(
    transactionHash: string,
  ): Promise<ChainTransactionReceipt | null>;
  latestBlockNumber(): Promise<number>;
  getTransaction(transactionHash: string): Promise<ChainTransaction | null>;
}

/**
 * The read-only slice an independently configured verifier RPC needs
 * (ALD-021): chain identity plus transaction, receipt, and head lookups.
 */
export type ChainReader = Pick<
  ChainTransport,
  | 'chainId'
  | 'network'
  | 'getTransaction'
  | 'getTransactionReceipt'
  | 'latestBlockNumber'
>;
