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

import { loadLearnerContract, promptBundleHash } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

const mode = process.argv[2];
assert.ok(/^--(?:run|audit)-v[1-5]$/u.test(mode ?? ''),
  'expected a --run-vN or --audit-vN mode for N=1..5');
const version = Number(mode.at(-1));
const runMode = mode.startsWith('--run');
const protocolPath = `protocols/mode-r-application-development.v${String(version)}.json`;
const evidenceRoot = `evidence/mode-r-application-development-v${String(version)}`;
const receiptPath = join(evidenceRoot, 'receipt.json');
const composePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const project = `ald-mode-r-application-development-v${String(version)}`;
const protocol = readJson(protocolPath);
const commit = command('git', ['rev-parse', 'HEAD']);
const environment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(evidenceRoot),
  ALD_SOFTWARE_COMMIT: commit,
  ALD_MODE_R_RUN_ID: protocol.runId,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000),
  ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
};
const compose = (...args) => command('docker', [
  'compose', '-p', project, '-f', composePath, ...args,
], { env: environment, timeout: 600_000 });

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function audit(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification,
    'selected-mode-r-application-development-execution');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendingUsd, 0);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.authorityGraphSha256, protocol.authorityGraph.sha256);
  assert.equal(receipt.composeSha256, protocol.compose.sha256);
  assert.equal(receipt.summary.serviceCount, protocol.acceptance.serviceCount);
  assert.equal(receipt.summary.networkCount, protocol.acceptance.networkCount);
  assert.equal(receipt.summary.distinctContainerIdCount,
    protocol.acceptance.distinctContainerIdCount);
  assert.ok(receipt.summary.distinctHostPidCount >=
    protocol.acceptance.distinctHostPidCount);
  assert.equal(receipt.summary.networkMismatchCount, 0);
  assert.equal(receipt.summary.mountMismatchCount, 0);
  assert.equal(receipt.summary.unexpectedRunningAfterTeardown, 0);
  assert.deepEqual(receipt.controller.turns, [0, 1]);
  assert.equal(receipt.controller.auditEntryCount, 1);
  assert.equal(receipt.offlineVerification.exitCode, 0);
  assert.equal(receipt.passed, true);
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log('selected application development receipt valid; B12 remains open');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'application collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'application evidence is single-use');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
assert.equal(protocol.b12Closed, false);
assert.equal(sha256(protocol.authorityGraph.path), protocol.authorityGraph.sha256);
assert.equal(sha256(protocol.compose.path), protocol.compose.sha256);

const unresolvedConfig = buildRunConfig({
  runId: protocol.runId,
  experimentId: 'E02',
  randomSeed: `selected-application-development-v${String(version)}`,
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
  maxTurnsPerRun: 2,
  evaluationTurns: 1,
  checkpointEventInterval: 1,
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

let failure;
let observations = [];
let resources = [];
let controller;
let offlineVerification;
let resolved;
try {
  compose('build');
  resolved = JSON.parse(compose('config', '--format', 'json'));
  compose('up', '-d');
  try {
    compose('wait', 'controller-scenario');
    compose('wait', 'offline-verifier');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const serviceNames = Object.keys(resolved.services).sort();
  const ids = compose('ps', '--all', '--quiet').split('\n').filter(Boolean);
  const inspectedContainers = ids.length === 0
    ? []
    : JSON.parse(command('docker', ['inspect', ...ids]));
  const containersByService = new Map(inspectedContainers.map((container) => [
    container.Config.Labels['com.docker.compose.service'],
    container,
  ]));
  observations = serviceNames.map((name) => {
    const inspected = containersByService.get(name);
    assert.ok(inspected, `${name} has no container`);
    const expected = resolved.services[name];
    const expectedNetworks = Object.keys(expected.networks ?? {}).map(
      (logical) => resolved.networks[logical].name).sort();
    const actualNetworks = Object.keys(inspected.NetworkSettings.Networks ?? {}).sort();
    const expectedMounts = (expected.volumes ?? []).map((mount) => mount.target).sort();
    const actualMounts = inspected.Mounts
      .filter((mount) => mount.Type === 'bind')
      .map((mount) => mount.Destination).sort();
    return {
      name,
      containerId: inspected.Id,
      hostPid: inspected.State.Pid,
      status: inspected.State.Status,
      exitCode: inspected.State.ExitCode,
      expectedNetworks,
      actualNetworks,
      expectedMounts,
      actualMounts,
      networkMatch: JSON.stringify(expectedNetworks) === JSON.stringify(actualNetworks),
      mountMatch: JSON.stringify(expectedMounts) === JSON.stringify(actualMounts),
    };
  });
  const runningIds = observations
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.containerId);
  if (runningIds.length > 0) {
    resources = command('docker', [
      'stats', '--no-stream', '--format', '{{json .}}', ...runningIds,
    ]).split('\n').filter(Boolean).map(JSON.parse);
  }
  if (failure === undefined) {
    controller = readJson(join(evidenceRoot, 'output/controller-result.json'));
    offlineVerification = readJson(join(evidenceRoot, 'output/offline-verification.json'));
  }
} catch (error) {
  failure ??= error instanceof Error ? error.message : String(error);
} finally {
  try {
    writeFileSync(join(evidenceRoot, 'compose-logs.txt'),
      `${compose('logs', '--no-color')}\n`, { mode: 0o600 });
  } catch {}
  try { compose('down', '--remove-orphans'); } catch {}
}

const remaining = command('docker', [
  'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
]).split('\n').filter(Boolean);
const networkMismatchCount = observations.filter((entry) => !entry.networkMatch).length;
const mountMismatchCount = observations.filter((entry) => !entry.mountMatch).length;
const summary = {
  serviceCount: observations.length,
  networkCount: resolved ? Object.keys(resolved.networks).length : 0,
  distinctContainerIdCount: new Set(observations.map((entry) => entry.containerId)).size,
  distinctHostPidCount: new Set(observations
    .map((entry) => entry.hostPid).filter((pid) => pid > 0)).size,
  networkMismatchCount,
  mountMismatchCount,
  unexpectedRunningAfterTeardown: remaining.length,
};
const passed = failure === undefined &&
  summary.serviceCount === protocol.acceptance.serviceCount &&
  summary.networkCount === protocol.acceptance.networkCount &&
  summary.distinctContainerIdCount === protocol.acceptance.distinctContainerIdCount &&
  summary.distinctHostPidCount >= protocol.acceptance.distinctHostPidCount &&
  networkMismatchCount === 0 && mountMismatchCount === 0 && remaining.length === 0 &&
  JSON.stringify(controller?.turns) === '[0,1]' && controller?.auditEntryCount === 1 &&
  offlineVerification?.exitCode === 0;
const receipt = {
  schemaVersion: 1,
  classification: 'selected-mode-r-application-development-execution',
  researchFinding: false,
  b12Closed: false,
  publicChainTransaction: false,
  externalSpendingUsd: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  authorityGraphSha256: sha256(protocol.authorityGraph.path),
  composeSha256: sha256(composePath),
  runId: protocol.runId,
  observations,
  resources,
  controller: controller ?? null,
  offlineVerification: offlineVerification ?? null,
  summary,
  failure: failure ?? null,
  passed,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
audit(receipt);
console.log('selected application development execution passed; B12 remains open');
