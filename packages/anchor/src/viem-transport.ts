/**
 * ALD-020 — the real Base transport, built on viem (SPEC §19 ADR-01: any
 * provider that can confirm a chain id, return calldata, and report blocks
 * is acceptable; nothing above this class knows which one is configured).
 *
 * The transaction is the LEDGER §10 "simplest viable anchor": zero value,
 * from the dedicated anchor wallet, to a designated project address, with the
 * 32-byte checkpoint digest as calldata.
 *
 * Key hygiene (LEDGER §11): the private key is passed to
 * `privateKeyToAccount` and then only lives inside viem's local account. This
 * class stores no key field, exposes only the derived address, and its
 * `toJSON` returns just the public chain identity so that logging or
 * serializing a transport can never leak the wallet key.
 */
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { Chain, Hex, PublicClient, WalletClient } from 'viem';

import { AnchorNetworkMismatchError } from './errors.js';
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
}

function labelFor(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'rpc';
  }
}

export class ViemChainTransport implements ChainTransport {
  readonly chainId: number;
  readonly network: AnchorNetwork;
  readonly endpointLabel: string;
  /** Anchor wallet address; the public half of the key (LEDGER §11). */
  readonly address: Hex;

  private constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly chain: Chain,
    network: AnchorNetwork,
    endpointLabel: string,
    address: Hex,
  ) {
    this.network = network;
    this.chainId = chain.id;
    this.endpointLabel = endpointLabel;
    this.address = address;
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
    const transport = http(options.rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    return new ViemChainTransport(
      publicClient,
      walletClient,
      chain,
      options.network,
      options.endpointLabel ?? labelFor(options.rpcUrl),
      account.address,
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

  async sendAnchorTransaction(
    input: AnchorTransactionInput,
  ): Promise<SentAnchorTransaction> {
    const inputData = anchorInputData(input.checkpointHash);
    const account = this.walletClient.account;
    if (account === undefined) {
      throw new TypeError('Wallet client has no account');
    }
    const transactionHash = await this.walletClient.sendTransaction({
      account,
      chain: this.chain,
      to: input.to as Hex,
      value: 0n,
      data: inputData as Hex,
    });
    return {
      transactionHash,
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
      throw error;
    }
  }

  async latestBlockNumber(): Promise<number> {
    return Number(await this.publicClient.getBlockNumber({ cacheTime: 0 }));
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
      throw error;
    }
  }
}

/**
 * viem throws `TransactionNotFoundError` / `TransactionReceiptNotFoundError`
 * where this contract wants `null`; both are matched by name so no viem
 * error class has to be imported at runtime.
 */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'TransactionNotFoundError' ||
    error.name === 'TransactionReceiptNotFoundError' ||
    /could not be found/iu.test(error.message)
  );
}
