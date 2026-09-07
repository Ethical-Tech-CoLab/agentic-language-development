/**
 * Bundle-format and report-generation edges: canonical JSON (step 1 of
 * LEDGER-INTEGRITY-DESIGN.md §14), a bundle that cannot be opened at all, the
 * versioned experiment record (SPEC §11.9, §15.1), and the JSON-RPC chain
 * reader the CLI builds for `--rpc-url`.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CHECK_NAMES,
  createJsonRpcChainReader,
  verifyBundle,
} from '@ald/verifier';

import { buildFixtureBundle, type BuiltBundle } from './fixtures/build-bundle.js';
import { copyBundle, readJsonFile, readJsonl, writeJsonFile } from './helpers.js';

const OPTIONS = {
  verifierVersion: 'test-verifier-1',
  now: () => '2026-09-01T12:00:00.000Z',
  writeReport: false as const,
};

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
}, 60_000);

afterAll(async () => {
  await fixture.cleanup();
});

describe('canonical JSON (LEDGER §14 step 1)', () => {
  it('rejects a JSONL line that is valid JSON but not canonical', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const path = join(copy.dir, 'turn-records.jsonl');
      const events = await readJsonl(path);
      const lines = events.map((event, index) =>
        index === 0
          ? JSON.stringify(
              Object.fromEntries(Object.entries(event).reverse()),
            )
          : JSON.stringify(event),
      );
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8');

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(report.checks.canonicalJsonValid).toBe(false);
      expect(
        report.gaps.some((gap) =>
          gap.startsWith('canonical-json-invalid turn-records.jsonl'),
        ),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });

  it('marks every check unverified when the run manifest is missing', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      await rm(join(copy.dir, 'run-manifest.json'));

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      for (const name of CHECK_NAMES) {
        expect(report.checks[name]).toBe(false);
      }
      expect(report.finalVerifiedSizes).toEqual({});
      expect(
        report.gaps.some((gap) => gap.startsWith('missing-file run-manifest.json')),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });
});

describe('checkpoints directory', () => {
  it('fails when the bundle commits no checkpoint at all', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      await rm(join(copy.dir, 'checkpoints'), { recursive: true, force: true });

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(report.checks.anchorTxConfirmed).toBe(false);
      expect(
        report.gaps.some((gap) => gap.startsWith('no-checkpoints ')),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });
});

describe('proof files (bundle format §5)', () => {
  it('notes their absence without failing, since the roots were rebuilt anyway', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      await rm(join(copy.dir, 'proofs'), { recursive: true, force: true });

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(0);
      expect(report.checks.inclusionProofsValid).toBe(true);
      expect(report.checks.consistencyProofsValid).toBe(true);
      expect(
        report.gaps.some((gap) => gap.startsWith('no-proof-files-present ')),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });
});

describe('experiment record (SPEC §11.9)', () => {
  it('accepts the fixture record and rejects a non-contiguous recordVersion', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const path = join(copy.dir, 'experiment-record.json');
      const file = await readJsonFile<{
        current: Record<string, unknown>;
        history: Record<string, unknown>[];
      }>(path);

      expect(file.history).toHaveLength(2);
      expect(file.current).toEqual(file.history[1]);

      const second = file.history[1];
      if (second === undefined) {
        throw new Error('fixture must record two experiment versions');
      }
      second['recordVersion'] = 5;
      file.current = second;
      await writeJsonFile(path, file);

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(
        report.gaps.some((gap) =>
          gap.startsWith('experiment-record-version-gap '),
        ),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });

  it('rejects a rewritten claim-boundary sentence in the experiment record', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const path = join(copy.dir, 'experiment-record.json');
      const file = await readJsonFile<{
        current: Record<string, unknown>;
        history: Record<string, unknown>[];
      }>(path);
      for (const record of file.history) {
        record['claimBoundaryStatement'] = 'This run proves isolation.';
      }
      file.current = file.history[file.history.length - 1] ?? {};
      await writeJsonFile(path, file);

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(
        report.gaps.filter((gap) =>
          gap.startsWith('experiment-record-claim-boundary-mismatch '),
        ),
      ).toHaveLength(2);
    } finally {
      await copy.cleanup();
    }
  });
});

describe('createJsonRpcChainReader', () => {
  interface RpcCall {
    method: string;
    params: unknown[];
  }

  function stubFetch(
    responses: Record<string, unknown>,
    calls: RpcCall[],
  ): typeof fetch {
    return (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as RpcCall;
      calls.push({ method: body.method, params: body.params });
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: responses[body.method] ?? null }),
      };
    }) as unknown as typeof fetch;
  }

  it('resolves the chain id and decodes transactions and receipts', async () => {
    const calls: RpcCall[] = [];
    const reader = await createJsonRpcChainReader('https://rpc.invalid', {
      fetchImpl: stubFetch(
        {
          eth_chainId: '0x14a34',
          eth_getTransactionByHash: {
            to: `0x${'22'.repeat(20)}`,
            input: `0x${'ff'.repeat(32)}`,
            blockNumber: '0x10',
            blockHash: `0x${'cd'.repeat(32)}`,
          },
          eth_getTransactionReceipt: {
            status: '0x1',
            blockNumber: '0x10',
            blockHash: `0x${'cd'.repeat(32)}`,
          },
        },
        calls,
      ),
    });

    expect(reader.chainId).toBe(84_532);
    await expect(reader.getTransaction(`0x${'ab'.repeat(32)}`)).resolves.toEqual({
      to: `0x${'22'.repeat(20)}`,
      input: `0x${'ff'.repeat(32)}`,
      blockNumber: 16,
      blockHash: `0x${'cd'.repeat(32)}`,
    });
    await expect(
      reader.getTransactionReceipt(`0x${'ab'.repeat(32)}`),
    ).resolves.toEqual({
      status: 'success',
      blockNumber: 16,
      blockHash: `0x${'cd'.repeat(32)}`,
    });
    expect(calls.map((call) => call.method)).toEqual([
      'eth_chainId',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
    ]);
  });

  it('returns null for an unknown transaction and trusts an explicit chain id', async () => {
    const calls: RpcCall[] = [];
    const reader = await createJsonRpcChainReader('https://rpc.invalid', {
      chainId: 8_453,
      fetchImpl: stubFetch({}, calls),
    });

    expect(reader.chainId).toBe(8_453);
    await expect(reader.getTransaction(`0x${'ab'.repeat(32)}`)).resolves.toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['eth_getTransactionByHash']);
  });
});
