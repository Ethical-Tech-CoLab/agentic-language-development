/** ALD-032 evaluator-to-evidence integration and claim boundary. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashCarrierMark } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import type { CarrierLeakageInput } from '@ald/analysis';
import {
  BundleAttachmentIndexSchema,
  VerificationReportSchema,
  type Sha256Hash,
} from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProductionRuntime, type NurseryRuntimeImpl } from '../src/index.js';

const RUN_ID = 'carrier-leakage-evidence';

describe('carrier leakage evidence integration (ALD-032)', () => {
  let root: string;
  let runtime: NurseryRuntimeImpl;
  let close: () => void;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-carrier-leakage-'));
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:carrier-leakage-test',
    });
    runtime = production.runtime;
    close = production.close;
    await runtime.createRun(
      buildRunConfig({
        runId: RUN_ID,
        experimentId: 'E13',
        randomSeed: 'carrier-leakage-evidence-seed',
        deploymentMode: 'prototype',
        babyA: { track: 'no-learning' },
        babyB: { track: 'no-learning' },
        learningSignal: 'none',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
        carrierLeakageProbePlan: {
          recognizableGlyph: { enabled: true, maximumRecognizableRate: 0 },
          intendedCarrierFeatureUse: {
            enabled: true,
            minimumObservations: 4,
          },
        },
      }),
    );

    const glyphA = { glyphs: ['G01'] };
    const glyphB = { glyphs: ['G02'] };
    const markA = hashCarrierMark('fixed-glyph', glyphA) as Sha256Hash;
    const markB = hashCarrierMark('fixed-glyph', glyphB) as Sha256Hash;
    const input = {
      observations: [
        { carrier: 'fixed-glyph', artifact: glyphA, markHash: markA, referentTypeCode: 0 },
        { carrier: 'fixed-glyph', artifact: glyphA, markHash: markA, referentTypeCode: 1 },
        { carrier: 'fixed-glyph', artifact: glyphB, markHash: markB, referentTypeCode: 0 },
        { carrier: 'fixed-glyph', artifact: glyphB, markHash: markB, referentTypeCode: 1 },
      ],
      probePlan: {
        recognizableGlyph: { enabled: true, maximumRecognizableRate: 0 },
        intendedCarrierFeatureUse: {
          enabled: true,
          minimumObservations: 4,
        },
      },
      recognizableGlyphOutcomes: {
        [markA]: 'recognizable',
        [markB]: 'not-recognizable',
      },
    } satisfies CarrierLeakageInput;
    await expect(
      runtime.recordCarrierLeakageEvaluation({
        runId: RUN_ID,
        actorId: 'researcher:carrier-auditor',
        input: {
          ...input,
          probePlan: {
            ...input.probePlan,
            intendedCarrierFeatureUse: {
              ...input.probePlan.intendedCarrierFeatureUse,
              minimumObservations: 5,
            },
          },
        },
      }),
    ).rejects.toThrow(/must exactly match the pre-registered RunConfig plan/u);
    const result = await runtime.recordCarrierLeakageEvaluation({
      runId: RUN_ID,
      actorId: 'researcher:carrier-auditor',
      input,
    });
    expect(result.decision).toBe('fail');
    expect(result.claimBoundary.ungroundedLanguageClaim).toBe('blocked');
    expect(result.claimBoundary.runValidityImpact).toBe('none');
    expect(runtime.getRun(RUN_ID)?.state).toBe('running');

    await runtime.runToCompletion(RUN_ID);
  }, 60_000);

  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  it('exports exact versioned mark metrics as a witness-bound attachment', async () => {
    const bundleDir = runtime.bundleDirFor(RUN_ID);
    const index = BundleAttachmentIndexSchema.parse(
      JSON.parse(await readFile(join(bundleDir, 'analysis', 'index.json'), 'utf8')),
    );
    expect(index.attachments).toEqual([
      expect.objectContaining({
        path: 'analysis/carrier-leakage/report.json',
        kind: 'carrier-leakage',
        analysisVersion: 'carrier-leakage-v2',
        boundBy: expect.objectContaining({ stream: 'intervention' }),
      }),
    ]);

    const report = JSON.parse(
      await readFile(join(bundleDir, 'analysis', 'carrier-leakage', 'report.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      analysisVersion: 'carrier-leakage-v2',
      observations: 4,
      uniqueMarks: 2,
      decision: 'fail',
      claimBoundary: {
        ungroundedLanguageClaim: 'blocked',
        runValidityImpact: 'none',
        evidenceUse: 'valid-negative-or-integrity-evidence',
      },
    });
    expect(report['markMetrics']).toHaveLength(2);
  });

  it('keeps failed leakage results as independently valid integrity evidence', async () => {
    const verification = VerificationReportSchema.parse(
      JSON.parse(
        await readFile(
          join(runtime.bundleDirFor(RUN_ID), 'verification-report.json'),
          'utf8',
        ),
      ),
    );
    expect(verification.exitCode).toBe(0);
    expect(verification.checks.entryHashesRebuilt).toBe(true);
    expect(verification.checks.witnessSignaturesValid).toBe(true);
  });
});
