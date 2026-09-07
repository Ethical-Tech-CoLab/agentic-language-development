/**
 * Minimal JSON-RPC {@link ChainReader} for the CLI's `--rpc-url` flag.
 *
 * LEDGER-INTEGRITY-DESIGN.md §14 step 10 requires the anchoring transaction
 * to be retrieved from an *independent* provider, so this reader speaks plain
 * `eth_chainId` / `eth_getTransactionByHash` / `eth_getTransactionReceipt`
 * over `fetch` and deliberately shares no code, wallet, or client library
 * with the publisher in `@ald/anchor`.
 */
import type {
  ChainReader,
  ChainTransaction,
  ChainTransactionReceipt,
} from './anchors.js';

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hexToNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/iu.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asHexString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface JsonRpcChainReaderOptions {
  /** Skip the `eth_chainId` round trip and trust this value (`--chain-id`). */
  chainId?: number | undefined;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

async function call(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(
      `${method} failed: HTTP ${String(response.status)} from ${url}`,
    );
  }
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(`${method} failed: ${body.error.message ?? 'RPC error'}`);
  }
  return body.result ?? null;
}

/**
 * Connects to `url`, resolving the chain id up front so the returned reader
 * can expose it synchronously for the `anchorChainIdMatches` check.
 */
export async function createJsonRpcChainReader(
  url: string,
  options: JsonRpcChainReaderOptions = {},
): Promise<ChainReader> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let chainId = options.chainId;
  if (chainId === undefined) {
    const raw = await call(url, 'eth_chainId', [], fetchImpl);
    const parsed = hexToNumber(raw);
    if (parsed === null) {
      throw new Error(`eth_chainId returned an unusable value: ${String(raw)}`);
    }
    chainId = parsed;
  }

  return {
    chainId,
    async getTransaction(
      transactionHash: string,
    ): Promise<ChainTransaction | null> {
      const raw = asRecord(
        await call(url, 'eth_getTransactionByHash', [transactionHash], fetchImpl),
      );
      if (raw === undefined) {
        return null;
      }
      return {
        to: asHexString(raw['to']),
        input: asHexString(raw['input']) ?? '',
        blockNumber: hexToNumber(raw['blockNumber']),
        blockHash: asHexString(raw['blockHash']),
      };
    },
    async getTransactionReceipt(
      transactionHash: string,
    ): Promise<ChainTransactionReceipt | null> {
      const raw = asRecord(
        await call(url, 'eth_getTransactionReceipt', [transactionHash], fetchImpl),
      );
      if (raw === undefined) {
        return null;
      }
      const blockNumber = hexToNumber(raw['blockNumber']);
      if (blockNumber === null) {
        return null;
      }
      return {
        status: raw['status'] === '0x1' ? 'success' : 'reverted',
        blockNumber,
        blockHash: asHexString(raw['blockHash']) ?? '',
      };
    },
  };
}
