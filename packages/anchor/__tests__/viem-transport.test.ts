/**
 * ALD-020 — `ViemChainTransport` against a minimal in-process JSON-RPC
 * server. No real network, no funded wallet: the server answers exactly the
 * methods viem's `sendTransaction` flow needs, which is enough to prove the
 * calldata really is the bare checkpoint digest, that the mappings for
 * `getTransaction` / `getTransactionReceipt` / `latestBlockNumber` are
 * correct, and that the private key never appears in anything the transport
 * returns (LEDGER §11).
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodeHash } from '@ald/hashing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ViemChainTransport,
  anchorInputData,
  generateAnchorKey,
} from '../src/index.js';

const CHECKPOINT_HASH = `sha256:${'3f'.repeat(32)}`;
const DIGEST_HEX = decodeHash(CHECKPOINT_HASH).toString('hex');
const TX_HASH = `0x${'7a'.repeat(32)}`;
const BLOCK_HASH = `0x${'b1'.repeat(32)}`;
const DESTINATION = `0x${'d0'.repeat(20)}`;

const anchorKey = generateAnchorKey();

/** Methods the fake node saw, and the raw transactions it was handed. */
const seen: string[] = [];
const rawTransactions: string[] = [];

let server: Server;
let rpcUrl: string;

function resultFor(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x14a34';
    case 'eth_blockNumber':
      return '0x11';
    case 'eth_getBlockByNumber':
      return {
        number: '0x11',
        hash: BLOCK_HASH,
        parentHash: `0x${'00'.repeat(32)}`,
        nonce: '0x0000000000000000',
        sha3Uncles: `0x${'00'.repeat(32)}`,
        logsBloom: `0x${'00'.repeat(256)}`,
        transactionsRoot: `0x${'00'.repeat(32)}`,
        stateRoot: `0x${'00'.repeat(32)}`,
        receiptsRoot: `0x${'00'.repeat(32)}`,
        miner: `0x${'11'.repeat(20)}`,
        difficulty: '0x0',
        totalDifficulty: '0x0',
        extraData: '0x',
        size: '0x100',
        gasLimit: '0x1c9c380',
        gasUsed: '0x5208',
        timestamp: '0x65000000',
        baseFeePerGas: '0x7',
        transactions: [],
        uncles: [],
      };
    case 'eth_maxPriorityFeePerGas':
      return '0x5f5e100';
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_estimateGas':
      return '0x5208';
    case 'eth_getTransactionCount':
      return '0x0';
    case 'eth_sendRawTransaction': {
      const raw = params[0];
      if (typeof raw === 'string') {
        rawTransactions.push(raw);
      }
      return TX_HASH;
    }
    case 'eth_getTransactionByHash': {
      if (params[0] !== TX_HASH) {
        return null;
      }
      return {
        hash: TX_HASH,
        nonce: '0x0',
        blockHash: BLOCK_HASH,
        blockNumber: '0x11',
        transactionIndex: '0x0',
        from: anchorKey.address,
        to: DESTINATION,
        value: '0x0',
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
        maxFeePerGas: '0x3b9aca00',
        maxPriorityFeePerGas: '0x5f5e100',
        input: `0x${DIGEST_HEX}`,
        type: '0x2',
        chainId: '0x14a34',
        v: '0x1',
        r: `0x${'01'.repeat(32)}`,
        s: `0x${'02'.repeat(32)}`,
      };
    }
    case 'eth_getTransactionReceipt': {
      if (params[0] !== TX_HASH) {
        return null;
      }
      return {
        transactionHash: TX_HASH,
        transactionIndex: '0x0',
        blockHash: BLOCK_HASH,
        blockNumber: '0x11',
        from: anchorKey.address,
        to: DESTINATION,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x2',
      };
    }
    default:
      return null;
  }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const payload: unknown = JSON.parse(body);
      const calls = Array.isArray(payload) ? payload : [payload];
      const responses = calls.map((call) => {
        const { id, method, params } = call as {
          id: number;
          method: string;
          params?: unknown[];
        };
        seen.push(method);
        return {
          jsonrpc: '2.0',
          id,
          result: resultFor(method, params ?? []),
        };
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(Array.isArray(payload) ? responses : responses[0]),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  rpcUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function transport(): ViemChainTransport {
  return ViemChainTransport.create({
    rpcUrl,
    privateKey: anchorKey.privateKey,
    network: 'base-sepolia',
    endpointLabel: 'fake-node',
  });
}

describe('ViemChainTransport', () => {
  it('reports the Base Sepolia chain identity and never exposes the key', () => {
    const client = transport();

    expect(client.chainId).toBe(84532);
    expect(client.network).toBe('base-sepolia');
    expect(client.endpointLabel).toBe('fake-node');
    expect(client.address).toBe(anchorKey.address);
    expect(client.toJSON()).toEqual({
      network: 'base-sepolia',
      chainId: 84532,
      endpointLabel: 'fake-node',
      address: anchorKey.address,
    });
    expect(JSON.stringify(client)).not.toContain(
      anchorKey.privateKey.slice(2),
    );
  });

  it('defaults the endpoint label to the RPC host, without credentials', () => {
    const client = ViemChainTransport.create({
      rpcUrl: `${rpcUrl}/v2/super-secret-api-key`,
      privateKey: anchorKey.privateKey,
      network: 'base-sepolia',
    });
    expect(client.endpointLabel).not.toContain('super-secret-api-key');
    expect(client.endpointLabel).toContain('127.0.0.1');
  });

  it('submits calldata that is exactly the 32-byte checkpoint digest', async () => {
    const client = transport();

    const sent = await client.sendAnchorTransaction({
      checkpointHash: CHECKPOINT_HASH,
      to: DESTINATION,
    });

    expect(sent.transactionHash).toBe(TX_HASH);
    expect(sent.from).toBe(anchorKey.address);
    expect(sent.to).toBe(DESTINATION);
    expect(sent.inputData).toBe(anchorInputData(CHECKPOINT_HASH));
    expect(sent.inputData).toHaveLength(66);
    expect(Object.keys(sent).sort()).toEqual([
      'from',
      'inputData',
      'to',
      'transactionHash',
    ]);
    expect(JSON.stringify(sent)).not.toContain(anchorKey.privateKey.slice(2));

    // The signed transaction really carries the digest as its calldata.
    const raw = rawTransactions.at(-1) ?? '';
    expect(raw).toContain(DIGEST_HEX);
    expect(seen).toContain('eth_sendRawTransaction');
  });

  it('maps getTransaction, getTransactionReceipt and the head block', async () => {
    const client = transport();

    await expect(client.getTransaction(TX_HASH)).resolves.toEqual({
      hash: TX_HASH,
      from: anchorKey.address,
      to: DESTINATION,
      input: `0x${DIGEST_HEX}`,
      blockNumber: 17,
      blockHash: BLOCK_HASH,
    });
    await expect(client.getTransactionReceipt(TX_HASH)).resolves.toEqual({
      status: 'success',
      blockNumber: 17,
      blockHash: BLOCK_HASH,
    });
    await expect(client.latestBlockNumber()).resolves.toBe(17);
  });

  it('returns null for an unknown transaction instead of throwing', async () => {
    const client = transport();
    const unknown = `0x${'ee'.repeat(32)}`;

    await expect(client.getTransaction(unknown)).resolves.toBeNull();
    await expect(client.getTransactionReceipt(unknown)).resolves.toBeNull();
  });
});
