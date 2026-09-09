/** ALD-057 battery-to-evidence integration and provenance binding. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunConfig } from '@ald/lifecycle';
import type { LearnerProvenance } from '@ald/types';
import { BundleAttachmentIndexSchema, VerificationReportSchema } from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProductionRuntime, type NurseryRuntimeImpl } from '../src/index.js';

const RUN_ID = 'semantic-leakage-evidence';
const FROZEN_FEATURES = Array.from({ length: 64 }, (_, index) => ({
  label: `english-class-${String(index % 4)}`,
  features: [0, 0, 0, 0],
}));
const PRE_REGISTRATION = {
  seed: 'semantic-leakage-evidence-v1',
  confidence: 0.95,
  permutations: 40,
} as const;

describe('semantic-leakage evidence integration (ALD-057)', () => {
  let root: string;
  let runtime: NurseryRuntimeImpl;
  let close: () => void;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-semantic-leakage-'));
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:semantic-leakage-test',
    });
    runtime = production.runtime;
    close = production.close;
    await runtime.createRun(
      buildRunConfig({
        runId: RUN_ID,
        experimentId: 'E11',
        randomSeed: 'semantic-leakage-run-seed',
        deploymentMode: 'prototype',
        babyA: { track: 'scratch-rl' },
        babyB: { track: 'scratch-rl' },
        learningSignal: 'extrinsic-task',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
      }),
    );

    const initialization = runtime
      .auditLog(RUN_ID)
      .find((event) => event.reasonCode === 'learner-initialization');
    const recorded = initialization?.details['provenance'] as Record<
      string,
      LearnerProvenance
    >;
    const inputFor = (babyRole: 'baby-a' | 'baby-b') => ({
      provenance: recorded[babyRole] as LearnerProvenance,
      frozenFeatures: FROZEN_FEATURES,
      preRegistration: PRE_REGISTRATION,
    });

    await expect(
      runtime.recordSemanticLeakageEvaluation({
        runId: RUN_ID,
        babyRole: 'baby-a',
        actorId: 'researcher:semantic-auditor',
        input: {
          ...inputFor('baby-a'),
          provenance: { ...inputFor('baby-a').provenance, modelRef: 'altered' },
        },
      }),
    ).rejects.toThrow(/exactly match initialization evidence/u);

    for (const babyRole of ['baby-a', 'baby-b'] as const) {
      const result = await runtime.recordSemanticLeakageEvaluation({
        runId: RUN_ID,
        babyRole,
        actorId: 'researcher:semantic-auditor',
        input: inputFor(babyRole),
      });
      expect(result.classification).toBe('strict-ungrounded-eligible');
    }
    await runtime.runToCompletion(RUN_ID);
  }, 60_000);

  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  it('exports each Baby result as a witness-bound per-run attachment', async () => {
    const bundleDir = runtime.bundleDirFor(RUN_ID);
    const index = BundleAttachmentIndexSchema.parse(
      JSON.parse(await readFile(join(bundleDir, 'analysis', 'index.json'), 'utf8')),
    );
    expect(index.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'analysis/semantic-leakage/baby-a.json',
          kind: 'semantic-leakage-battery',
          analysisVersion: 'semantic-leakage-v1',
          boundBy: expect.objectContaining({ stream: 'intervention' }),
        }),
        expect.objectContaining({
          path: 'analysis/semantic-leakage/baby-b.json',
          kind: 'semantic-leakage-battery',
          analysisVersion: 'semantic-leakage-v1',
          boundBy: expect.objectContaining({ stream: 'intervention' }),
        }),
      ]),
    );
    const report = JSON.parse(
      await readFile(
        join(bundleDir, 'analysis', 'semantic-leakage', 'baby-a.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      analysisVersion: 'semantic-leakage-v1',
      track: 'scratch-rl',
      classification: 'strict-ungrounded-eligible',
      claimEligible: true,
    });
  });

  it('keeps the attached battery independently verifiable', async () => {
    const verification = VerificationReportSchema.parse(
      JSON.parse(
        await readFile(
          join(runtime.bundleDirFor(RUN_ID), 'verification-report.json'),
          'utf8',
        ),
      ),
    );
    expect(verification.exitCode).toBe(0);
    expect(verification.checks.witnessSignaturesValid).toBe(true);
  });
});
