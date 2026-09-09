/** Runtime-to-bundle attachment binding for E01/E02 software readiness. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunConfig } from '@ald/lifecycle';
import {
  BundleAttachmentIndexSchema,
  ExperimentRecordFileSchema,
  VerificationReportSchema,
  type BundleAttachmentIndex,
} from '@ald/types';

import { createProductionRuntime } from '../src/production.js';

const RUN_ID = 'e02-readiness-attachment';

describe('analysis attachment integration', () => {
  let root: string;
  let bundleDir: string;
  let close: () => void;
  let index: BundleAttachmentIndex;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-attachment-integration-'));
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:attachment-integration-test',
    });
    close = production.close;
    await production.runtime.createRun(
      buildRunConfig({
        runId: RUN_ID,
        experimentId: 'E02',
        randomSeed: 'e02-readiness-attachment-seed',
        deploymentMode: 'prototype',
        babyA: { track: 'no-learning' },
        babyB: { track: 'no-learning' },
        learningSignal: 'none',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
      }),
    );

    await production.runtime.attachAnalysis({
      runId: RUN_ID,
      path: 'analysis/red-team-observation/e02-readiness.json',
      kind: 'red-team-observation',
      analysisVersion: 'red-team-observation-suite-v1',
      value: {
        status: 'software-readiness',
        scientificResult: false,
        passed: true,
      },
      actorId: 'researcher:red-team',
      reasonCode: 'e02-software-readiness',
    });
    await production.runtime.runToCompletion(RUN_ID);
    bundleDir = production.runtime.bundleDirFor(RUN_ID);
    index = BundleAttachmentIndexSchema.parse(
      JSON.parse(await readFile(join(bundleDir, 'analysis', 'index.json'), 'utf8')),
    );
  }, 60_000);

  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  it('exports the hashed artifact and its matching intervention binding', async () => {
    expect(index.attachments).toHaveLength(1);
    const attachment = index.attachments[0];
    expect(attachment?.kind).toBe('red-team-observation');
    expect(attachment?.boundBy?.stream).toBe('intervention');

    const interventions = (
      await readFile(join(bundleDir, 'intervention-log.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(interventions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'analysis-attached',
          entryHash: attachment?.boundBy?.entryHash,
          details: expect.objectContaining({ sha256: attachment?.sha256 }),
        }),
      ]),
    );
  });

  it('links the artifact from the latest Experiment Record without claiming an experiment result', async () => {
    const file = ExperimentRecordFileSchema.parse(
      JSON.parse(await readFile(join(bundleDir, 'experiment-record.json'), 'utf8')),
    );
    expect(file.current['analysisAttachmentRefs']).toEqual([
      index.attachments[0]?.sha256,
    ]);
    const content = JSON.parse(
      await readFile(
        join(bundleDir, 'analysis', 'red-team-observation', 'e02-readiness.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(content).toMatchObject({
      status: 'software-readiness',
      scientificResult: false,
    });
  });

  it('passes independent local verification and reports the deliberately unanchored qualification run', async () => {
    const report = VerificationReportSchema.parse(
      JSON.parse(
        await readFile(join(bundleDir, 'verification-report.json'), 'utf8'),
      ),
    );
    expect(report.exitCode).toBe(0);
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('analysis-attachment-unanchored'),
      ]),
    );
    expect(report.gaps).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('analysis-attachment-binding-invalid'),
      ]),
    );
  });
});
