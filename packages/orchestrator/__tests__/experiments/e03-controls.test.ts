/**
 * `runE03Controls` (BACKLOG ALD-072; EXPERIMENT-NOTEBOOK.md E03).
 *
 * Two seeds, twenty-four evaluation episodes: small enough to run in a
 * fraction of a second per condition, large enough to tell the deterministic
 * `oracle` condition apart from every no-learning control at astronomically
 * low false-positive odds (binomial(24, 0.25) clearing 0.6 is effectively
 * impossible).
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { CLAIM_BOUNDARY_STATEMENTS } from '@ald/types';

import { createProductionRuntime } from '../../src/production.js';
import {
  E03_CONDITIONS,
  runE03Controls,
  writeQualificationReport,
} from '../../src/experiments/index.js';

describe('runE03Controls (ALD-072)', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('runs every condition, computes the Appendix D analysis, and writes a report', async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-e03-'));
    const { runtime, close } = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:e03-test',
    });

    const result = await runE03Controls(runtime, {
      seeds: 2,
      episodes: 24,
      softwareCommit: 'git:e03-test',
    });

    close();

    expect(result.runs).toHaveLength(E03_CONDITIONS.length * 2);
    for (const run of result.runs) {
      expect(run.evaluationTurns).toBe(24);
      // Unanchored (no `AnchorPublisher`): SPEC §7.2's unanchorable-seal path.
      expect(run.state).toBe('aborted-sealed');
      if (run.condition === 'oracle') {
        expect(run.proportion).toBeGreaterThan(0.9);
      } else {
        expect(run.proportion).toBeGreaterThanOrEqual(0);
        expect(run.proportion).toBeLessThanOrEqual(0.6);
      }
    }

    // Every non-oracle condition has its own analysis entry.
    expect(result.analysis.conditions).toHaveLength(E03_CONDITIONS.length - 1);
    expect(typeof result.analysis.qualifies).toBe('boolean');
    expect(result.analysis.oracle.n).toBe(2);

    const outDir = join(root, 'report');
    const { files } = await writeQualificationReport(outDir, {
      e03: result,
      runSetId: 'test-e03',
      nodeVersion: process.version,
    });
    expect(files.length).toBeGreaterThan(0);

    const reportText = await readFile(join(outDir, 'REPORT.md'), 'utf8');
    expect(reportText).toContain(CLAIM_BOUNDARY_STATEMENTS.prototype);
    expect(reportText).toContain(result.qualificationLabel);
    for (const run of result.runs) {
      expect(reportText).toContain(run.runId);
    }

    // The JSON summary must also serialize despite any `NaN` the analysis
    // package legitimately reports at this seed count (RESEARCH.md Appendix
    // D §D.10, `insufficient-seeds`).
    const jsonText = await readFile(join(outDir, 'e03-summary.json'), 'utf8');
    expect(() => JSON.parse(jsonText)).not.toThrow();
  }, 60_000);
});
