import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { deriveSeedHex } from '@ald/hashing';
import { createIsolatedAdapterFactory } from '@ald/isolation';
import { buildRunConfig } from '@ald/lifecycle';
import { createProductionRuntime } from '@ald/orchestrator';

const [condition, softwareCommit, profile = 'v1'] = process.argv.slice(2);
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
assert.ok([4, 5].includes(process.argv.length),
  'usage: run-e03-topology-slot.mjs <condition> <commit> [v1|prototype-v2]');
assert.ok(conditions.includes(condition));
assert.match(softwareCommit, /^[a-f0-9]{40}$/u);
assert.ok(['v1', 'prototype-v2'].includes(profile));

const runId = profile === 'v1'
  ? `e03-topology-development-${condition}`
  : `e03-topology-prototype-v2-${condition}`;
const root = `/evidence/${runId}`;
const seedRoot = profile === 'v1'
  ? 'ald-e03-topology-development-v1'
  : 'ald-e03-topology-prototype-v2';
const scenarioSeed = deriveSeedHex(seedRoot, 'scenario');
const seed = (component) => deriveSeedHex(seedRoot, `${condition}/${component}`);
const clock = { now: () => new Date().toISOString() };
const factories = [];
let production;
let failure = null;
let failureStage = 'initialization';
let observations = null;
let containerResourceUsage = null;
let resourceMeasurementFailure = null;
const started = performance.now();

await mkdir(root); // An attempted development slot is single-use and retained on failure.

async function sampleContainerResources() {
  const peakBytes = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
  const cpu = Object.fromEntries((await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).trim().split('\n')
    .map((line) => { const [key, value] = line.split(' '); return [key, Number(value)]; }));
  assert.ok(Number.isSafeInteger(peakBytes) && peakBytes > 0);
  assert.ok(Number.isSafeInteger(cpu.usage_usec) && cpu.usage_usec > 0);
  return { peakBytes, cpuUsageMicroseconds: cpu.usage_usec, scope: 'nursery-container-cgroup' };
}

