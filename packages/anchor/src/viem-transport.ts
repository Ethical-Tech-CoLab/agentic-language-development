/**
 * ALD-020 — the real Base transport, built on viem (SPEC §19 ADR-01: any
 * provider that can confirm a chain id, return calldata, and report blocks
 * is acceptable; nothing above this class knows which one is configured).
 *
 * The transaction is the LEDGER §10 "simplest viable anchor": zero value,
 * from the dedicated anchor wallet, to a designated project address, with the
 * 32-byte checkpoint digest as calldata.
 *
 * Two hazards this class exists to contain:
 *
 * 1. **Nonce management** (LEDGER §16 Phase 2: "retry and nonce management").
 *    The publisher retries a send that *threw*, so a send must be idempotent.
 *    Each logical submission (one destination + one checkpoint digest) is
 *    signed exactly once, at a nonce read once from the pending pool, and
 *    cached: a retry re-broadcasts the identical signed bytes, which the chain
 *    can only accept as the same transaction — never as a second paid one.
 *    Because the hash is derived locally from those bytes, a send whose HTTP
 *    response is lost can still be reconciled: before reporting a failure the
 *    transport asks the chain whether that transaction already exists.
 * 2. **Credential leakage** (LEDGER §11). The private key is passed to
 *    `privateKeyToAccount` and then only lives inside viem's local account;
 *    this class stores no key field and its `toJSON` returns just the public
 *    chain identity. viem's own error messages, however, print the full RPC
 *    URL — which for most providers carries an API key in its path or query —
 *    so every provider failure is re-wrapped as a {@link TransientChainError}
 *    whose message carries only the secret-free endpoint label, the RPC
 *    method, and the provider's own error name/code. The original error is not
 *    attached as `cause`, because inspecting a cause chain would re-expose it.
 */
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  http,
  keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { Chain, Hex, HttpTransport, PrivateKeyAccount, PublicClient } from 'viem';

import { AnchorNetworkMismatchError, TransientChainError } from './errors.js';
import { ANCHOR_CHAIN_IDS, anchorInputData } from './transport.js';
import type {
  AnchorNetwork,
  AnchorTransactionInput,
  ChainTransaction,
  ChainTransactionReceipt,
  ChainTransport,
  SentAnchorTransaction,
} from './transport.js';

const CHAINS: Readonly<Record<AnchorNetwork, Chain>> = Object.freeze({
  'base-sepolia': baseSepolia,
  'base-mainnet': base,
});

/** How far up a `cause` chain the error classifiers look. */
const MAX_CAUSE_DEPTH = 8;

/** Provider error codes worth keeping: numbers, or `ECONNREFUSED`-style. */
const SAFE_STRING_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;

export interface ViemChainTransportOptions {
  rpcUrl: string;
  /** `0x` + 64 hex secp256k1 anchor wallet key. Never logged. */
  privateKey: string;
  network: AnchorNetwork;
  /**
   * Secret-free label recorded in every receipt. Defaults to the RPC host so
   * an API key embedded in the URL path or query is never persisted.
   */
  endpointLabel?: string;
  /**
   * HTTP-level retries viem performs *inside* one logical call. Defaults to
   * viem's own default; the publisher's send-retry budget (SPEC §13.4) sits
   * above this and is configured separately. Retries are safe here because a
   * logical submission is signed once and re-broadcast byte-identically.
   */
  retryCount?: number;
}

/** One logical submission: signed once, re-broadcast as-is on every retry. */
interface PinnedSubmission {
  nonce: number;
  serializedTransaction: Hex;
  transactionHash: Hex;
}

/**
 * Host only, so userinfo (`https://user:key@host/...`), the path, and the
 * query — all common places to carry an API key — are dropped.
 */
function labelFor(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'rpc';
  }
}

/** Walk `error` and its causes, bounded, so a cycle cannot spin. */
function* causeChain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null) {
      return;
    }
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * `null`-not-`throw` classification, by viem's error *classes* only.
 *
 * Never by message substring: a provider that answers "API key could not be
 * found" (or an HTTP 404 body) would otherwise be reported to the verifier as
 * the affirmative chain fact "this transaction does not exist".
 */
