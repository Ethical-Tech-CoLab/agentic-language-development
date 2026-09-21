import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { loadLearnerContract, promptBundleHash } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

const mode = process.argv[2];
assert.ok(mode === '--run' || mode === '--audit', 'expected --run or --audit');
const runMode = mode === '--run';
const protocolPath = 'protocols/mode-r-application-lifecycle-development.v2.json';
const evidenceRoot = 'evidence/mode-r-application-lifecycle-development-v2';
const receiptPath = join(evidenceRoot, 'receipt.json');
const baseComposePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const overlayComposePath = 'deploy/mode-r/docker-compose.application-lifecycle.v1.yml';
const project = 'ald-mode-r-application-lifecycle-development-v2';
const protocol = readJson(protocolPath);
const commit = command('git', ['rev-parse', 'HEAD']);
const baseEnvironment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(evidenceRoot),
  ALD_SOFTWARE_COMMIT: commit,
  ALD_MODE_R_RUN_ID: protocol.runId,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000),
  ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
};

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  }).trim();
}

function compose(stage, ...args) {
  return command('docker', [
    'compose', '-p', project,
    '-f', baseComposePath,
    '-f', overlayComposePath,
    ...args,
  ], {
    env: { ...baseEnvironment, ALD_MODE_R_CONTROLLER_STAGE: stage },
    timeout: 600_000,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function waitForServiceExit(name, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = command('docker', [
      'ps', '-aq',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', `label=com.docker.compose.service=${name}`,
    ]).split('\n').filter(Boolean);
    assert.ok(ids.length <= 1, `${name} has multiple containers`);
    if (ids.length === 1) {
      const inspected = JSON.parse(command('docker', ['inspect', ids[0]]))[0];
      if (inspected.State.Status === 'exited') {
        return { containerId: inspected.Id, exitCode: inspected.State.ExitCode };
      }
    }
    await delay(250);
  }
  throw new Error(`${name} did not exit within ${String(timeoutMs)} ms`);
}

function snapshot(resolved) {
  const ids = command('docker', [
    'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
  ]).split('\n').filter(Boolean);
  const inspected = ids.length === 0
    ? []
    : JSON.parse(command('docker', ['inspect', ...ids]));
  return inspected.map((container) => {
    const name = container.Config.Labels['com.docker.compose.service'];
    const expected = resolved.services[name];
    assert.ok(expected, `unexpected service ${name}`);
    const expectedNetworks = Object.keys(expected.networks ?? {}).map(
      (logical) => resolved.networks[logical].name).sort();
    const dockerNetworks = Object.keys(container.NetworkSettings.Networks ?? {}).sort();
    const dockerNetworkMode = container.HostConfig.NetworkMode;
    const actualNetworks = expected.network_mode === 'none' && dockerNetworkMode === 'none'
      ? []
      : dockerNetworks;
    const expectedMounts = (expected.volumes ?? []).map((mount) => mount.target).sort();
    const actualMounts = container.Mounts
      .filter((mount) => mount.Type === 'bind')
      .map((mount) => mount.Destination).sort();
    return {
      name,
      containerId: container.Id,
      hostPid: container.State.Pid,
      status: container.State.Status,
      exitCode: container.State.ExitCode,
      expectedNetworks,
      actualNetworks,
      dockerNetworks,
      dockerNetworkMode,
      expectedMounts,
      actualMounts,
      networkMatch: JSON.stringify(expectedNetworks) === JSON.stringify(actualNetworks),
      mountMatch: JSON.stringify(expectedMounts) === JSON.stringify(actualMounts),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function audit(receipt) {
  const acceptance = protocol.acceptance;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification,
    'selected-mode-r-application-lifecycle-development');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.failure, null);
  assert.ok(receipt.prepare !== null, 'missing prepare-stage result');
  assert.ok(receipt.recovery !== null, 'missing recovery-stage result');
  assert.ok(receipt.offlineVerification !== null,
    'missing offline-verification result');
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.prepare.firstTurn, acceptance.firstTurn);
  assert.equal(receipt.prepare.firstPhase, acceptance.firstPhase);
  assert.equal(receipt.prepare.pausedState, acceptance.pausedState);
  assert.equal(receipt.recovery.recoveredState, acceptance.recoveredState);
  assert.equal(receipt.recovery.recoveredTurn, acceptance.recoveredTurn);
  assert.equal(receipt.recovery.resumedState, acceptance.resumedState);
  assert.equal(receipt.recovery.secondTurn, acceptance.secondTurn);
  assert.equal(receipt.recovery.secondPhase, acceptance.secondPhase);
  assert.equal(receipt.recovery.evaluationTurn, acceptance.evaluationTurn);
  assert.equal(receipt.recovery.evaluationPhase, acceptance.evaluationPhase);
  assert.equal(receipt.recovery.finalState, acceptance.finalState);
  assert.equal(receipt.recovery.finalTurn, acceptance.finalTurn);
  assert.equal(receipt.recovery.auditEntryCount, acceptance.auditEntryCount);
  for (const reason of acceptance.requiredCheckpointReasons) {
    assert.ok(receipt.recovery.checkpointReasons.includes(reason),
      `missing checkpoint reason ${reason}`);
  }
  for (const type of acceptance.requiredInterventionTypes) {
    assert.ok(receipt.recovery.interventionTypes.includes(type),
      `missing intervention type ${type}`);
  }
  assert.equal(receipt.summary.recreatedServiceIdentityChanges,
    acceptance.recreatedServiceIdentityChanges);
  assert.equal(receipt.summary.persistentServiceIdentityChanges,
    acceptance.persistentServiceIdentityChanges);
  assert.equal(receipt.summary.serviceCount, acceptance.serviceCount);
  assert.equal(receipt.summary.networkMismatchCount, acceptance.networkMismatchCount);
  assert.equal(receipt.summary.mountMismatchCount, acceptance.mountMismatchCount);
  assert.equal(receipt.offlineVerification.exitCode,
    acceptance.offlineVerifierExitCode);
  assert.equal(receipt.summary.unexpectedRunningAfterTeardown,
    acceptance.unexpectedRunningAfterTeardown);
  assert.equal(receipt.passed, true);
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log('selected application lifecycle development receipt valid; B12 remains open');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'lifecycle collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'lifecycle evidence is single-use');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
assert.equal(protocol.b12Closed, false);
assert.equal(sha256(protocol.prerequisite.path), protocol.prerequisite.sha256);
assert.equal(sha256(protocol.authorityGraph.path), protocol.authorityGraph.sha256);
assert.equal(sha256(protocol.compose.basePath), protocol.compose.baseSha256);
assert.equal(sha256(protocol.compose.overlayPath), protocol.compose.overlaySha256);

const unresolvedConfig = buildRunConfig({
  runId: protocol.runId,
  experimentId: 'E02',
  randomSeed: 'selected-application-lifecycle-development-v2',
  deploymentMode: 'research-grade',
  babyA: {
    track: 'no-learning',
    modelRef: 'selected-application-no-learning',
    trainingIsolation: 'independent',
  },
  babyB: {
    track: 'no-learning',
    modelRef: 'selected-application-no-learning',
    trainingIsolation: 'independent',
  },
  learningSignal: 'none',
  communicationCondition: 'normal',
  maxTurnsPerRun: protocol.execution.trainingTurns,
  evaluationTurns: protocol.execution.evaluationTurns,
  checkpointEventInterval: protocol.execution.checkpointEventInterval,
  protocolGitCommit: commit,
});
const tracks = [...new Set([
  unresolvedConfig.babyA.track,
  unresolvedConfig.babyB.track,
])];
const scenario = new ReferentialScenarioEngine({
  version: 1,
  symbolInventory: fixedTokenInventory(unresolvedConfig.symbolInventorySize ?? 32),
  interactionMode: unresolvedConfig.interactionMode,
  heldOutTypeCodes: unresolvedConfig.interventionPlan?.heldOutTypeCodes ?? [],
}, unresolvedConfig.randomSeed);
const runConfig = {
  ...unresolvedConfig,
  promptBundleHash: promptBundleHash(
    tracks.map((track) => loadLearnerContract(track)),
  ),
  scenarioBundleHash: scenario.bundleHash,
};

const directories = [
  'config', 'evidence', 'gateway-state', 'output',
  'runtime/model-a', 'runtime/model-b', 'runtime/public-keys',
  ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness']
    .map((domain) => `runtime/signers/${domain}`),
  ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit']
    .map((name) => `runtime/evidence-${name}`),
  'runtime/gateway-controller', 'runtime/gateway-baby-a',
  'runtime/gateway-baby-b', 'runtime/checkpoint-service',
  'runtime/anchor-service', 'runtime/audit-service',
];
for (const directory of directories) {
  mkdirSync(join(evidenceRoot, directory), { recursive: true, mode: 0o700 });
}
writeFileSync(join(evidenceRoot, 'config/run-config.json'),
  `${JSON.stringify(runConfig, null, 2)}\n`, { mode: 0o600 });

const startedAt = new Date().toISOString();
let failure;
let resolved;
let firstObservations = [];
let secondObservations = [];
let resources = [];
let prepare;
let recovery;
let offlineVerification;
try {
  compose('prepare-recovery', 'build');
  resolved = JSON.parse(compose('prepare-recovery', 'config', '--format', 'json'));
  compose('prepare-recovery', 'up', '-d', 'controller-scenario');
  const firstTerminal = await waitForServiceExit('controller-scenario');
  assert.equal(firstTerminal.exitCode, 0, 'prepare controller failed');
  firstObservations = snapshot(resolved);
  prepare = readJson(join(evidenceRoot, 'output/controller-prepare-result.json'));

  compose('recover', 'rm', '--stop', '--force',
    ...protocol.execution.recreatedServices);
  compose('recover', 'up', '-d', '--no-deps', 'model-adapter-a', 'model-adapter-b');
  compose('recover', 'up', '-d', '--no-deps', 'baby-a', 'baby-b');
  compose('recover', 'up', '-d', '--no-deps', 'gateway');
  compose('recover', 'up', '-d', '--no-deps', 'controller-scenario');
  const secondTerminal = await waitForServiceExit('controller-scenario');
  assert.equal(secondTerminal.exitCode, 0, 'recovery controller failed');
  compose('recover', 'up', '-d', '--no-deps', 'offline-verifier');
  const verifierTerminal = await waitForServiceExit('offline-verifier');
  assert.equal(verifierTerminal.exitCode, 0, 'offline verifier failed');
  secondObservations = snapshot(resolved);
  recovery = readJson(join(evidenceRoot, 'output/controller-recovery-result.json'));
  offlineVerification = readJson(join(evidenceRoot, 'output/offline-verification.json'));
  const runningIds = secondObservations
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.containerId);
  if (runningIds.length > 0) {
    resources = command('docker', [
      'stats', '--no-stream', '--format', '{{json .}}', ...runningIds,
    ]).split('\n').filter(Boolean).map(JSON.parse);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    writeFileSync(join(evidenceRoot, 'compose-logs.txt'),
      `${compose('recover', 'logs', '--no-color')}\n`, { mode: 0o600 });
  } catch {}
  try { compose('recover', 'down', '--remove-orphans'); } catch {}
}

const remaining = command('docker', [
  'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
]).split('\n').filter(Boolean);
const firstByName = new Map(firstObservations.map((entry) => [entry.name, entry]));
const secondByName = new Map(secondObservations.map((entry) => [entry.name, entry]));
const identityChanges = (names) => names.filter((name) =>
  firstByName.get(name)?.containerId !== secondByName.get(name)?.containerId).length;
const summary = {
  firstServiceCount: firstObservations.length,
  serviceCount: secondObservations.length,
  recreatedServiceIdentityChanges: identityChanges(protocol.execution.recreatedServices),
  persistentServiceIdentityChanges: identityChanges(protocol.execution.persistentServices),
  networkMismatchCount: secondObservations.filter((entry) => !entry.networkMatch).length,
  mountMismatchCount: secondObservations.filter((entry) => !entry.mountMatch).length,
  unexpectedRunningAfterTeardown: remaining.length,
};
const lifecycleMatches = prepare !== undefined && recovery !== undefined &&
  offlineVerification !== undefined &&
  prepare.firstTurn === protocol.acceptance.firstTurn &&
  prepare.firstPhase === protocol.acceptance.firstPhase &&
  prepare.pausedState === protocol.acceptance.pausedState &&
  recovery.recoveredState === protocol.acceptance.recoveredState &&
  recovery.recoveredTurn === protocol.acceptance.recoveredTurn &&
  recovery.resumedState === protocol.acceptance.resumedState &&
  recovery.secondTurn === protocol.acceptance.secondTurn &&
  recovery.secondPhase === protocol.acceptance.secondPhase &&
  recovery.evaluationTurn === protocol.acceptance.evaluationTurn &&
  recovery.evaluationPhase === protocol.acceptance.evaluationPhase &&
  recovery.finalState === protocol.acceptance.finalState &&
  recovery.finalTurn === protocol.acceptance.finalTurn &&
  recovery.auditEntryCount === protocol.acceptance.auditEntryCount &&
  protocol.acceptance.requiredCheckpointReasons.every((reason) =>
    recovery.checkpointReasons.includes(reason)) &&
  protocol.acceptance.requiredInterventionTypes.every((type) =>
    recovery.interventionTypes.includes(type));
const passed = failure === undefined &&
  lifecycleMatches &&
  summary.recreatedServiceIdentityChanges ===
    protocol.acceptance.recreatedServiceIdentityChanges &&
  summary.persistentServiceIdentityChanges === 0 &&
  summary.serviceCount === protocol.acceptance.serviceCount &&
  summary.networkMismatchCount === 0 && summary.mountMismatchCount === 0 &&
  offlineVerification.exitCode === 0 && remaining.length === 0;
const receipt = {
  schemaVersion: 1,
  classification: 'selected-mode-r-application-lifecycle-development',
  researchFinding: false,
  b12Closed: false,
  publicChainTransaction: false,
  externalSpendingUsd: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  runId: protocol.runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  firstObservations,
  secondObservations,
  resources,
  prepare: prepare ?? null,
  recovery: recovery ?? null,
  offlineVerification: offlineVerification ?? null,
  summary,
  failure: failure ?? null,
  passed,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
audit(receipt);
console.log('selected application lifecycle development execution passed; B12 remains open');
