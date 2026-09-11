/**
 * `createProductionRuntime` (BACKLOG ALD-072): the production wiring of the
 * real evidence store, checkpoint service, and verifier opens, runs a tiny
 * no-learning run to completion, and `close()` releases the database.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { buildRunConfig, createDerivedRunConfig } from '@ald/lifecycle';

import { createProductionRuntime } from '../../src/production.js';

describe('createProductionRuntime (ALD-072)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('opens, completes a tiny no-learning run, and closes cleanly', async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-production-'));
    const { runtime, database, close } = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:production-test',
    });
    expect(database.path).toContain(root);

    const config = buildRunConfig({
      runId: 'production-smoke',
      experimentId: 'E03',
      randomSeed: 'ald-production-smoke',
      deploymentMode: 'prototype',
      babyA: {
        track: 'no-learning',
        modelRef: 'uniform-random-v1',
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'no-learning',
        modelRef: 'uniform-random-v1',
        trainingIsolation: 'independent',
      },
      learningSignal: 'none',
      communicationCondition: 'disabled',
      maxTurnsPerRun: 1,
      evaluationTurns: 4,
    });

    await runtime.createRun(config);
    const summary = await runtime.runToCompletion('production-smoke');

    // Unanchored (no `AnchorPublisher` in this environment, `anchorPolicy:
    // 'skip'`): SPEC §7.2's unanchorable-seal path lands on `aborted-sealed`.
    expect(summary.state).toBe('aborted-sealed');
    expect(
      runtime
        .turnRecords('production-smoke')
        .filter((record) => record.phase === 'evaluating'),
    ).toHaveLength(4);
    expect(runtime.checkpoints('production-smoke').length).toBeGreaterThan(0);

    expect(() => {
      close();
    }).not.toThrow();
  });

  it('supplies the immutable parent bundle when verifying a derived run', async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-production-derived-'));
    const bundleRoot = join(root, 'bundles');
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot,
      softwareCommit: 'git:production-derived-test',
    });
    const parent = buildRunConfig({
      runId: 'production-derived-parent',
      experimentId: 'E30',
      randomSeed: 'production-derived-parent-seed',
      babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      learningSignal: 'extrinsic-task',
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
    });
    await production.runtime.createRun(parent);
    await production.runtime.runToCompletion(parent.runId);
    const checkpoint = production.runtime.checkpoints(parent.runId).at(-1);
    expect(checkpoint).toBeDefined();

    const child = createDerivedRunConfig(
      parent,
      checkpoint?.checkpointHash ?? '',
      'production-derived-child',
      {
        babyAInitialPolicyRef: 'policies/baby-a-latest.json',
        babyBInitialPolicyRef: 'policies/baby-b-latest.json',
        overrides: {
          randomSeed: 'production-derived-child-seed',
          maxTurnsPerRun: 1,
          evaluationTurns: 1,
        },
      },
    );
    await production.runtime.createRun(child);
    await production.runtime.runToCompletion(child.runId);

    const report = JSON.parse(
      await readFile(
        join(bundleRoot, 'runs', child.runId, 'verification-report.json'),
        'utf8',
      ),
    ) as { exitCode: number; gaps: string[] };
    expect(report.exitCode).toBe(0);
    expect(report.gaps.filter((gap) => gap.startsWith('lineage-'))).toEqual([]);
    production.close();
  });
});
