/**
 * Verifier-bundle integration through the production wiring (BACKLOG
 * ALD-072).
 *
 * KNOWN TRANSIENT (see the task brief): the integrator is concurrently fixing
 * a checkpoint/verifier integration bug where consistency-proof files for
 * auxiliary trees that were empty at an earlier checkpoint make `verifyBundle`
 * report `consistencyProofsValid: false` (and therefore `exitCode: 1`) for
 * runs with two or more checkpoints. This run has exactly two (`run-
 * initialized` and `run-sealed`), so it reliably exercises that path.
 *
 * Until the fix lands: every check except `consistencyProofsValid` and
 * `inclusionProofsValid` must be `true`, and the report itself must be
 * schema-valid. `exitCode === 0` is asserted only in the test below marked
 * `integration: expect green after checkpoint fix` — keep that test even if
 * it currently fails; it documents the bug this harness does not work around.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunConfig } from '@ald/lifecycle';
import { VerificationReportSchema, type VerificationReport } from '@ald/types';

import { createProductionRuntime } from '../../src/production.js';

const RUN_ID = 'verifier-integration-smoke';

describe('production verifier bundle integration (ALD-072)', () => {
  let root: string;
  let report: VerificationReport;
  let close: () => void;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-verifier-integration-'));
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:verifier-integration-test',
    });
    close = production.close;

    const config = buildRunConfig({
      runId: RUN_ID,
      experimentId: 'E03',
      randomSeed: 'ald-verifier-integration',
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
      evaluationTurns: 8,
    });

    await production.runtime.createRun(config);
    await production.runtime.runToCompletion(RUN_ID);

    // Confirms this run actually exercises the "2+ checkpoints" bug path
    // (`run-initialized` plus `run-sealed`) rather than accidentally dodging
    // it.
    expect(production.runtime.checkpoints(RUN_ID).length).toBeGreaterThanOrEqual(2);

    const raw = await readFile(
      join(production.runtime.bundleDirFor(RUN_ID), 'verification-report.json'),
      'utf8',
    );
    report = VerificationReportSchema.parse(JSON.parse(raw));
  });

  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  it('produces a schema-valid report with every check but the proof and anchor checks true', () => {
    // `VerificationReportSchema.parse` above already proved schema validity.
    // This production runtime has no `AnchorPublisher` (`anchorPolicy:
    // 'skip'`, `allowUnanchored: true`), so `anchorTxConfirmed` and
    // `anchorChainIdMatches` are legitimately (not-escalating) `false` and
    // `unanchoredTailReported` is legitimately `true` — none of that is the
    // KNOWN TRANSIENT bug, which is specifically about the two proof checks.
    const exempt = new Set([
      'consistencyProofsValid',
      'inclusionProofsValid',
      'anchorTxConfirmed',
      'anchorChainIdMatches',
    ]);
    for (const [check, value] of Object.entries(report.checks)) {
      if (exempt.has(check)) {
        continue;
      }
      expect(value, `checks.${check}`).toBe(true);
    }
  });

  // integration: expect green after checkpoint fix
  it('verifies the bundle with exit code 0 once the checkpoint/verifier bug is fixed', () => {
    expect(report.checks.consistencyProofsValid).toBe(true);
    expect(report.checks.inclusionProofsValid).toBe(true);
    expect(report.exitCode).toBe(0);
  });
});
