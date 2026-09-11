import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { createIsolatedAdapterFactory } from '@ald/isolation';
import { buildRunConfig } from '@ald/lifecycle';
import {
  FORT_SIGNER_SEEDS_FILE_ENV,
  createProductionRuntime,
  signerProviderFromFortEnvironment,
} from '@ald/orchestrator';

const track = process.argv[2] ?? 'no-learning';
const allowedTracks = new Set([
  'no-learning',
  'scratch-rl',
  'self-supervised',
  'hybrid',
]);
if (!allowedTracks.has(track)) {
  throw new Error(`unsupported Mode R study track: ${track}`);
}

const outputRoot = '/evidence';
const softwareCommit = process.env['ALD_SOFTWARE_COMMIT'] ?? 'unknown';
const runId = `mode-r-study-${track}`;
const clock = { now: () => new Date().toISOString() };
const transport = new FakeChainTransport({
  network: 'base-sepolia',
  endpointLabel: 'local-qualification-fake-chain',
});
const fortSignerProvider =
  process.env[FORT_SIGNER_SEEDS_FILE_ENV] === undefined
    ? undefined
    : signerProviderFromFortEnvironment();

let production;
const evidence = {
  listRuns: () => production.runtime.listRuns().map((run) => run.runId),
  insertAnchorReceipt: (receipt) =>
    production.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
  readCheckpoints: (id) => production.runtime.writerFor(id).readCheckpoints(id),
  readAnchorReceipts: (id) =>
    production.runtime.writerFor(id).readAnchorReceipts(id),
};
const publisher = new BaseAnchorPublisher({
  transport,
  evidence,
  clock,
  anchorAddress: `0x${'42'.repeat(20)}`,
  finalityPolicy: '1-confirmation',
  retry: {
    attempts: 2,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    sleep: async () => {
      transport.mineBlock();
    },
  },
  confirmationPoll: { attempts: 2, intervalMs: 0 },
});

const factories = [];
production = createProductionRuntime({
  databasePath: join(outputRoot, `${runId}.sqlite`),
  bundleRoot: join(outputRoot, 'bundles'),
  softwareCommit,
  ...(fortSignerProvider === undefined
    ? {}
    : { signerProvider: fortSignerProvider }),
  allowUnanchored: false,
  anchorPublisher: publisher,
  anchorPolicy: 'required',
  adapterFactoryFor: (config, role) => {
    const declaredTrack =
      role === 'baby-a' ? config.babyA.track : config.babyB.track;
    const factory = createIsolatedAdapterFactory({
      track: declaredTrack,
      transport: 'container',
      endpoint: {
        host: role,
        port: 4318,
        attempts: 40,
        retryDelayMs: 250,
        timeoutMs: 1_000,
        hostLabel: role,
      },
      timing: 'normalized',
      deadlineMs: 2_000,
    });
    factories.push(factory);
    return factory;
  },
});

try {
  const learningSignal =
    track === 'no-learning'
      ? 'none'
      : track === 'self-supervised'
        ? 'self-supervised'
        : 'extrinsic-task';
  const config = buildRunConfig({
    runId,
    experimentId: track === 'self-supervised' ? 'E11' : 'E03',
    randomSeed: `qualification-${track}`,
    deploymentMode: 'research-grade',
    babyA: {
      track,
      modelRef: `qualification-${track}`,
      trainingIsolation: 'independent',
    },
    babyB: {
      track,
      modelRef: `qualification-${track}`,
      trainingIsolation: 'independent',
    },
    learningSignal,
    communicationCondition: 'normal',
    maxTurnsPerRun: 4,
    evaluationTurns: 4,
    checkpointEventInterval: 2,
    protocolGitCommit: softwareCommit,
  });

  await production.runtime.createRun(config);
  const initialized = production.runtime.getRun(runId);
  assert.equal(initialized?.deploymentMode, 'research-grade');
  assert.equal(initialized?.state, 'running');

  const summary = await production.runtime.runToCompletion(runId);
  assert.equal(summary.state, 'sealed');
  const records = production.runtime.turnRecords(runId);
  assert.equal(records.filter((record) => record.phase === 'running').length, 4);
  assert.equal(records.filter((record) => record.phase === 'evaluating').length, 4);
  const checkpoints = production.runtime.checkpoints(runId);
  const receipts = production.runtime.writerFor(runId).readAnchorReceipts(runId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, 'confirmed');
  assert.equal(transport.submissions.length, 1);

  const bundleDir = join(outputRoot, 'bundles', 'runs', runId);
  const verification = JSON.parse(
    await readFile(join(bundleDir, 'verification-report.json'), 'utf8'),
  );
  assert.equal(verification.exitCode, 0);
  const manifest = JSON.parse(
    await readFile(join(bundleDir, 'run-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.deploymentMode, 'research-grade');

  const result = {
    schemaVersion: 1,
    classification: 'mode-r-topology-qualification',
    researchFinding: false,
    publicChainTransaction: false,
    anchorTransport: 'local-qualification-fake-chain',
    runId,
    track,
    softwareCommit,
    state: summary.state,
    trainingTurns: 4,
    evaluationTurns: 4,
    eventCounts: {
      babyA: production.runtime.ledgers(runId).babyA.length,
      babyB: production.runtime.ledgers(runId).babyB.length,
      channel: production.runtime.transcript(runId).length,
      turns: records.length,
    },
    checkpointCount: checkpoints.length,
    anchorReceiptCount: receipts.length,
    verifierExitCode: verification.exitCode,
    containerIds: Object.fromEntries(
      ['baby-a', 'baby-b'].map((role) => [
        role,
        production.runtime.adaptersFor(runId)[role].isolation.containerId,
      ]),
    ),
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    join(outputRoot, `${runId}-summary.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  production.close();
  await Promise.all(factories.map((factory) => factory.dispose()));
}