function isNotFound(error: unknown): boolean {
  for (const link of causeChain(error)) {
    if (
      link instanceof TransactionNotFoundError ||
      link instanceof TransactionReceiptNotFoundError
    ) {
      return true;
    }
  }
  return false;
}

/** First safe provider code found on the error chain, if any. */
function providerCode(error: unknown): string | undefined {
  for (const link of causeChain(error)) {
    const code: unknown = (link as { code?: unknown }).code;
    if (typeof code === 'number' && Number.isFinite(code)) {
      return String(code);
    }
    if (typeof code === 'string' && SAFE_STRING_CODE.test(code)) {
      return code;
    }
    const status: unknown = (link as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return `HTTP ${String(status)}`;
    }
  }
  return undefined;
}

/**
 * Redacted description of a provider failure: the error's class name plus its
 * numeric/symbolic code, and nothing the provider wrote as free text.
 */
function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = providerCode(error);
  return code === undefined ? name : `${name}, ${code}`;
}

export class ViemChainTransport implements ChainTransport {
  readonly chainId: number;
  readonly network: AnchorNetwork;
  readonly endpointLabel: string;
  /** Anchor wallet address; the public half of the key (LEDGER §11). */
  readonly address: Hex;

  /** One pinned submission per `(destination, calldata)` — see the header. */
  private readonly pinned = new Map<string, Promise<PinnedSubmission>>();

  private constructor(
    private readonly publicClient: PublicClient<HttpTransport, Chain>,
    private readonly account: PrivateKeyAccount,
    private readonly chain: Chain,
    network: AnchorNetwork,
    endpointLabel: string,
  ) {
    this.network = network;
    this.chainId = chain.id;
    this.endpointLabel = endpointLabel;
    this.address = account.address;
  }

  static create(options: ViemChainTransportOptions): ViemChainTransport {
    const chain = CHAINS[options.network];
    if (chain.id !== ANCHOR_CHAIN_IDS[options.network]) {
      throw new AnchorNetworkMismatchError(
        options.network,
        chain.id,
        ANCHOR_CHAIN_IDS[options.network],
      );
    }

    const account = privateKeyToAccount(options.privateKey as Hex);
    const publicClient = createPublicClient({
      chain,
      transport: http(
        options.rpcUrl,
        options.retryCount === undefined
          ? {}
          : { retryCount: options.retryCount },
      ),
    });

    return new ViemChainTransport(
      publicClient,
      account,
      chain,
      options.network,
      options.endpointLabel ?? labelFor(options.rpcUrl),
    );
  }

  /** Public identity only — deliberately excludes any key material. */
  toJSON(): {
    network: AnchorNetwork;
    chainId: number;
    endpointLabel: string;
    address: string;
  } {
    return {
      network: this.network,
      chainId: this.chainId,
      endpointLabel: this.endpointLabel,
      address: this.address,
    };
  }

