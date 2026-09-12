/**
 * ALD-020 — `ViemChainTransport` against a minimal in-process JSON-RPC
 * server. No real network, no funded wallet: the server answers exactly the
 * methods the anchor flow needs, which is enough to prove the calldata really
 * is the bare checkpoint digest, that the mappings for `getTransaction` /
 * `getTransactionReceipt` / `latestBlockNumber` are correct, that a retried
 * send re-broadcasts one pinned nonce instead of paying twice (LEDGER §16
 * Phase 2: "retry and nonce management"), and that neither the private key nor
 * an RPC credential ever reaches a message, a receipt, or an error chain
 * (LEDGER §11).
 */
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import { decodeHash } from '@ald/hashing';
import { keccak256, parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BaseAnchorPublisher,
  TransientChainError,
  ViemChainTransport,
  anchorInputData,
  generateAnchorKey,
} from '../src/index.js';
import type { AnchorTestContext } from './support.js';
import {
  cleanupTemporaryDirectories,
  createAnchorContext,
  immediateSleep,
} from './support.js';

const CHECKPOINT_HASH = `sha256:${'3f'.repeat(32)}`;
const DIGEST_HEX = decodeHash(CHECKPOINT_HASH).toString('hex');
const BLOCK_HASH = `0x${'b1'.repeat(32)}`;
const DESTINATION = `0x${'d0'.repeat(20)}`;
const UNKNOWN_HASH = `0x${'ee'.repeat(32)}`;

/** Credentials planted in the RPC URL; must never surface anywhere. */
const URL_USERINFO = 'anchor:USERINFO_SECRET';
const URL_API_KEY = 'PATH_API_KEY_SECRET';

const anchorKey = generateAnchorKey();

interface AcceptedTransaction {
  raw: string;
  hash: Hex;
  nonce: number;
}

interface FakeNodeOptions {
  /** Record the raw transaction, then destroy the socket without replying. */
  dropSendResponses?: number;
  /** Whether an accepted transaction becomes visible on the chain. */
  visible?: boolean;
  /** Answer every request with this HTTP status and body instead of JSON-RPC. */
  httpFailure?: { status: number; body: string };
  /** Answer `eth_getTransactionByHash`/`Receipt` with a JSON-RPC null result. */
  emptyResults?: boolean;
}

/**
 * A single-purpose JSON-RPC node: it records every method it is asked for and
 * every raw transaction it accepts, so a test can count sends and nonces.
 */
class FakeNode {
  readonly methods: string[] = [];
  readonly accepted: AcceptedTransaction[] = [];

  private server: Server | undefined;
  private port = 0;
  private dropsLeft: number;

  private constructor(private readonly options: FakeNodeOptions) {
    this.dropsLeft = options.dropSendResponses ?? 0;
  }

