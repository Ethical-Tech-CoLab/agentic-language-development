/**
 * `runE11NamingGame` (BACKLOG ALD-072; EXPERIMENT-NOTEBOOK.md E11).
 *
 * One seed, 300 training turns, 40 evaluation turns: enough for the tabular
 * REINFORCE track to move off a uniform policy without the multi-minute
 * budget of the full E11 conformance run in `scratch-rl-run.test.ts`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProductionRuntime } from '../../src/production.js';
import {
  runE11NamingGame,
  writeQualificationReport,
} from '../../src/experiments/index.js';

describe('runE11NamingGame (ALD-072)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('produces per-run RL metrics, freezes the policy in evaluation, and writes a report', async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-e11-'));
    const learnerOptions = { learningRate: 1, temperature: 0.5 };
    const { runtime, close } = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:e11-test',
      // NOTE: must match the `learnerOptions` passed to `runE11NamingGame`
      // below — the runtime, not the harness, owns the adapters (see
      // `e11-naming-game.ts`'s module doc).
      learnerOptions: { shared: learnerOptions },
    });

    const result = await runE11NamingGame(runtime, {
      seeds: 1,
      trainingTurns: 300,
      evaluationTurns: 40,
      learnerOptions,
      softwareCommit: 'git:e11-test',
    });

    close();

    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run).toBeDefined();
    if (run === undefined) {
      return;
    }

    expect(run.policyHashConstant).toBe(true);
    expect(run.summary.evaluation.n).toBe(40);
    const windowTotal = run.summary.trainingCurve.reduce(
      (total, window) => total + window.n,
      0,
    );
    expect(windowTotal).toBe(300);

    expect(Number.isFinite(run.vocabularyUtilization)).toBe(true);
    expect(run.vocabularyUtilization).toBeGreaterThanOrEqual(0);
    expect(run.vocabularyUtilization).toBeLessThanOrEqual(1);
    expect(Number.isFinite(run.symbolEntropyBits)).toBe(true);
    expect(run.symbolEntropyBits).toBeGreaterThanOrEqual(0);
    expect(run.ledgerEventCounts['baby-a']['intention.recorded']).toBeGreaterThan(0);
    expect(run.ledgerEventCounts['baby-b']['intention.recorded']).toBeGreaterThan(0);

    const outDir = join(root, 'report');
    const { files } = await writeQualificationReport(outDir, {
      e11: result,
      runSetId: 'test-e11',
      nodeVersion: process.version,
    });
    expect(files.length).toBeGreaterThan(0);

    const reportText = await readFile(join(outDir, 'REPORT.md'), 'utf8');
    expect(reportText).toContain(run.runId);
    expect(reportText).toContain('What this shows / does not show');
  }, 60_000);
});
