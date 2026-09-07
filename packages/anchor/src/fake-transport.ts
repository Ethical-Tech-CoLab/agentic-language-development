/**
 * Deterministic in-memory chain used by every anchoring test in the project
 * (and by the verifier's wrong-chain / false-anchor suites). No network, no
 * wallet, no funds — but the same {@link ChainTransport} contract as
 * {@link import('./viem-transport.js').ViemChainTransport}, so the publisher
 * and verifier under test are the production ones.
 *
 * Determinism: transaction hashes are `hashCanonical` over
 * `{nonce, inputData}` and block hashes over `{blockNumber}`, so the same
 * sequence of calls always yields the same identifiers.
 *
 * Fault injection:
 * - {@link FakeChainTransport.dropNext} — the next send throws a
 *   {@link TransientChainError} *before* recording anything, which is what
 *   makes "retry without duplicate submission" testable.
 * - {@link FakeChainTransport.failNext} — the next mined transaction lands
 *   with status `reverted`.
 * - {@link FakeChainTransport.setTransaction} — seed a foreign transaction
 *   (wrong calldata, wrong destination, reverted) for verifier tests.
 */
import { decodeHash, hashCanonical } from '@ald/hashing';

import { TransientChainError } from './errors.js';
import { ANCHOR_CHAIN_IDS, anchorInputData } from './transport.js';
import type {
  AnchorNetwork,
  AnchorTransactionInput,
  ChainTransaction,
  ChainTransactionReceipt,
  ChainTransport,
  SentAnchorTransaction,
} from './transport.js';

const FAKE_TX_DOMAIN = 'ald-fake-chain-transaction-v1';
const FAKE_BLOCK_DOMAIN = 'ald-fake-chain-block-v1';

/** Fixed sender of every fake anchor transaction unless `from` is given. */
export const DEFAULT_FAKE_FROM_ADDRESS = `0x${'a11ce'.padEnd(40, '0')}`;

export interface FakeChainTransportOptions {
  chainId?: number;
  network?: AnchorNetwork;
  endpointLabel?: string;
  /** Sender address reported by `sendAnchorTransaction`. */
  from?: string;
}

function evmHash(domain: string, value: unknown): string {
  return `0x${decodeHash(hashCanonical(domain, value)).toString('hex')}`;
}

export class FakeChainTransport implements ChainTransport {
  readonly chainId: number;
  readonly network: AnchorNetwork;
  readonly endpointLabel: string;
  readonly from: string;

  private nonce = 0;
  private blockHeight = 0;
  private attempts = 0;
  private revertNextCount = 0;
  private dropNextCount = 0;
  private calls = 0;

  private readonly pendingHashes: string[] = [];
  private readonly transactions = new Map<string, ChainTransaction>();
  private readonly receipts = new Map<string, ChainTransactionReceipt>();
  private readonly sent: SentAnchorTransaction[] = [];

  constructor(options: FakeChainTransportOptions = {}) {
    this.network = options.network ?? 'base-sepolia';
    this.chainId = options.chainId ?? ANCHOR_CHAIN_IDS[this.network];
    this.endpointLabel = options.endpointLabel ?? `fake-${this.network}`;
    this.from = options.from ?? DEFAULT_FAKE_FROM_ADDRESS;
  }

  // -------------------------------------------------------------------------
  // Test observation
  // -------------------------------------------------------------------------

  /** Sends that were *attempted*, including the ones `dropNext` failed. */
  get sendAttempts(): number {
    return this.attempts;
  }

  /** Transactions actually submitted; must stay 1 across a retried submit. */
  get submissions(): readonly SentAnchorTransaction[] {
    return this.sent;
  }

  /**
   * Every RPC-shaped call this transport received. ALD-022 asserts this stays
   * at 0 for a mainnet transport under default configuration.
   */
  get rpcCalls(): number {
    return this.calls;
  }

  get blockNumber(): number {
    return this.blockHeight;
  }

  // -------------------------------------------------------------------------
  // Fault injection and seeding
  // -------------------------------------------------------------------------

  /** The next `count` mined transactions land with status `reverted`. */
  failNext(count = 1): this {
    this.revertNextCount += count;
    return this;
  }

  /** The next `count` sends throw before submitting anything. */
  dropNext(count = 1): this {
    this.dropNextCount += count;
    return this;
  }

  /** Seed an arbitrary transaction (and optional receipt) into the chain. */
  setTransaction(
    transaction: ChainTransaction,
    receipt: ChainTransactionReceipt | null = null,
  ): this {
    this.transactions.set(transaction.hash.toLowerCase(), transaction);
    if (receipt === null) {
      this.receipts.delete(transaction.hash.toLowerCase());
    } else {
      this.receipts.set(transaction.hash.toLowerCase(), receipt);
    }
    return this;
  }

  /**
   * Include every pending transaction in the next block, then advance the
   * head by `count` blocks in total (later blocks are empty).
   */
  mineBlock(count = 1): number {
    for (let index = 0; index < count; index += 1) {
      this.blockHeight += 1;
      const blockNumber = this.blockHeight;
      const blockHash = evmHash(FAKE_BLOCK_DOMAIN, { blockNumber });
      const included = this.pendingHashes.splice(0);
      for (const hash of included) {
        const transaction = this.transactions.get(hash);
        if (transaction === undefined) {
          continue;
        }
        this.transactions.set(hash, { ...transaction, blockNumber, blockHash });
        const reverted = this.revertNextCount > 0;
        if (reverted) {
          this.revertNextCount -= 1;
        }
        this.receipts.set(hash, {
          status: reverted ? 'reverted' : 'success',
          blockNumber,
          blockHash,
        });
      }
    }
    return this.blockHeight;
  }

  // -------------------------------------------------------------------------
  // ChainTransport
  // -------------------------------------------------------------------------

  async sendAnchorTransaction(
    input: AnchorTransactionInput,
  ): Promise<SentAnchorTransaction> {
    this.calls += 1;
    this.attempts += 1;
    if (this.dropNextCount > 0) {
      this.dropNextCount -= 1;
      throw new TransientChainError(
        `fake ${this.network} RPC dropped the request (injected)`,
      );
    }

    const inputData = anchorInputData(input.checkpointHash);
    this.nonce += 1;
    const transactionHash = evmHash(FAKE_TX_DOMAIN, {
      nonce: this.nonce,
      inputData,
    });

    this.transactions.set(transactionHash.toLowerCase(), {
      hash: transactionHash,
      from: this.from,
      to: input.to,
      input: inputData,
      blockNumber: null,
      blockHash: null,
    });
    this.pendingHashes.push(transactionHash.toLowerCase());

    const submission: SentAnchorTransaction = {
      transactionHash,
      from: this.from,
      to: input.to,
      inputData,
    };
    this.sent.push(submission);
    return submission;
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<ChainTransactionReceipt | null> {
    this.calls += 1;
    return this.receipts.get(transactionHash.toLowerCase()) ?? null;
  }

  async latestBlockNumber(): Promise<number> {
    this.calls += 1;
    return this.blockHeight;
  }

  async getTransaction(
    transactionHash: string,
  ): Promise<ChainTransaction | null> {
    this.calls += 1;
    return this.transactions.get(transactionHash.toLowerCase()) ?? null;
  }
}
