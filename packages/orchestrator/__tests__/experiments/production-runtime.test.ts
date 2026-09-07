/**
 * `createProductionRuntime` (BACKLOG ALD-072): the production wiring of the
 * real evidence store, checkpoint service, and verifier opens, runs a tiny
 * no-learning run to completion, and `close()` releases the database.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { buildRunConfig } from '@ald/lifecycle';

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
});
