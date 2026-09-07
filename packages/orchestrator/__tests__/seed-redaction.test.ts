import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openEvidenceDatabase } from '@ald/evidence';
import { buildRunConfig } from '@ald/lifecycle';
import type {
  LearnerAdapter,
  LearnerAdapterFactory,
  LearnerInitContext,
} from '@ald/types';

import { createNurseryRuntime, simpleCheckpointFactory } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/**
 * SPEC §4.3 / §9.5 / §10.1: the Learner must not receive the run's
 * `randomSeed`, because with it and the public Scenario Engine an adapter can
 * regenerate researcher-only ground truth for every episode.
 */
describe('learner init context', () => {
  it('withholds randomSeed and every other seed-derivable field', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'ald-seed-redaction-'));
    directories.push(workDir);
    const seen: LearnerInitContext[] = [];

    const spyFactory = (
      inner: LearnerAdapterFactory,
    ): LearnerAdapterFactory => ({
      track: inner.track,
      create: (): LearnerAdapter => {
        const adapter = inner.create();
        const init = adapter.init.bind(adapter);
        adapter.init = async (context) => {
          seen.push(context);
          await init(context);
        };
        return adapter;
      },
    });

    const { createLearnerAdapterFactory } = await import('@ald/learners');
    const runtime = createNurseryRuntime({
      database: openEvidenceDatabase(join(workDir, 'evidence.sqlite')),
      softwareCommit: 'git:test',
      bundleRoot: join(workDir, 'bundles'),
      checkpointFactory: simpleCheckpointFactory({ softwareCommit: 'git:test' }),
      anchorPolicy: 'skip',
      adapterFactoryFor: () =>
        spyFactory(createLearnerAdapterFactory('no-learning')),
    });

    const config = buildRunConfig({
      runId: 'seed-redaction',
      experimentId: 'E03',
      randomSeed: 'super-secret-run-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
      learningSignal: 'none',
      maxTurnsPerRun: 1,
      evaluationTurns: 2,
    });
    await runtime.createRun(config);

    expect(seen).toHaveLength(2);
    for (const context of seen) {
      expect('randomSeed' in context.config).toBe(false);
      expect(JSON.stringify(context)).not.toContain('super-secret-run-seed');
      expect(context.seed).not.toBe('super-secret-run-seed');
    }
    expect(seen[0]?.seed).not.toBe(seen[1]?.seed);
  });
});