  /**
   * Broadcast the anchor transaction for `input`, or report the submission
   * that already exists for it.
   *
   * The publisher's contract (see `transport.ts`) is that a throw means
   * nothing was submitted. This method keeps that true even when a send fails
   * *after* the node accepted the bytes: the transaction is signed at a pinned
   * nonce, so its hash is known locally, and a failed send is only reported as
   * a failure once the chain says no such transaction exists.
   */
  async sendAnchorTransaction(
    input: AnchorTransactionInput,
  ): Promise<SentAnchorTransaction> {
    const inputData = anchorInputData(input.checkpointHash);
    const submission = await this.pinnedSubmission(inputData, input.to);

    try {
      await this.publicClient.sendRawTransaction({
        serializedTransaction: submission.serializedTransaction,
      });
    } catch (error) {
      if (!(await this.transactionExists(submission.transactionHash))) {
        throw this.transient('eth_sendRawTransaction', error);
      }
    }

    return {
      transactionHash: submission.transactionHash,
      from: this.address,
      to: input.to,
      inputData,
    };
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<ChainTransactionReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: transactionHash as Hex,
      });
      return {
        status: receipt.status === 'success' ? 'success' : 'reverted',
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.transient('eth_getTransactionReceipt', error);
    }
  }

  async latestBlockNumber(): Promise<number> {
    try {
      return Number(await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    } catch (error) {
      throw this.transient('eth_blockNumber', error);
    }
  }

  async getTransaction(
    transactionHash: string,
  ): Promise<ChainTransaction | null> {
    try {
      const transaction = await this.publicClient.getTransaction({
        hash: transactionHash as Hex,
      });
      return {
        hash: transaction.hash,
        from: transaction.from,
        to: transaction.to ?? null,
        input: transaction.input,
        blockNumber:
          transaction.blockNumber === null
            ? null
            : Number(transaction.blockNumber),
        blockHash: transaction.blockHash ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.transient('eth_getTransactionByHash', error);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Every provider failure leaves this class as a redacted
   * {@link TransientChainError}: endpoint label + RPC method + the provider's
   * own error name and code, with no URL, no userinfo, no query string, and no
   * `cause` to inspect (LEDGER §11).
   */
  private transient(method: string, error: unknown): TransientChainError {
    return new TransientChainError(
      `${this.endpointLabel} ${method} failed (${describeFailure(error)})`,
    );
  }

  private async call<T>(method: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.transient(method, error);
    }
  }

  /** True only when the chain affirmatively knows the transaction. */
  private async transactionExists(transactionHash: Hex): Promise<boolean> {
    try {
      return (await this.getTransaction(transactionHash)) !== null;
    } catch {
      // The reconciliation lookup itself failed; the caller reports the send
      // failure, which the publisher retries with these same pinned bytes.
      return false;
    }
  }

  /**
   * The signed transaction for this `(destination, calldata)` pair, signed at
   * most once. A concurrent or retried send awaits the same promise, so one
   * logical submission can never occupy two nonces.
   */
  private async pinnedSubmission(
    inputData: string,
    to: string,
  ): Promise<PinnedSubmission> {
    const key = `${to.toLowerCase()}:${inputData.toLowerCase()}`;
    const started = this.pinned.get(key);
    if (started !== undefined) {
      return await started;
    }

    const signing = this.signAnchorTransaction(inputData, to);
    this.pinned.set(key, signing);
    try {
      return await signing;
    } catch (error) {
      // Nothing was broadcast, so the nonce is not spoken for: let the next
      // attempt read a fresh one instead of caching the failure.
      this.pinned.delete(key);
      throw error;
    }
  }

  /**
   * Read the pending nonce and the fee parameters once, then sign locally.
   * Every RPC call here happens strictly before any broadcast, so wrapping
   * their failures as transient keeps the publisher's retry contract honest.
   */
  private async signAnchorTransaction(
    inputData: string,
    to: string,
  ): Promise<PinnedSubmission> {
    const nonce = await this.call('eth_getTransactionCount', async () =>
      this.publicClient.getTransactionCount({
        address: this.address,
        blockTag: 'pending',
      }),
    );
    const fees = await this.call('eth_maxPriorityFeePerGas', async () =>
      this.publicClient.estimateFeesPerGas(),
    );
    const gas = await this.call('eth_estimateGas', async () =>
      this.publicClient.estimateGas({
        // The *address*, not the local account: a local account would make
        // viem prepare (and re-read the nonce for) the request it is only
        // being asked to price.
        account: this.address,
        to: to as Hex,
        value: 0n,
        data: inputData as Hex,
      }),
    );

    const serializedTransaction = await this.call(
      'sign-transaction',
      async () =>
        this.account.signTransaction({
          chainId: this.chain.id,
          to: to as Hex,
          value: 0n,
          data: inputData as Hex,
          nonce,
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          type: 'eip1559',
        }),
    );

    return {
      nonce,
      serializedTransaction,
      transactionHash: keccak256(serializedTransaction),
    };
  }
}
