import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { deriveSeedHex } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { verifyBundle } from '@ald/verifier';
import { describe, expect, it } from 'vitest';

import { createProductionRuntime } from '../src/production.js';

describe('disposable E03 Prototype-Mode seal smoke', () => {
  it('seals and separately replays an in-process no-learning run with a simulated anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ald-e03-prototype-smoke-'));
    const runId = 'e03-prototype-smoke';
    const softwareCommit = '1'.repeat(40);
    const clock = { now: () => new Date().toISOString() };
    const transport = new FakeChainTransport({ endpointLabel: 'e03-prototype-smoke' });
    let production: ReturnType<typeof createProductionRuntime> | undefined;
    try {
      const publisher = new BaseAnchorPublisher({
        transport, anchorClass: 'simulated', clock,
        evidence: {
          listRuns: () => production!.runtime.listRuns().map((run) => run.runId),
          insertAnchorReceipt: (receipt) => production!.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
          readCheckpoints: (id) => production!.runtime.writerFor(id).readCheckpoints(id),
          readAnchorReceipts: (id) => production!.runtime.writerFor(id).readAnchorReceipts(id),
        },
        anchorAddress: `0x${'42'.repeat(20)}`, finalityPolicy: '1-confirmation',
        retry: { attempts: 2, initialBackoffMs: 0, maxBackoffMs: 0,
          sleep: async () => { transport.mineBlock(); } },
        confirmationPoll: { attempts: 2, intervalMs: 0 },
      });
      production = createProductionRuntime({
        databasePath: join(root, 'evidence.sqlite'), bundleRoot: join(root, 'bundles'),
        softwareCommit, clock, allowUnanchored: false, anchorPolicy: 'required',
        anchorPublisher: publisher,
      });
      const seed = (component: string) => deriveSeedHex('ald-e03-prototype-smoke', component);
      const config = buildRunConfig({
        runId, experimentId: 'E03', randomSeed: seed('scenario'),
        seedBindings: { version: 1, scenario: seed('scenario'),
          babyA: seed('baby-a'), babyB: seed('baby-b'), gateway: seed('gateway'),
          analysis: seed('analysis') },
        deploymentMode: 'prototype', registrationClass: 'qualification',
        babyA: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
        babyB: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
        learningSignal: 'none', communicationCondition: 'disabled',
        maxTurnsPerRun: 1, evaluationTurns: 1, evaluationSeeds: 1,
        turnResponseBudgetMs: 2_000, checkpointEventInterval: 1_024,
        protocolGitCommit: softwareCommit,
      });
      await production.runtime.createRun(config);
      expect(Object.values(production.runtime.adaptersFor(runId)).every((adapter) =>
        adapter.isolation === undefined || adapter.isolation.boundary === 'in-process')).toBe(true);
      const result = await production.runtime.runToCompletion(runId);
      expect(result.state).toBe('sealed');
      expect(production.runtime.writerFor(runId).readAnchorReceipts(runId)).toHaveLength(1);
      const bundle = production.runtime.bundleDirFor(runId);
      const report = JSON.parse(await readFile(join(bundle, 'verification-report.json'), 'utf8'));
      expect(report.exitCode).toBe(0);
      const independent = await verifyBundle(bundle, {
        verifierVersion: 'e03-prototype-smoke', now: clock.now, writeReport: false,
      });
      expect(independent.exitCode).toBe(0);
    } finally {
      production?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
