/** ALD-062 retention policy enforcement over real exported run evidence. */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PUBLIC_RELEASE_MARKER,
  PURGEABLE_BUNDLE_ENTRIES,
  PURGE_TOMBSTONE,
  RETENTION_LOG_FILE,
  readRetentionLog,
  runRetentionJob,
} from '../src/index.js';
import {
  bundleDirOf,
  createHarness,
  noLearningConfig,
  type Harness,
} from './support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('runRetentionJob', () => {
  it('purges only bulk bundle files while preserving every evidence-store row', async () => {
    harness = await createHarness();
    const config = noLearningConfig({
      runId: 'retention-eligible',
      experimentId: 'E00',
      randomSeed: 'seed-retention-eligible',
      prototypeRetentionDays: 30,
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
    });
    await harness.runtime.createRun(config);
    await harness.runtime.step(config.runId);
    const writer = harness.runtime.writerFor(config.runId);
    const checkpoint = writer.readCheckpoints(config.runId)[0];
    if (checkpoint === undefined) {
      throw new Error('run-initialized checkpoint missing');
    }
    writer.insertAnchorReceipt({
      version: 1,
      runId: config.runId,
      checkpointSequence: checkpoint.checkpointSequence,
      checkpointHash: checkpoint.checkpointHash,
      anchorClass: 'simulated',
      network: 'base-sepolia',
      chainId: 84532,
      transactionHash: `0x${'1'.repeat(64)}`,
      from: `0x${'2'.repeat(40)}`,
      to: `0x${'3'.repeat(40)}`,
      inputData: `0x${checkpoint.checkpointHash.slice('sha256:'.length)}`,
      blockNumber: 1,
      blockHash: `0x${'4'.repeat(64)}`,
      status: 'confirmed',
      confirmations: 1,
      finalityPolicy: '1-confirmation',
      rpcEndpointLabel: 'retention-test',
      recordedAt: harness.clock.now(),
    });
    const bundleDir = bundleDirOf(harness, config.runId);
    await harness.runtime.exportBundle(config.runId, bundleDir);

    const rowCounts = {
      runs: writer.listRuns().length,
      babyA: writer.readEvents(config.runId, 'baby-a-ledger').length,
      babyB: writer.readEvents(config.runId, 'baby-b-ledger').length,
      channel: writer.readEvents(config.runId, 'channel').length,
      audit: writer.readEvents(config.runId, 'audit').length,
      intervention: writer.readEvents(config.runId, 'intervention').length,
      checkpoints: writer.readCheckpoints(config.runId).length,
      receipts: writer.readAnchorReceipts(config.runId).length,
    };
    harness.clock.advance(31 * 86_400_000);
    const result = await runRetentionJob({
      evidence: writer,
      bundleRoot: harness.root,
      clock: harness.clock,
    });

    expect(result).toMatchObject({ runsConsidered: 1, runsPurged: 1 });
    expect(result.decisions[0]).toMatchObject({
      runId: config.runId,
      purged: true,
      reason: 'eligible',
      mainnetAnchored: false,
    });
    for (const entry of PURGEABLE_BUNDLE_ENTRIES) {
      expect(await exists(join(bundleDir, entry)), entry).toBe(false);
    }
    expect(await exists(join(bundleDir, 'run-manifest.json'))).toBe(true);
    expect(await exists(join(bundleDir, 'checkpoints'))).toBe(true);
    expect(await exists(join(bundleDir, 'anchors'))).toBe(true);
    expect(await exists(join(bundleDir, PURGE_TOMBSTONE))).toBe(true);

    expect({
      runs: writer.listRuns().length,
      babyA: writer.readEvents(config.runId, 'baby-a-ledger').length,
      babyB: writer.readEvents(config.runId, 'baby-b-ledger').length,
      channel: writer.readEvents(config.runId, 'channel').length,
      audit: writer.readEvents(config.runId, 'audit').length,
      intervention: writer.readEvents(config.runId, 'intervention').length,
      checkpoints: writer.readCheckpoints(config.runId).length,
      receipts: writer.readAnchorReceipts(config.runId).length,
    }).toEqual(rowCounts);

    const audit = await readRetentionLog(join(harness.root, RETENTION_LOG_FILE));
    expect(audit.violations).toEqual([]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      runId: config.runId,
      reasonCode: 'retention-purge',
      dryRun: false,
    });
  });

  it('retains public-release bundles indefinitely', async () => {
    harness = await createHarness();
    const config = noLearningConfig({
      runId: 'retention-public',
      experimentId: 'E00',
      randomSeed: 'seed-retention-public',
      prototypeRetentionDays: 1,
    });
    await harness.runtime.createRun(config);
    const bundleDir = bundleDirOf(harness, config.runId);
    await harness.runtime.exportBundle(config.runId, bundleDir);
    await writeFile(
      join(bundleDir, PUBLIC_RELEASE_MARKER),
      JSON.stringify({
        version: 1,
        declaredAt: harness.clock.now(),
        declaredBy: 'retention-test',
        reason: 'public research artifact',
      }),
      'utf8',
    );
    harness.clock.advance(2 * 86_400_000);

    const result = await runRetentionJob({
      evidence: harness.runtime.writerFor(config.runId),
      bundleRoot: harness.root,
      clock: harness.clock,
    });

    expect(result.decisions[0]).toMatchObject({
      purged: false,
      reason: 'public-release',
      publicRelease: true,
    });
    expect(await exists(join(bundleDir, 'baby-a-ledger.jsonl'))).toBe(true);
    expect(await readFile(join(bundleDir, PUBLIC_RELEASE_MARKER), 'utf8')).toContain(
      'public research artifact',
    );
  });

  it('retains Base-mainnet-anchored bundles indefinitely', async () => {
    harness = await createHarness();
    const config = noLearningConfig({
      runId: 'retention-mainnet',
      experimentId: 'E00',
      randomSeed: 'seed-retention-mainnet',
      prototypeRetentionDays: 1,
      anchorClass: 'public-chain',
      anchorNetwork: 'base-mainnet',
    });
    await harness.runtime.createRun(config);
    const writer = harness.runtime.writerFor(config.runId);
    const checkpoint = writer.readCheckpoints(config.runId)[0];
    if (checkpoint === undefined) {
      throw new Error('run-initialized checkpoint missing');
    }
    writer.insertAnchorReceipt({
      version: 1,
      runId: config.runId,
      checkpointSequence: checkpoint.checkpointSequence,
      checkpointHash: checkpoint.checkpointHash,
      anchorClass: 'public-chain',
      network: 'base-mainnet',
      chainId: 8453,
      transactionHash: `0x${'5'.repeat(64)}`,
      from: `0x${'6'.repeat(40)}`,
      to: `0x${'7'.repeat(40)}`,
      inputData: `0x${checkpoint.checkpointHash.slice('sha256:'.length)}`,
      blockNumber: 2,
      blockHash: `0x${'8'.repeat(64)}`,
      status: 'confirmed',
      confirmations: 1,
      finalityPolicy: '1-confirmation',
      rpcEndpointLabel: 'retention-test-mainnet',
      recordedAt: harness.clock.now(),
    });
    const bundleDir = bundleDirOf(harness, config.runId);
    await harness.runtime.exportBundle(config.runId, bundleDir);
    harness.clock.advance(2 * 86_400_000);

    const result = await runRetentionJob({
      evidence: writer,
      bundleRoot: harness.root,
      clock: harness.clock,
    });

    expect(result.decisions[0]).toMatchObject({
      purged: false,
      reason: 'mainnet-anchored',
      mainnetAnchored: true,
    });
    expect(await exists(join(bundleDir, 'channel-transcript.jsonl'))).toBe(true);
  });

  it('retains young bundles and runs whose retention policy is disabled', async () => {
    harness = await createHarness();
    const young = noLearningConfig({
      runId: 'retention-young',
      experimentId: 'E00',
      randomSeed: 'seed-retention-young',
      prototypeRetentionDays: 30,
    });
    const disabled = noLearningConfig({
      runId: 'retention-disabled',
      experimentId: 'E00',
      randomSeed: 'seed-retention-disabled',
      prototypeRetentionDays: 0,
    });
    await harness.runtime.createRun(young);
    await harness.runtime.createRun(disabled);
    await harness.runtime.exportBundle(young.runId, bundleDirOf(harness, young.runId));
    await harness.runtime.exportBundle(
      disabled.runId,
      bundleDirOf(harness, disabled.runId),
    );

    const result = await runRetentionJob({
      evidence: harness.runtime.writerFor(young.runId),
      bundleRoot: harness.root,
      clock: harness.clock,
    });
    expect(
      Object.fromEntries(
        result.decisions.map((decision) => [decision.runId, decision.reason]),
      ),
    ).toEqual({
      'retention-young': 'within-retention',
      'retention-disabled': 'retention-disabled',
    });
    expect(result.runsPurged).toBe(0);
  });
});