try {
  const transport = new FakeChainTransport({ endpointLabel: 'e03-development-simulated-commitment' });
  const evidence = {
    listRuns: () => production.runtime.listRuns().map((run) => run.runId),
    insertAnchorReceipt: (receipt) => production.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
    readCheckpoints: (id) => production.runtime.writerFor(id).readCheckpoints(id),
    readAnchorReceipts: (id) => production.runtime.writerFor(id).readAnchorReceipts(id),
  };
  const publisher = new BaseAnchorPublisher({
    transport, anchorClass: 'simulated', evidence, clock,
    anchorAddress: `0x${'42'.repeat(20)}`, finalityPolicy: '1-confirmation',
    retry: { attempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, sleep: async () => transport.mineBlock() },
    confirmationPoll: { attempts: 2, intervalMs: 0 },
  });
  production = createProductionRuntime({
    databasePath: join(root, 'evidence.sqlite'), bundleRoot: join(root, 'bundles'),
    softwareCommit, clock, allowUnanchored: false, anchorPolicy: 'required',
    anchorPublisher: publisher,
    ...(profile === 'v1' ? { adapterFactoryFor: (_config, role) => {
      const factory = createIsolatedAdapterFactory({
        track: 'no-learning', transport: 'container',
        endpoint: { host: role, port: 4318, attempts: 40, retryDelayMs: 250, timeoutMs: 1_000, hostLabel: role },
        timing: 'normalized', deadlineMs: 2_000,
      });
      factories.push(factory);
      return factory;
    } } : {}),
  });
  failureStage = 'run-creation';
  const config = buildRunConfig({
    runId, experimentId: 'E03', randomSeed: scenarioSeed,
    seedBindings: {
      version: 1, scenario: scenarioSeed,
      babyA: seed('baby-a'), babyB: seed('baby-b'), gateway: seed('gateway'), analysis: seed('analysis'),
    },
    deploymentMode: profile === 'v1' ? 'research-grade' : 'prototype',
    registrationClass: 'qualification',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1', trainingIsolation: 'independent' },
    learningSignal: 'none', communicationCondition: condition,
    maxTurnsPerRun: 1, evaluationTurns: 200, evaluationSeeds: 1,
    turnResponseBudgetMs: 2_000, checkpointEventInterval: 1_024,
    protocolGitCommit: softwareCommit,
  });
  await production.runtime.createRun(config);
  const adapters = production.runtime.adaptersFor(runId);
  const containerIds = profile === 'v1'
    ? Object.fromEntries(['baby-a', 'baby-b'].map((role) => [role, adapters[role].isolation.containerId]))
    : null;
  if (profile === 'v1') assert.equal(new Set(Object.values(containerIds)).size, 2);
  else {
    assert.ok(Object.values(adapters).every((adapter) =>
      adapter.isolation === undefined || adapter.isolation.boundary === 'in-process'));
    assert.match(process.env.HOSTNAME, /^[a-f0-9]{12}$/u);
  }
  failureStage = 'collection';
  const summary = await production.runtime.runToCompletion(runId, {
    onTurn: (result) => {
      if (result.phase === 'evaluating' && (result.turn + 1) % 50 === 0) {
        console.log(`${condition}: evaluation turn ${result.turn + 1}/201`);
      }
    },
  });
  assert.equal(summary.state, 'sealed');
  failureStage = 'audit';
  const records = production.runtime.turnRecords(runId);
  const evaluation = records.filter((record) => record.phase === 'evaluating');
  assert.equal(records.filter((record) => record.phase === 'running').length, 1);
  assert.equal(evaluation.length, 200);
  assert.ok(evaluation.every((record) => record.communicationCondition === condition));
  const channel = production.runtime.transcript(runId);
  assert.ok(channel.every((event) => event.communicationCondition === condition));
  const accepted = channel.filter((event) => event.gatewayValidationResult === 'accepted');
  assert.ok(accepted.length > 0, 'a control topology must carry accepted channel events');
  if (condition === 'oracle') {
    assert.ok(accepted.every((event) => event.origin === 'gateway-control'));
  } else {
    assert.ok(accepted.every((event) => event.origin === 'baby'));
  }
  if (condition === 'disabled') {
    assert.ok(accepted.every((event) => event.deliveryReceipt === undefined));
  } else {
    assert.ok(accepted.every((event) => event.deliveryReceipt !== undefined));
  }
  if (condition === 'constant') {
    assert.equal(new Set(accepted.map((event) => event.publicArtifactHash)).size, 1);
  }
  if (condition === 'random') {
    assert.ok(new Set(accepted.map((event) => event.publicArtifactHash)).size > 1);
  }
  const receipts = production.runtime.writerFor(runId).readAnchorReceipts(runId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'confirmed');
  const bundleDir = production.runtime.bundleDirFor(runId);
  const verification = JSON.parse(await readFile(join(bundleDir, 'verification-report.json'), 'utf8'));
  assert.equal(verification.exitCode, 0);
  const manifest = JSON.parse(await readFile(join(bundleDir, 'run-manifest.json'), 'utf8'));
  assert.equal(manifest.deploymentMode, profile === 'v1' ? 'research-grade' : 'prototype');
  observations = {
    runId, condition, scenarioSeed, seedBindings: config.seedBindings,
    configurationHash: production.runtime.getRun(runId).configurationHash,
    scenarioStateHashes: evaluation.map((record) => record.scenarioStateHash),
    evaluationTurns: evaluation.length,
    acceptedChannelEvents: accepted.length,
    rejectedChannelEvents: channel.filter((event) => event.gatewayValidationResult === 'rejected').length,
    successes: evaluation.filter((record) => record.outcome.success === true).length,
    checkpoints: production.runtime.checkpoints(runId).length,
    ...(profile === 'v1'
      ? { containerIds }
      : { nurseryContainerId: process.env.HOSTNAME, nurseryProcessId: process.pid,
        roleProcessIds: { 'baby-a': process.pid, 'baby-b': process.pid },
        externalLearnerContainerCount: 0 }),
    anchorReceiptCount: receipts.length, verifierExitCode: verification.exitCode,
    state: summary.state,
  };
} catch (error) {
  failure = `${error.name}: ${error.message}`;
} finally {
  try { containerResourceUsage = await sampleContainerResources(); }
  catch (error) { resourceMeasurementFailure = `${error.name}: ${error.message}`; }
  try { production?.close(); }
  catch (error) { failure = `${failure ?? ''} close failed: ${error.message}`; }
  for (const factory of factories) {
    try { await factory.dispose(); }
    catch (error) { failure = `${failure ?? ''} adapter disposal failed: ${error.message}`; }
  }
  const passed = failure === null && resourceMeasurementFailure === null && observations !== null;
  await writeFile(join(root, 'slot.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', classification: 'development-only-topology-qualification',
    researchFinding: false, externalSpend: 0, publicChainTransaction: false,
    softwareCommit, condition, ...(profile === 'v1' ? {} : { profile }),
    failure, failureStage, observations,
    resourceMeasurementFailure, containerResourceUsage,
    processResourceUsage: process.resourceUsage(), wallMilliseconds: performance.now() - started,
    passed,
    claimBoundary: profile === 'v1'
      ? 'Six-condition transport, control, anchor, and verifier mechanics only; no E03 pilot or research finding; not full Research-Grade writer/signer isolation.'
      : 'Prototype-Mode in-process control, oracle, simulated-anchor, and verifier mechanics only; no Research-Grade isolation claim, pilot, or research finding.',
  }, null, 2)}\n`, { flag: 'wx' });
  if (!passed) process.exitCode = 1;
}
