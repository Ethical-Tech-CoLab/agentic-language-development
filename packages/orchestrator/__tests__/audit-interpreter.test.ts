/** ALD-064 delayed audit interpreter and evidence integration. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunConfig } from '@ald/lifecycle';
import {
  AuditLedgerEntrySchema,
  VerificationReportSchema,
  type LedgerEvent,
} from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditInterpreterError,
  createProductionRuntime,
  type NurseryRuntimeImpl,
} from '../src/index.js';

const RUN_ID = 'audit-interpreter-integration';

describe('human audit-ledger interpreter (ALD-064)', () => {
  let root: string;
  let runtime: NurseryRuntimeImpl;
  let close: () => void;
  let sources: { babyA: LedgerEvent; babyB: LedgerEvent };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ald-audit-interpreter-'));
    const production = createProductionRuntime({
      databasePath: join(root, 'evidence.sqlite'),
      bundleRoot: join(root, 'bundles'),
      softwareCommit: 'git:audit-interpreter-test',
    });
    runtime = production.runtime;
    close = production.close;
    await runtime.createRun(
      buildRunConfig({
        runId: RUN_ID,
        experimentId: 'E14',
        randomSeed: 'audit-interpreter-seed',
        deploymentMode: 'prototype',
        babyA: { track: 'no-learning' },
        babyB: { track: 'no-learning' },
        learningSignal: 'none',
        maxTurnsPerRun: 3,
        evaluationTurns: 3,
      }),
    );

    await runtime.step(RUN_ID);
    const afterFirst = runtime.ledgers(RUN_ID);
    const babyA = afterFirst.babyA.find(
      (event) => event.turn === 0 && event.contentSchema === 'agent-native-ledger',
    );
    const babyB = afterFirst.babyB.find(
      (event) => event.turn === 0 && event.contentSchema === 'agent-native-ledger',
    );
    if (babyA === undefined || babyB === undefined) {
      throw new Error('turn 0 did not produce both native ledger sources');
    }
    sources = { babyA, babyB };
  }, 60_000);

  afterAll(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses same-turn analysis, then appends a labeled batch without changing native events', async () => {
    await expect(
      runtime.interpretAuditBatch({
        runId: RUN_ID,
        interpreterVersion: 'human-audit-v1',
        entries: [
          {
            babyId: 'A',
            sourceEntryHash: sources.babyA.entryHash,
            content: {
              term: 'S01',
              hypothesis: 'S01 may identify the target',
              evidence: 'turn 0 intention',
            },
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<AuditInterpreterError>>({
      code: 'source-not-eligible',
    });
    expect(runtime.auditLedgers(RUN_ID)).toEqual({ babyA: [], babyB: [] });

    await runtime.step(RUN_ID);
    await expect(
      runtime.interpretAuditBatch({
        runId: RUN_ID,
        interpreterVersion: 'human-audit-v1',
        entries: [
          {
            babyId: 'A',
            sourceEntryHash: sources.babyA.entryHash,
            content: {
              term: 'S01',
              hypothesis: 'valid first draft',
              evidence: 'turn 0 intention',
            },
          },
          {
            babyId: 'B',
            sourceEntryHash: `sha256:${'f'.repeat(64)}`,
            content: {
              term: 'S01',
              hypothesis: 'invalid second draft',
              evidence: 'missing source',
            },
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<AuditInterpreterError>>({
      code: 'invalid-source',
    });
    expect(runtime.auditLedgers(RUN_ID)).toEqual({ babyA: [], babyB: [] });

    const nativeBefore = runtime.ledgers(RUN_ID);
    const checkpointCount = runtime.checkpoints(RUN_ID).length;
    const entries = await runtime.interpretAuditBatch({
      runId: RUN_ID,
      interpreterVersion: 'human-audit-v1',
      entries: [
        {
          babyId: 'A',
          sourceEntryHash: sources.babyA.entryHash,
          content: {
            term: 'S01',
            hypothesis: 'S01 may identify the target',
            confidence: 0.6,
            evidence: 'turn 0 intention',
          },
        },
        {
          babyId: 'B',
          sourceEntryHash: sources.babyB.entryHash,
          content: {
            term: 'S01',
            hypothesis: 'S01 may identify the received target',
            confidence: 0.55,
            evidence: 'turn 0 interpretation',
          },
        },
      ],
    });

    expect(entries.map((entry) => entry.source)).toEqual([
      'generated-analysis',
      'generated-analysis',
    ]);
    expect(entries.map((entry) => entry.sourceEntryHash)).toEqual([
      sources.babyA.entryHash,
      sources.babyB.entryHash,
    ]);
    expect(runtime.ledgers(RUN_ID)).toEqual(nativeBefore);
    const checkpoints = runtime.checkpoints(RUN_ID);
    expect(checkpoints).toHaveLength(checkpointCount + 1);
    expect(checkpoints.at(-1)?.reason).toBe('analysis');
    expect(checkpoints.at(-1)?.auxiliaryTrees['audit']?.treeSize).toBe(2);
    expect(runtime.auditLedgers(RUN_ID)).toEqual({
      babyA: [entries[0]],
      babyB: [entries[1]],
    });
  });

  it('exports the audit stream for successful independent verification', async () => {
    await runtime.runToCompletion(RUN_ID);
    const bundleDir = runtime.bundleDirFor(RUN_ID);
    const exported = (await readFile(join(bundleDir, 'audit-ledger.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => AuditLedgerEntrySchema.parse(JSON.parse(line)));
    expect(exported).toHaveLength(2);

    const report = VerificationReportSchema.parse(
      JSON.parse(
        await readFile(join(bundleDir, 'verification-report.json'), 'utf8'),
      ),
    );
    expect(report.exitCode).toBe(0);
    expect(report.checks.writerSignaturesValid).toBe(true);
    expect(report.checks.merkleRootsRebuilt).toBe(true);
  }, 60_000);
});
