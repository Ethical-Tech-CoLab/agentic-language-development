/**
 * Regression for the finding that `writeProofFiles` could emit a consistency
 * proof `@ald/verifier` itself rejected (docs/evidence-bundle-format.md §6;
 * LEDGER-INTEGRITY-DESIGN.md §8, §17). The verifier now reads an auxiliary
 * tree absent from the `from` checkpoint as the empty tree
 * (`packages/verifier/src/checkpoints.ts` `emptyCheckpointTree`, exercised by
 * `packages/verifier/__tests__/empty-tree-consistency.test.ts`), so this test
 * does not change `writeProofFiles` — it closes the gap the finding actually
 * asked for: an end-to-end check that runs the real, independent
 * `@ald/verifier` over a bundle this package produced, rather than only
 * re-verifying proofs locally the way `proof-files.test.ts` does.
 *
 * LEDGER §17 requires the verifier to "accept an unchanged run bundle"; this
 * is the cross-package test that pins that acceptance for the exact shape the
 * finding reproduced: checkpoint 0 created before any turn (so `turns` is
 * legitimately undeclared there), three turns each followed by an
 * event-interval checkpoint, and a run-sealed checkpoint.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { exportRunBundle } from '@ald/evidence';
import { loadLearnerContract, promptBundleHash } from '@ald/learners';
import { verifyBundle } from '@ald/verifier';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupTemporaryDirectories,
  commitTurns,
  createContext,
  temporaryDirectory,
} from './support.js';

afterEach(cleanupTemporaryDirectories);

describe('writeProofFiles against the independent @ald/verifier', () => {
  it('produces a bundle whose proofs verify clean, including the checkpoint-0 auxiliary-tree gap', async () => {
    // Mirrors nursery-runtime.ts#createRun: the config actually used to
    // register the run binds `promptBundleHash` to the real learner contract
    // bundle, not the genesis placeholder, so the exported run-config.json
    // and the learnerContracts written to prompts/ agree.
    const contract = loadLearnerContract('no-learning');
    const context = await createContext({
      babyA: { track: 'no-learning' },
      babyB: { track: 'no-learning' },
      learningSignal: 'none',
      promptBundleHash: promptBundleHash([contract]),
    });

    // Checkpoint 0, created at run initialization before any turn exists:
    // per bundle format §6 it legitimately omits `turns` (and `affect`,
    // `audit`) because those streams hold no events yet.
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    expect(
      context.writer.readCheckpoints(context.runId)[0]?.auxiliaryTrees,
    ).toEqual({});

    for (let turn = 1; turn <= 3; turn += 1) {
      await commitTurns(context, 1, turn);
      await context.service.createCheckpoint(context.runId, 'event-interval');
    }
    await context.service.createCheckpoint(context.runId, 'run-sealed');

    const bundleDir = join(await temporaryDirectory(), 'bundle');
    await exportRunBundle(context.writer, context.runId, bundleDir, {
      softwareCommit: 'git:test-commit',
      learnerContracts: [
        { track: contract.track, version: contract.version, text: contract.text },
      ],
    });

    const proofCounts = await context.service.writeProofFiles(
      context.runId,
      bundleDir,
    );
    expect(proofCounts.inclusionFiles).toBeGreaterThan(0);
    expect(proofCounts.consistencyFiles).toBeGreaterThan(0);
    // The exact files the finding reproduced: a consistency proof from
    // checkpoint 0 (which does not declare `turns`) to checkpoint 1 (which
    // does).
    const consistencyFiles = await readdir(
      join(bundleDir, 'proofs', 'consistency'),
    );
    expect(consistencyFiles).toContain('turns-0-1.json');

    const report = await verifyBundle(bundleDir, {
      verifierVersion: 'test',
      now: () => new Date().toISOString(),
      allowUnanchored: true,
      writeReport: false,
    });

    // Assert the proof- and checkpoint-rebuild checks the finding is about.
    // Other checks may legitimately fail for reasons unrelated to proofs
    // (for example an unattached anchor chain reader); those are out of
    // scope for this regression and are not asserted here.
    expect(report.checks.inclusionProofsValid).toBe(true);
    expect(report.checks.consistencyProofsValid).toBe(true);
    expect(report.checks.merkleRootsRebuilt).toBe(true);
    expect(report.checks.checkpointHashesRebuilt).toBe(true);
    expect(
      report.gaps.filter(
        (gap) =>
          gap.includes('consistency-proof') || gap.includes('inclusion-proof'),
      ),
    ).toEqual([]);
    // With allowUnanchored, the only remaining gaps are the expected
    // unanchored-tail notes; the bundle is otherwise clean, so exitCode is 0.
    expect(report.exitCode).toBe(0);

    context.close();
  });
});
