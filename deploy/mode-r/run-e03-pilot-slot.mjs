import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { hashCanonical } from '@ald/hashing';
import { createProductionRuntime } from '@ald/orchestrator';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';

const [runId, softwareCommit] = process.argv.slice(2);
assert.equal(process.argv.length, 4, 'usage: run-e03-pilot-slot.mjs <run-id> <commit>');
assert.match(runId, /^e03-pilot-(?:v[23]-)?(?:disabled|constant|random|shuffled|normal|oracle)-s\d{3}$/u);
assert.match(softwareCommit, /^[a-f0-9]{40}$/u);

const registration = JSON.parse(await readFile('/evidence/registration.json', 'utf8'));
const artifact = PreRegistrationArtifactSchema.parse(registration.artifact);
const registrationHash = hashCanonical(HASH_DOMAINS.preRegistration, artifact);
assert.equal(registration.preRegistrationHash, registrationHash);
assert.equal(artifact.experimentId, 'E03');
assert.equal(artifact.parameters.stage, 'blinded-pilot');
const topology = artifact.parameters.executionBinding?.topology;
assert.equal(topology?.mode, 'prototype');
assert.equal(topology.learnerContainersPerSlot, 0);
assert.equal(topology.nurseryContainersPerSlot, 1);
assert.equal(topology.sharedNurseryProcess, true);
assert.equal(topology.adapterTransport, 'in-process');
assert.equal(topology.adapterTiming, 'immediate');
assert.equal(topology.turnResponseBudgetMs, 2_000);
assert.match(process.env.HOSTNAME, /^[a-f0-9]{12}$/u);
const registered = registration.runs.find((run) => run.config.runId === runId);
assert.ok(registered && registered.use === 'primary');
const { config, condition, slot } = registered;
assert.equal(config.communicationCondition, condition);
assert.equal(config.preRegistrationHash, registrationHash);
assert.equal(config.evaluationTurns, 200);
assert.equal(config.turnResponseBudgetMs, 2_000);
assert.equal(config.deploymentMode, 'prototype');
assert.equal(config.babyA.track, 'no-learning');
assert.equal(config.babyB.track, 'no-learning');

const root = join('/evidence', runId);
await mkdir(root); // Original pilot evidence is single-use, including failed attempts.
const clock = { now: () => new Date().toISOString() };
let production;
let failure = null;
let failureStage = 'initialization';
let observations = null;
let nurseryResourceUsage = null;
let resourceMeasurementFailure = null;
const started = performance.now();

async function measureNursery() {
  const peakBytes = Number((await readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim());
  const cpuStat = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
  const cpuUsageMicroseconds = Number(/^usage_usec (\d+)$/mu.exec(cpuStat)?.[1]);
  assert.ok(Number.isSafeInteger(peakBytes) && peakBytes > 0);
  assert.ok(Number.isSafeInteger(cpuUsageMicroseconds) && cpuUsageMicroseconds > 0);
  return { peakBytes, cpuUsageMicroseconds, scope: 'nursery-container-cgroup' };
}

try {
  const transport = new FakeChainTransport({ endpointLabel: 'e03-pilot-simulated-commitment' });
  const evidence = {
    listRuns: () => production.runtime.listRuns().map((run) => run.runId),
    insertAnchorReceipt: (receipt) => production.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
    readCheckpoints: (id) => production.runtime.writerFor(id).readCheckpoints(id),
    readAnchorReceipts: (id) => production.runtime.writerFor(id).readAnchorReceipts(id),
  };
  const publisher = new BaseAnchorPublisher({
    transport, anchorClass: 'simulated', evidence, clock,
    anchorAddress: `0x${'44'.repeat(20)}`, finalityPolicy: '1-confirmation',
    retry: { attempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, sleep: async () => transport.mineBlock() },
    confirmationPoll: { attempts: 2, intervalMs: 0 },
  });
  production = createProductionRuntime({
    databasePath: join(root, 'evidence.sqlite'), bundleRoot: join(root, 'bundles'),
    softwareCommit, clock, allowUnanchored: false, anchorPolicy: 'required',
    anchorPublisher: publisher,
  });
  failureStage = 'run-creation';
  await production.runtime.createRun(config);
  const adapters = production.runtime.adaptersFor(runId);
  assert.ok(Object.values(adapters).every((adapter) =>
    adapter.isolation === undefined || adapter.isolation.boundary === 'in-process'));
  failureStage = 'collection';
  const summary = await production.runtime.runToCompletion(runId, {
    onTurn: (result) => {
      if (result.phase === 'evaluating' && (result.turn + 1) % 50 === 0) {
        console.log(`${runId}: evaluation turn ${result.turn + 1}/201`);
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
  assert.ok(accepted.length > 0, 'a registered control must carry accepted channel events');
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
  observations = {
    runId, condition, slot, scenarioSeed: config.randomSeed,
    seedBindings: config.seedBindings,
    configurationHash: production.runtime.getRun(runId).configurationHash,
    scenarioStateHashes: evaluation.map((record) => record.scenarioStateHash),
    evaluationTurns: evaluation.length,
    agreements: evaluation.filter((record) => record.outcome.success === true).length,
    channelEvents: channel.length, acceptedChannelEvents: accepted.length,
    checkpoints: production.runtime.checkpoints(runId).length,
    nurseryContainerId: process.env.HOSTNAME, nurseryProcessId: process.pid,
    roleProcessIds: { 'baby-a': process.pid, 'baby-b': process.pid },
    externalLearnerContainerCount: 0,
    anchorReceiptCount: receipts.length, verifierExitCode: verification.exitCode,
    state: summary.state,
  };
} catch (error) {
  failure = `${error.name}: ${error.message}`;
} finally {
  try { nurseryResourceUsage = await measureNursery(); }
  catch (error) { resourceMeasurementFailure = `${error.name}: ${error.message}`; }
  try { production?.close(); }
  catch (error) { failure = `${failure ?? ''} close failed: ${error.message}`; }
  const passed = failure === null && resourceMeasurementFailure === null && observations !== null;
  await writeFile(join(root, 'slot.json'), `${JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', stage: 'blinded-pilot',
    classification: 'original-registered-pilot-slot',
    researchFinding: false, scientificDisposition: 'not-tested',
    externalSpend: 0, publicChainTransaction: false,
    softwareCommit, registrationHash, runId, condition, slot,
    failure, failureStage, observations, resourceMeasurementFailure,
    nurseryResourceUsage, processResourceUsage: process.resourceUsage(),
    wallMilliseconds: performance.now() - started, passed,
    claimBoundary: 'Registered E03 Prototype-Mode blinded-pilot feasibility/variance input only; no Research-Grade isolation, chance-control, or language-emergence finding.',
  }, null, 2)}\n`, { flag: 'wx' });
  if (!passed) process.exitCode = 1;
}
