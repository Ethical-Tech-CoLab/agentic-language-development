import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { hashCanonical, omitFields } from '@ald/hashing';
import {
  AnchorReceiptSchema,
  HASH_DOMAINS,
  MANIFEST_SIGNATURE_FIELDS,
  VerificationReportSchema,
  type AnchorReceipt,
  type CheckpointManifest,
} from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHECK_NAMES, verifyBundle, verifyBundleDetailed, type ChainReader } from '@ald/verifier';

import {
  buildFixtureBundle,
  FIXTURE_ANCHOR_TO,
  FIXTURE_ANCHOR_TX,
  FIXTURE_BLOCK_HASH,
  FIXTURE_BLOCK_NUMBER,
  FIXTURE_CHAIN_ID,
  FIXTURE_TURNS,
  type BuiltBundle,
} from './fixtures/build-bundle.js';
import {
  checkpointFile,
  copyBundle,
  readJsonFile,
  writeJsonFile,
} from './helpers.js';

const CHECKED_AT = '2026-09-01T12:00:00.000Z';

export const OPTIONS = {
  verifierVersion: 'test-verifier-1',
  now: () => CHECKED_AT,
  writeReport: false as const,
};

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
}, 60_000);

afterAll(async () => {
  await fixture.cleanup();
});

describe('verifyBundle on an unchanged bundle', () => {
  it('accepts it with exitCode 0 and every check satisfied', async () => {
    const { report, details } = await verifyBundleDetailed(
      fixture.bundleDir,
      OPTIONS,
    );

    // Bundle format §8 requires the report to record whether chain retrieval
    // ran; offline that is the one gap an otherwise clean bundle carries.
    expect(report.gaps).toEqual([
      expect.stringContaining('anchor-chain-not-checked') as unknown as string,
    ]);
    expect(report.forks).toEqual([]);
    expect(report.exitCode).toBe(0);
    for (const name of CHECK_NAMES) {
      expect(report.checks[name]).toBe(name !== 'unanchoredTailReported');
    }
    expect(report.runId).toBe(fixture.runId);
    expect(report.verifierVersion).toBe('test-verifier-1');
    expect(report.checkedAt).toBe(CHECKED_AT);
    expect(details.crossBindingFailures).toEqual([]);
    expect(details.checkpointCount).toBe(3);
    expect(details.anchoredThroughCheckpoint).toBe(2);
    expect(details.proofFilesChecked).toBeGreaterThan(10);
    expect(details.chainChecked).toBe(false);
    expect(details.experimentRecordPresent).toBe(true);
  });

  it('reports the verified size of every stream and tree', async () => {
    const report = await verifyBundle(fixture.bundleDir, OPTIONS);

    expect(report.finalVerifiedSizes).toMatchObject({
      'baby-a-ledger': FIXTURE_TURNS,
      'baby-b-ledger': FIXTURE_TURNS,
      channel: FIXTURE_TURNS,
      turns: FIXTURE_TURNS,
      intervention: 1,
      babyA: FIXTURE_TURNS,
      babyB: FIXTURE_TURNS,
    });
  });

  it('matches every stream head recomputed from JSONL with the committed tree sizes', async () => {
    const { details } = await verifyBundleDetailed(fixture.bundleDir, OPTIONS);
    const final = await readJsonFile<CheckpointManifest>(
      checkpointFile(fixture.bundleDir, 2),
    );

    expect(details.streamSizes['baby-a-ledger']).toBe(final.babyA.treeSize);
    expect(details.streamSizes['baby-b-ledger']).toBe(final.babyB.treeSize);
    expect(details.streamSizes['channel']).toBe(final.channel.treeSize);
    expect(details.streamSizes['turns']).toBe(
      final.auxiliaryTrees['turns']?.treeSize,
    );
    // The unsigned intervention log is not a checkpoint tree (LEDGER §8).
    expect(details.streamSizes['intervention']).toBe(1);
  });

  it('independently reproduces the final anchored checkpoint hash', async () => {
    const final = await readJsonFile<CheckpointManifest>(
      checkpointFile(fixture.bundleDir, 2),
    );
    const receipts = await readJsonFile<unknown>(
      join(fixture.bundleDir, 'anchors', 'base-receipts.json'),
    );
    const parsed = AnchorReceiptSchema.parse(
      (receipts as AnchorReceipt[])[0],
    );

    const rebuilt = hashCanonical(
      HASH_DOMAINS.checkpoint,
      omitFields(final, MANIFEST_SIGNATURE_FIELDS),
    );

    expect(rebuilt).toBe(final.checkpointHash);
    expect(parsed.inputData).toBe(`0x${rebuilt.slice('sha256:'.length)}`);
  });
});

describe('verification report generation (ALD-017)', () => {
  it('writes a canonical, schema-valid report into the bundle it describes', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const report = await verifyBundle(copy.dir, {
        verifierVersion: 'test-verifier-1',
        now: () => CHECKED_AT,
      });
      const path = join(copy.dir, 'verification-report.json');
      const onDisk = await readJsonFile<unknown>(path);

      expect(VerificationReportSchema.parse(onDisk)).toEqual(report);
      expect(report.exitCode).toBe(0);
      expect(report.checkedAt).toBe(CHECKED_AT);
    } finally {
      await copy.cleanup();
    }
  });

  it('does not write a report when writeReport is false', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      await verifyBundle(copy.dir, OPTIONS);
      await expect(
        access(join(copy.dir, 'verification-report.json')),
      ).rejects.toThrow();
    } finally {
      await copy.cleanup();
    }
  });

  it('records machine-readable failure codes rather than free text', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    try {
      const manifestPath = join(copy.dir, 'run-manifest.json');
      const manifest = await readJsonFile<Record<string, unknown>>(manifestPath);
      manifest['claimBoundaryStatement'] = 'This run proves everything.';
      await writeJsonFile(manifestPath, manifest);

      const report = await verifyBundle(copy.dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(
        report.gaps.some((gap) => gap.startsWith('claim-boundary-mismatch ')),
      ).toBe(true);
    } finally {
      await copy.cleanup();
    }
  });
});

describe('anchor verification against an independent chain reader', () => {
  const goodReader: ChainReader = {
    chainId: FIXTURE_CHAIN_ID,
    getTransaction: async (transactionHash) => {
      const final = await readJsonFile<CheckpointManifest>(
        checkpointFile(fixture.bundleDir, 2),
      );
      return transactionHash === FIXTURE_ANCHOR_TX
        ? {
            to: FIXTURE_ANCHOR_TO,
            input: `0x${final.checkpointHash.slice('sha256:'.length)}`,
            blockNumber: FIXTURE_BLOCK_NUMBER,
            blockHash: FIXTURE_BLOCK_HASH,
          }
        : null;
    },
    getTransactionReceipt: async (transactionHash) =>
      transactionHash === FIXTURE_ANCHOR_TX
        ? {
            status: 'success',
            blockNumber: FIXTURE_BLOCK_NUMBER,
            blockHash: FIXTURE_BLOCK_HASH,
          }
        : null,
  };

  it('confirms calldata, recipient, status, and block inclusion', async () => {
    const { report, details } = await verifyBundleDetailed(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: goodReader,
    });

    expect(report.exitCode).toBe(0);
    expect(report.checks.anchorTxConfirmed).toBe(true);
    expect(report.checks.anchorChainIdMatches).toBe(true);
    expect(details.chainChecked).toBe(true);
  });
});