  static async start(options: FakeNodeOptions = {}): Promise<FakeNode> {
    const node = new FakeNode(options);
    await node.listen();
    return node;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** URL carrying both userinfo and a path API key, as providers do. */
  get credentialUrl(): string {
    return `http://${URL_USERINFO}@127.0.0.1:${String(this.port)}/v2/${URL_API_KEY}`;
  }

  get host(): string {
    return `127.0.0.1:${String(this.port)}`;
  }

  callsTo(method: string): number {
    return this.methods.filter((seen) => seen === method).length;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        this.handle(body, response);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  private handle(body: string, response: ServerResponse): void {
    const failure = this.options.httpFailure;
    if (failure !== undefined) {
      response.writeHead(failure.status, { 'content-type': 'text/plain' });
      response.end(failure.body);
      return;
    }

    const payload: unknown = JSON.parse(body);
    const calls = Array.isArray(payload) ? payload : [payload];
    let drop = false;
    const responses = calls.map((call) => {
      const { id, method, params } = call as {
        id: number;
        method: string;
        params?: unknown[];
      };
      this.methods.push(method);
      if (method === 'eth_sendRawTransaction' && this.dropsLeft > 0) {
        this.dropsLeft -= 1;
        this.accept(params ?? []);
        drop = true;
        return { jsonrpc: '2.0', id, result: null };
      }
      return { jsonrpc: '2.0', id, result: this.resultFor(method, params ?? []) };
    });

    if (drop) {
      // The node took the transaction but the answer never comes back.
      response.destroy();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(Array.isArray(payload) ? responses : responses[0]),
    );
  }

  private accept(params: readonly unknown[]): AcceptedTransaction {
    const raw = typeof params[0] === 'string' ? params[0] : '0x';
    const parsed = parseTransaction(raw as Hex);
    const accepted: AcceptedTransaction = {
      raw,
      hash: keccak256(raw as Hex),
      nonce: parsed.nonce ?? 0,
    };
    this.accepted.push(accepted);
    return accepted;
  }

  private knows(hash: unknown): AcceptedTransaction | undefined {
    if (this.options.visible === false || this.options.emptyResults === true) {
      return undefined;
    }
    return this.accepted.find(
      (candidate) =>
        typeof hash === 'string' &&
        candidate.hash.toLowerCase() === hash.toLowerCase(),
    );
  }

  private resultFor(method: string, params: readonly unknown[]): unknown {
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
        // A pool-size nonce: a second read would hand out a *new* nonce, so a
        // transport that re-reads it per attempt duplicates the transaction.
        return `0x${this.accepted.length.toString(16)}`;
      case 'eth_sendRawTransaction':
        return this.accept(params).hash;
      case 'eth_getTransactionByHash': {
        const known = this.knows(params[0]);
        if (known === undefined) {
          return null;
        }
        return {
          hash: known.hash,
          nonce: `0x${known.nonce.toString(16)}`,
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
        const known = this.knows(params[0]);
        if (known === undefined) {
          return null;
        }
        return {
          transactionHash: known.hash,
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
}

const openNodes: FakeNode[] = [];

async function node(options: FakeNodeOptions = {}): Promise<FakeNode> {
  const started = await FakeNode.start(options);
  openNodes.push(started);
  return started;
}

function transportFor(
  rpcUrl: string,
  endpointLabel?: string,
): ViemChainTransport {
  return ViemChainTransport.create({
    rpcUrl,
    privateKey: anchorKey.privateKey,
    network: 'base-sepolia',
    // One HTTP attempt per logical call keeps the send/nonce counts readable.
    retryCount: 0,
    ...(endpointLabel === undefined ? {} : { endpointLabel }),
  });
}

const openContexts: AnchorTestContext[] = [];

async function anchorContext(runId: string): Promise<AnchorTestContext> {
  const created = await createAnchorContext(runId);
  openContexts.push(created);
  return created;
}

function publisherOver(
  ctx: AnchorTestContext,
  transport: ViemChainTransport,
): BaseAnchorPublisher {
  return new BaseAnchorPublisher({
    transport,
    anchorClass: 'public-chain',
    evidence: ctx.writer,
    clock: ctx.clock,
    anchorAddress: DESTINATION,
    finalityPolicy: '1-confirmation',
    retry: { attempts: 1, initialBackoffMs: 1, sleep: immediateSleep },
    confirmationPoll: { attempts: 1, intervalMs: 0 },
  });
}

afterAll(async () => {
  for (const open of openContexts.splice(0)) {
    open.close();
  }
  await Promise.all(openNodes.splice(0).map(async (open) => open.stop()));
  await cleanupTemporaryDirectories();
});

describe('ViemChainTransport', () => {
  it('reports the Base Sepolia chain identity and never exposes the key', async () => {
    const rpc = await node();
    const client = transportFor(rpc.url, 'fake-node');

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

  it('defaults the endpoint label to the RPC host, without credentials', async () => {
    const rpc = await node();
    const client = transportFor(rpc.credentialUrl);

    expect(client.endpointLabel).toBe(rpc.host);
    expect(client.endpointLabel).not.toContain(URL_API_KEY);
    expect(client.endpointLabel).not.toContain('USERINFO_SECRET');
  });

  it('submits calldata that is exactly the 32-byte checkpoint digest', async () => {
    const rpc = await node();
    const client = transportFor(rpc.url, 'fake-node');

    const sent = await client.sendAnchorTransaction({
      checkpointHash: CHECKPOINT_HASH,
      to: DESTINATION,
    });

    const accepted = rpc.accepted[0];
    expect(rpc.accepted).toHaveLength(1);
    expect(sent.transactionHash).toBe(accepted?.hash);
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
    expect(accepted?.raw).toContain(DIGEST_HEX);
    expect(rpc.callsTo('eth_sendRawTransaction')).toBe(1);
  });

  it('maps getTransaction, getTransactionReceipt and the head block', async () => {
    const rpc = await node();
    const client = transportFor(rpc.url, 'fake-node');
    const sent = await client.sendAnchorTransaction({
      checkpointHash: CHECKPOINT_HASH,
      to: DESTINATION,
    });

    await expect(client.getTransaction(sent.transactionHash)).resolves.toEqual({
      hash: sent.transactionHash,
      from: anchorKey.address,
      to: DESTINATION,
      input: `0x${DIGEST_HEX}`,
      blockNumber: 17,
      blockHash: BLOCK_HASH,
    });
    await expect(
      client.getTransactionReceipt(sent.transactionHash),
    ).resolves.toEqual({
      status: 'success',
      blockNumber: 17,
      blockHash: BLOCK_HASH,
    });
    await expect(client.latestBlockNumber()).resolves.toBe(17);
  });

  it('returns null for an unknown transaction instead of throwing', async () => {
    const rpc = await node({ emptyResults: true });
    const client = transportFor(rpc.url, 'fake-node');

    await expect(client.getTransaction(UNKNOWN_HASH)).resolves.toBeNull();
    await expect(
      client.getTransactionReceipt(UNKNOWN_HASH),
    ).resolves.toBeNull();
  });
});

describe('nonce pinning (LEDGER §16 Phase 2)', () => {
  it('re-broadcasts one pinned nonce when a send is retried', async () => {
    // The node swallows the first send (records the tx, drops the response)
    // and never makes it visible, which is exactly the publisher's
    // "throw means nothing was submitted, so retry" path.
    const rpc = await node({ dropSendResponses: 1, visible: false });
    const client = transportFor(rpc.url, 'fake-node');
    const input = { checkpointHash: CHECKPOINT_HASH, to: DESTINATION };

    await expect(client.sendAnchorTransaction(input)).rejects.toBeInstanceOf(
      TransientChainError,
    );
    const retried = await client.sendAnchorTransaction(input);

    // Two broadcasts, one nonce, one set of signed bytes: the chain can only
    // accept them as the same transaction, never as a second paid one.
    expect(rpc.accepted).toHaveLength(2);
    expect(new Set(rpc.accepted.map((tx) => tx.nonce))).toEqual(new Set([0]));
    expect(new Set(rpc.accepted.map((tx) => tx.raw)).size).toBe(1);
    expect(new Set(rpc.accepted.map((tx) => tx.hash)).size).toBe(1);
    expect(retried.transactionHash).toBe(rpc.accepted[0]?.hash);
    // The pending nonce is read once per logical submission, not per attempt.
    expect(rpc.callsTo('eth_getTransactionCount')).toBe(1);
    expect(rpc.callsTo('eth_sendRawTransaction')).toBe(2);
  });

  it('reports the existing transaction when a send loses its response', async () => {
    // Same lost response, but this time the node does know the transaction.
    const rpc = await node({ dropSendResponses: 1 });
    const client = transportFor(rpc.url, 'fake-node');

    const sent = await client.sendAnchorTransaction({
      checkpointHash: CHECKPOINT_HASH,
      to: DESTINATION,
    });

    expect(rpc.accepted).toHaveLength(1);
    expect(sent.transactionHash).toBe(rpc.accepted[0]?.hash);
    expect(sent.inputData).toBe(anchorInputData(CHECKPOINT_HASH));
  });
});

describe('error redaction (LEDGER §11)', () => {
  const secrets = [URL_API_KEY, 'USERINFO_SECRET', 'anchor:USERINFO_SECRET'];

  function assertRedacted(error: unknown, method: string, host: string): void {
    expect(error).toBeInstanceOf(TransientChainError);
    const failure = error as TransientChainError;
    const rendered = `${failure.message} ${inspect(failure, { depth: 6 })}`;
    for (const secret of secrets) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).not.toContain('/v2/');
    expect(failure.message).toContain(host);
    expect(failure.message).toContain(method);
    expect(failure.code).toBe('TRANSIENT_CHAIN_ERROR');
    // No cause to walk: inspecting a chain would re-expose viem's message.
    expect(failure.cause).toBeUndefined();
  }

  it('never leaks the RPC URL from a failing provider', async () => {
    const rpc = await node({
      httpFailure: { status: 500, body: 'upstream unavailable' },
    });
    const client = transportFor(rpc.credentialUrl);

    await expect(client.latestBlockNumber()).rejects.toBeInstanceOf(
      TransientChainError,
    );
    assertRedacted(
      await client.latestBlockNumber().catch((error: unknown) => error),
      'eth_blockNumber',
      rpc.host,
    );
    assertRedacted(
      await client
        .getTransactionReceipt(UNKNOWN_HASH)
        .catch((error: unknown) => error),
      'eth_getTransactionReceipt',
      rpc.host,
    );
    assertRedacted(
      await client.getTransaction(UNKNOWN_HASH).catch((error: unknown) => error),
      'eth_getTransactionByHash',
      rpc.host,
    );
    assertRedacted(
      await client
        .sendAnchorTransaction({
          checkpointHash: CHECKPOINT_HASH,
          to: DESTINATION,
        })
        .catch((error: unknown) => error),
      'eth_getTransactionCount',
      rpc.host,
    );
  });

  it('keeps the provider status code, which is not a credential', async () => {
    const rpc = await node({
      httpFailure: { status: 503, body: 'over quota' },
    });
    const client = transportFor(rpc.credentialUrl);

    const failure = await client
      .latestBlockNumber()
      .catch((error: unknown) => error);
    expect((failure as Error).message).toContain('HTTP 503');
    expect((failure as Error).message).not.toContain('over quota');
  });

  it('never turns a provider failure into the chain fact "not found"', async () => {
    // The exact body a 404 from a mis-pathed provider returns; classifying it
    // by message substring would let the verifier report an affirmative
    // "transaction does not exist on chain".
    const rpc = await node({
      httpFailure: {
        status: 404,
        body: 'The requested resource could not be found on this server.',
      },
    });
    const client = transportFor(rpc.credentialUrl);

    await expect(client.getTransaction(UNKNOWN_HASH)).rejects.toBeInstanceOf(
      TransientChainError,
    );
    await expect(
      client.getTransactionReceipt(UNKNOWN_HASH),
    ).rejects.toBeInstanceOf(TransientChainError);
  });

  it('never turns a provider auth error into the chain fact "not found"', async () => {
    const rpc = await node({
      httpFailure: {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32_000, message: 'API key could not be found' },
        }),
      },
    });
    const client = transportFor(rpc.credentialUrl);

    const failure = await client
      .getTransaction(UNKNOWN_HASH)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransientChainError);
    expect((failure as Error).message).not.toContain('API key');
  });
});

describe('anchoring over a credentialed RPC URL', () => {
  it('keeps the credential out of the receipt and out of the failure', async () => {
    const ctx = await anchorContext('run-anchor-viem-ok');
    const manifest = await ctx.addCheckpoint();
    const rpc = await node();
    const publisher = publisherOver(ctx, transportFor(rpc.credentialUrl));

    const receipt = await publisher.submit(manifest);
    expect(receipt.rpcEndpointLabel).toBe(rpc.host);
    expect(JSON.stringify(receipt)).not.toContain(URL_API_KEY);
    expect(JSON.stringify(receipt)).not.toContain('USERINFO_SECRET');

    const confirmed = await publisher.awaitConfirmation(receipt);
    expect(confirmed.status).toBe('confirmed');
    const stored = ctx.writer.readAnchorReceipts(ctx.runId);
    expect(JSON.stringify(stored)).not.toContain(URL_API_KEY);
    expect(JSON.stringify(stored)).not.toContain('USERINFO_SECRET');
  });

  it('keeps the credential out of an anchor-unavailable deviation', async () => {
    const ctx = await anchorContext('run-anchor-viem-broken');
    const manifest = await ctx.addCheckpoint();
    const rpc = await node({
      httpFailure: { status: 500, body: 'upstream unavailable' },
    });
    const publisher = publisherOver(ctx, transportFor(rpc.credentialUrl));

    const failure = await publisher
      .anchorAndConfirm(manifest)
      .catch((error: unknown) => error);

    // The exact string the orchestrator records as a run deviation, and the
    // whole error chain behind it (SPEC §14.5, LEDGER §11).
    const deviation = `anchor-unavailable: ${
      failure instanceof Error ? failure.message : String(failure)
    } ${inspect(failure, { depth: 8 })}`;
    expect(deviation).not.toContain(URL_API_KEY);
    expect(deviation).not.toContain('USERINFO_SECRET');
    expect(deviation).not.toContain('/v2/');
    expect(deviation).toContain(rpc.host);
    expect(ctx.writer.readAnchorReceipts(ctx.runId)).toHaveLength(0);
  });
});
