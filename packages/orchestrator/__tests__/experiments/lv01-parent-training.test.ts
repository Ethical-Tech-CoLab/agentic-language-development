/**
 * LV01 per-slot parent training: seeded config, run to completion, sealed
 * bundle export with a seeds-binding receipt.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from '../helpers.js';
import {
  lv01ParentCheckpointHash,
  lv01SlotSeeds,
  readLv01BundleDocs,
} from '../../src/experiments/lv01-collector.js';
import { trainLv01SlotParent } from '../../src/experiments/lv01-parent-training.js';

const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: hash('a'),
  analysisCommitmentHash: hash('b'),
  seedResourceCommitmentHash: hash('c'),
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
  partitionContractVersion: 'lv01-within-support/v1',
};

describe('LV01 per-slot parent training', () => {
  let harness: Harness | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  async function setup() {
    harness = await createHarness();
    if (harness === undefined) throw new Error('harness unavailable');
    scratch = await mkdtemp(join(tmpdir(), 'ald-lv01-parent-'));
    return { runtime: harness.runtime, database: harness.database, runsRoot: harness.root };
  }

  function seeds(slot: number) {
    const derived = lv01SlotSeeds(hash('a'), slot);
    return {
      scenario: derived.scenario,
      babyA: derived.babyA,
      babyB: derived.babyB,
      gateway: derived.gateway,
      analysis: derived.analysis,
    };
  }

  it('trains from slot seeds and exports a sealed valid bundle', async () => {
    const { runtime, database, runsRoot } = await setup();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const active: Harness = harness;
    const bundleDir = join(scratch, 'parent-bundle');
    const { receipt } = await trainLv01SlotParent({
      runtime,
      database,
      signerProvider: (runId: string) => active.signerProvider(runId),
      runId: 'lv01-parent-slot-0001',
      seeds: seeds(1),
      training: {
        track: 'scratch-rl',
        modelRef: 'gru-actor-critic-v1',
        learningSignal: 'extrinsic-task',
        maxTurnsPerRun: 4,
        evaluationTurns: 1,
      },
      ledgerValuePlan: LEDGER_VALUE_PLAN,
      runsRoot,
      bundleDir,
      softwareCommit: 'git:lv01-parent-training-test',
      deploymentMode: 'prototype',
      protocolGitCommit: 'git:test-protocol',
    });
    expect(receipt.runId).toBe('lv01-parent-slot-0001');
    expect(receipt.bundleDir).toBe(bundleDir);
    expect(receipt.experimentId).toBe('LV01');
    expect(receipt.parentSeedsDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(receipt.completedTurns).toBeGreaterThan(0);
    expect(receipt.policyRefs).toEqual(['baby-a-latest.json', 'baby-b-latest.json']);

    const docs = await readLv01BundleDocs(bundleDir);
    expect(lv01ParentCheckpointHash(docs)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(docs.policies['policies/baby-a-latest.json']).toBeDefined();
    expect(docs.policies['policies/baby-b-latest.json']).toBeDefined();
  }, 180_000);

  it('binds distinct slot seeds to distinct bundles', async () => {
    const { runtime, database, runsRoot } = await setup();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const active: Harness = harness;
    const train = (slot: number) => trainLv01SlotParent({
      runtime,
      database,
      signerProvider: (runId: string) => active.signerProvider(runId),
      runId: `lv01-parent-slot-000${slot}`,
      seeds: seeds(slot),
      training: {
        track: 'scratch-rl',
        modelRef: 'gru-actor-critic-v1',
        learningSignal: 'extrinsic-task',
        maxTurnsPerRun: 4,
        evaluationTurns: 1,
      },
      ledgerValuePlan: LEDGER_VALUE_PLAN,
      runsRoot,
      bundleDir: join(scratch, `parent-bundle-${slot}`),
      softwareCommit: 'git:lv01-parent-training-test',
      deploymentMode: 'prototype',
      protocolGitCommit: 'git:test-protocol',
    });
    const [first, second] = [await train(1), await train(2)];
    expect(first.receipt.parentSeedsDigest).not.toBe(second.receipt.parentSeedsDigest);
    expect(first.receipt.runId).not.toBe(second.receipt.runId);
    for (const trained of [first, second]) {
      const docs = await readLv01BundleDocs(trained.bundleDir);
      expect(lv01ParentCheckpointHash(docs)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  }, 240_000);

  it('fails closed on an empty run id', async () => {
    const { runtime, database, runsRoot } = await setup();
    if (harness === undefined || scratch === undefined) throw new Error('setup failed');
    const active: Harness = harness;
    await expect(trainLv01SlotParent({
      runtime,
      database,
      signerProvider: (runId: string) => active.signerProvider(runId),
      runId: '',
      seeds: seeds(1),
      training: {
        track: 'scratch-rl',
        modelRef: 'gru-actor-critic-v1',
        learningSignal: 'extrinsic-task',
        maxTurnsPerRun: 4,
        evaluationTurns: 1,
      },
      ledgerValuePlan: LEDGER_VALUE_PLAN,
      runsRoot,
      bundleDir: join(scratch, 'parent-bundle'),
      softwareCommit: 'git:lv01-parent-training-test',
      deploymentMode: 'prototype',
      protocolGitCommit: 'git:test-protocol',
    })).rejects.toThrow(/parent run id must be non-empty/u);
  }, 60_000);
});
