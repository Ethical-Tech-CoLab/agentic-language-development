import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDerivedRunConfig } from '@ald/lifecycle';
import { verifyBundleDetailed } from '@ald/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, testConfig, type Harness } from './helpers.js';

describe('derived-run evidence lineage (SPEC §7.4, ALD-028)', () => {
  let harness: Harness;
  let exportRoot: string;

  beforeEach(async () => {
    harness = await createHarness();
    exportRoot = await mkdtemp(join(tmpdir(), 'ald-derived-exports-'));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(exportRoot, { recursive: true, force: true });
  });

  it('witnesses, exports, and independently verifies immutable parent lineage', async () => {
    const parent = testConfig({
      runId: 'run-derived-parent',
      experimentId: 'E30',
      randomSeed: 'derived-parent-seed',
      maxTurnsPerRun: 2,
    });
    await harness.runtime.createRun(parent);
    const parentCheckpoint = harness.runtime.checkpoints(parent.runId)[0];
    expect(parentCheckpoint).toBeDefined();

    const child = createDerivedRunConfig(
      parent,
      parentCheckpoint?.checkpointHash ?? '',
      'run-derived-child',
      {
        babyAInitialPolicyRef: 'policies/baby-a-policy-initial.json',
        babyBInitialPolicyRef: 'policies/baby-b-policy-initial.json',
        overrides: { randomSeed: 'derived-child-seed' },
      },
    );
    await harness.runtime.createRun(child);

    const attestation = harness.runtime
      .auditLog(child.runId)
      .find((event) => event.reasonCode === 'learner-initialization');
    expect(attestation?.sequence).toBe(1);
    expect(attestation?.details?.['lineage']).toEqual({
      parentRunId: parent.runId,
      derivedFromCheckpointHash: parentCheckpoint?.checkpointHash,
      initialPolicyRefs: {
        babyA: child.babyA.initialPolicyRef,
        babyB: child.babyB.initialPolicyRef,
      },
    });

    const parentExport = join(exportRoot, 'parent');
    const childExport = join(exportRoot, 'child');
    await harness.runtime.exportBundle(parent.runId, parentExport);
    await harness.runtime.exportBundle(child.runId, childExport);

    const manifest = JSON.parse(
      await readFile(join(childExport, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['initialPolicyRefs']).toEqual({
      babyA: child.babyA.initialPolicyRef,
      babyB: child.babyB.initialPolicyRef,
    });
    await expect(
      readFile(join(parentExport, 'policies', 'baby-a-policy-initial.json'), 'utf8'),
    ).resolves.toBeTruthy();

    const verified = await verifyBundleDetailed(childExport, {
      verifierVersion: 'derived-lineage-test',
      now: () => '2026-09-09T00:00:00.000Z',
      allowUnanchored: true,
      writeReport: false,
      parentBundleDir: parentExport,
    });
    expect(
      verified.report.gaps.filter((gap) => gap.startsWith('lineage-')),
    ).toEqual([]);
  });

  it('fails closed when a derived export is verified without its parent', async () => {
    const parent = testConfig({
      runId: 'run-missing-parent',
      experimentId: 'E30',
      randomSeed: 'missing-parent-seed',
    });
    await harness.runtime.createRun(parent);
    const checkpoint = harness.runtime.checkpoints(parent.runId)[0];
    const child = createDerivedRunConfig(
      parent,
      checkpoint?.checkpointHash ?? '',
      'run-missing-parent-child',
      {
        babyAInitialPolicyRef: 'policies/baby-a-policy-initial.json',
        babyBInitialPolicyRef: 'policies/baby-b-policy-initial.json',
      },
    );
    await harness.runtime.createRun(child);
    const childExport = join(exportRoot, 'child-without-parent');
    await harness.runtime.exportBundle(child.runId, childExport);

    const verified = await verifyBundleDetailed(childExport, {
      verifierVersion: 'derived-lineage-test',
      now: () => '2026-09-09T00:00:00.000Z',
      allowUnanchored: true,
      writeReport: false,
    });
    expect(verified.report.exitCode).toBe(1);
    expect(verified.report.gaps).toContain(
      'lineage-parent-bundle-required derived runs require the immutable parent export via --parent-bundle',
    );
  });

  it('substitutes a child learner for E30 without mutating the parent configuration', async () => {
    const parent = testConfig({
      runId: 'run-e30-parent',
      experimentId: 'E30',
      randomSeed: 'e30-parent-seed',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      learningSignal: 'none',
    });
    const parentBefore = structuredClone(parent);
    const checkpointHash = `sha256:${'a'.repeat(64)}`;

    const child = createDerivedRunConfig(
      parent,
      checkpointHash,
      'run-e30-replacement-child',
      {
        babyAInitialPolicyRef: 'policies/baby-a-policy-initial.json',
        babyBInitialPolicyRef: 'policies/baby-b-policy-initial.json',
        overrides: {
          babyB: { track: 'frozen-llm', modelRef: 'open-weights:test-model' },
          symmetricTracks: false,
        },
      },
    );

    expect(parent).toEqual(parentBefore);
    expect(child.babyA.track).toBe('no-learning');
    expect(child.babyB.track).toBe('frozen-llm');
    expect(child.parentRunId).toBe(parent.runId);
    expect(child.derivedFromCheckpointHash).toBe(checkpointHash);
  });
});
