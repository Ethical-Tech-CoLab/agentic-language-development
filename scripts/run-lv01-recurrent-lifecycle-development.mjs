import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { deriveSeedHex } from '@ald/hashing';
import { loadLearnerContract, promptBundleHash, RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

const mode = process.argv[2];
const version = process.argv[3] ?? '1';
assert.ok(mode === '--run' || mode === '--audit', 'expected --run or --audit');
assert.match(version, /^[1-9]\d*$/u, 'expected a positive protocol version');
const runMode = mode === '--run';
const protocolPath = `protocols/lv01-recurrent-lifecycle-development.v${version}.json`;
const protocol = readJson(protocolPath);
assert.equal(String(protocol.version), version, 'protocol version does not match the requested version');
const evidenceRoot = `evidence/lv01/recurrent-lifecycle-v${version}/${protocol.runId}`;
const receiptPath = join(evidenceRoot, 'receipt.json');
const baseComposePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const overlayComposePath = 'deploy/mode-r/docker-compose.application-lifecycle.v1.yml';
const project = `ald-lv01-recurrent-lifecycle-v${version}`;
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
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function sourceSha256(commitId, path) {
  return `sha256:${createHash('sha256').update(
    execFileSync('git', ['show', `${commitId}:${path}`]),
  ).digest('hex')}`;
}

function unlinkOwnedSocket(relativePath) {
  assert.match(relativePath, /^runtime\/[a-z0-9-]+\/[a-z0-9.-]+$/u);
  const path = join(evidenceRoot, relativePath);
  try {
    const target = lstatSync(path);
    assert.equal(target.isSocket(), true, `${relativePath} is not a socket`);
    assert.equal(target.isSymbolicLink(), false, `${relativePath} is a symlink`);
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
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

async function waitForServiceLog(name, marker, timeoutMs = 60_000) {
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
      assert.equal(inspected.State.Status, 'running',
        `${name} exited before reporting ${marker}`);
      if (command('docker', ['logs', ids[0]]).split('\n').includes(marker)) return;
    }
    await delay(250);
  }
  throw new Error(`${name} did not report ${marker} within ${String(timeoutMs)} ms`);
}

function snapshot(resolved) {
  const ids = command('docker', [
    'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
  ]).split('\n').filter(Boolean);
  const inspected = ids.length === 0 ? [] : JSON.parse(command('docker', ['inspect', ...ids]));
  return inspected.map((container) => {
    const name = container.Config.Labels['com.docker.compose.service'];
    const expected = resolved.services[name];
    assert.ok(expected, `unexpected service ${name}`);
    const expectedNetworks = Object.keys(expected.networks ?? {}).map(
      (logical) => resolved.networks[logical].name).sort();
    const dockerNetworks = Object.keys(container.NetworkSettings.Networks ?? {}).sort();
    const actualNetworks = expected.network_mode === 'none' && container.HostConfig.NetworkMode === 'none'
      ? [] : dockerNetworks;
    const expectedMounts = (expected.volumes ?? []).map((mount) => mount.target).sort();
    const actualMounts = container.Mounts.filter((mount) => mount.Type === 'bind')
      .map((mount) => mount.Destination).sort();
    return {
      name,
      containerId: container.Id,
      hostPid: container.State.Pid,
      status: container.State.Status,
      expectedNetworks,
      actualNetworks,
      expectedMounts,
      actualMounts,
      networkMatch: JSON.stringify(expectedNetworks) === JSON.stringify(actualNetworks),
      mountMatch: JSON.stringify(expectedMounts) === JSON.stringify(actualMounts),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function policyObservation() {
  const roles = ['baby-a', 'baby-b'];
  return Object.fromEntries(roles.map((role) => {
    const initialPath = join(evidenceRoot, 'output', 'bundle', 'policies', `${role}-policy-initial.json`);
    const latestPath = join(evidenceRoot, 'output', 'bundle', 'policies', `${role}-latest.json`);
    const initial = readJson(initialPath);
    const latest = readJson(latestPath);
    return [role, {
      initialPolicySha256: sha256(initialPath),
      latestPolicySha256: sha256(latestPath),
      architecture: initial.model.architecture,
      parameterCount: initial.model.parameterCount,
      initialUpdateCount: initial.model.updateCount,
      finalUpdateCount: latest.model.updateCount,
    }];
  }));
}

function audit(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'lv01-recurrent-selected-lifecycle-development');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.failure, null);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.prepare.firstTurn, protocol.acceptance.firstTurn);
  assert.equal(receipt.prepare.pausedState, protocol.acceptance.pausedState);
  assert.equal(receipt.recovery.recoveredTurn, protocol.acceptance.recoveredTurn);
  assert.equal(receipt.recovery.secondTurn, protocol.acceptance.secondTurn);
  assert.equal(receipt.recovery.evaluationTurn, protocol.acceptance.evaluationTurn);
  assert.equal(receipt.recovery.finalState, protocol.acceptance.finalState);
  assert.equal(receipt.recovery.finalTurn, protocol.acceptance.finalTurn);
  assert.equal(receipt.offlineVerification.exitCode, 0);
  assert.equal(receipt.summary.recreatedServiceIdentityChanges,
    protocol.acceptance.recreatedServiceIdentityChanges);
  assert.equal(receipt.summary.persistentServiceIdentityChanges, 0);
  assert.equal(receipt.summary.staleOwnedSocketsRemoved, protocol.acceptance.staleOwnedSocketsRemoved);
  assert.equal(receipt.summary.serviceCount, protocol.acceptance.serviceCount);
  assert.equal(receipt.summary.networkMismatchCount, 0);
  assert.equal(receipt.summary.mountMismatchCount, 0);
  assert.equal(receipt.summary.unexpectedRunningAfterTeardown, 0);
  for (const role of ['baby-a', 'baby-b']) {
    const observed = receipt.policies[role];
    assert.equal(observed.architecture, RECURRENT_ARCHITECTURE);
    assert.equal(observed.parameterCount, protocol.acceptance.parameterCount);
    assert.equal(observed.initialUpdateCount, 0);
    assert.equal(observed.finalUpdateCount, protocol.acceptance.finalUpdateCount);
    assert.notEqual(observed.initialPolicySha256, observed.latestPolicySha256,
      `${role} policy did not change across the recurrent restart fixture`);
  }
  assert.equal(receipt.passed, true);
  return receipt;
}

function verifyProtocol() {
  assert.equal(protocol.schemaVersion, 1);
  assert.equal(protocol.classification, 'lv01-recurrent-selected-lifecycle-development-protocol');
  assert.equal(protocol.status, 'design-locked-not-executed');
  assert.equal(protocol.researchFinding, false);
  assert.equal(protocol.scientificDisposition, 'not-tested');
  assert.equal(protocol.externalSpend, 0);
  assert.equal(protocol.publicChainTransaction, false);
  assert.equal(command('git', ['rev-parse', `${protocol.sourceFreeze.commit}^{tree}`]),
    protocol.sourceFreeze.tree);
  for (const artifact of protocol.sourceFreeze.artifacts) {
    assert.equal(sourceSha256(protocol.sourceFreeze.commit, artifact.path), artifact.sha256,
      `source freeze changed for ${artifact.path}`);
  }
  const slot = protocol.seedDerivation.slot;
  for (const purpose of protocol.seedDerivation.purposes) {
    const property = purpose === 'learner/baby-a' ? 'babyA'
      : purpose === 'learner/baby-b' ? 'babyB' : purpose;
    assert.equal(slot[property], deriveSeedHex(protocol.seedDerivation.root,
      ...protocol.seedDerivation.parts.map((part) => part === 'purpose' ? purpose : part)));
  }
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log('LV01 recurrent selected-lifecycle receipt is valid; broader H07 remains open');
  process.exit(0);
}

verifyProtocol();
assert.equal(command('git', ['status', '--porcelain']), '',
  'recurrent lifecycle collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'recurrent lifecycle evidence is single-use');

const slot = protocol.seedDerivation.slot;
const base = buildRunConfig({
  runId: protocol.runId,
  experimentId: 'LV01',
  randomSeed: slot.scenario,
  seedBindings: { version: 1, scenario: slot.scenario, babyA: slot.babyA, babyB: slot.babyB,
    gateway: slot.gateway, analysis: slot.analysis },
  deploymentMode: 'research-grade',
  registrationClass: 'qualification',
  babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
  babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
  learningSignal: 'extrinsic-task',
  communicationCondition: 'normal',
  maxTurnsPerRun: protocol.execution.trainingTurns,
  evaluationTurns: protocol.execution.evaluationTurns,
  evaluationSeeds: 1,
  turnResponseBudgetMs: 1_000,
  checkpointEventInterval: 1,
  checkpointTimeIntervalMs: 300_000,
  protocolGitCommit: commit,
  interventionPlan: { version: 1, heldOutTypeCodes: [0, 5, 10, 15] },
  ledgerValuePlan: protocol.ledgerValuePlan,
});
const scenario = new ReferentialScenarioEngine({
  version: 1,
  symbolInventory: fixedTokenInventory(32),
  interactionMode: base.interactionMode,
  heldOutTypeCodes: [0, 5, 10, 15],
}, base.randomSeed);
const runConfig = {
  ...base,
  promptBundleHash: promptBundleHash([loadLearnerContract('scratch-rl')]),
  scenarioBundleHash: scenario.bundleHash,
};
for (const directory of [
  'config', 'evidence', 'gateway-state', 'output',
  'runtime/model-a', 'runtime/model-b', 'runtime/public-keys',
  ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness']
    .map((domain) => `runtime/signers/${domain}`),
  ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit']
    .map((name) => `runtime/evidence-${name}`),
  'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b',
  'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service',
]) mkdirSync(join(evidenceRoot, directory), { recursive: true, mode: 0o700 });
writeFileSync(join(evidenceRoot, 'config', 'run-config.json'), `${JSON.stringify(runConfig, null, 2)}\n`,
  { mode: 0o600 });

const startedAt = new Date().toISOString();
let failure;
let resolved;
let firstObservations = [];
let secondObservations = [];
let prepare;
let recovery;
let offlineVerification;
let policies;
let staleOwnedSocketsRemoved = 0;
try {
  compose('prepare-recovery', 'build');
  resolved = JSON.parse(compose('prepare-recovery', 'config', '--format', 'json'));
  compose('prepare-recovery', 'up', '-d', 'controller-scenario');
  assert.equal((await waitForServiceExit('controller-scenario')).exitCode, 0,
    'prepare controller failed');
  firstObservations = snapshot(resolved);
  prepare = readJson(join(evidenceRoot, 'output', 'controller-prepare-result.json'));

  compose('recover', 'rm', '--stop', '--force', ...protocol.execution.recreatedServices);
  staleOwnedSocketsRemoved = protocol.execution.staleOwnedSocketPaths
    .filter((path) => unlinkOwnedSocket(path)).length;
  compose('recover', 'up', '-d', '--no-deps', 'model-adapter-a', 'model-adapter-b');
  compose('recover', 'up', '-d', '--no-deps', 'baby-a', 'baby-b');
  compose('recover', 'up', '-d', '--no-deps', 'gateway');
  await waitForServiceLog('gateway', protocol.execution.replacementGatewayReadyLog);
  compose('recover', 'up', '-d', '--no-deps', 'controller-scenario');
  assert.equal((await waitForServiceExit('controller-scenario')).exitCode, 0,
    'recovery controller failed');
  compose('recover', 'up', '-d', '--no-deps', 'offline-verifier');
  assert.equal((await waitForServiceExit('offline-verifier')).exitCode, 0,
    'offline verifier failed');
  secondObservations = snapshot(resolved);
  recovery = readJson(join(evidenceRoot, 'output', 'controller-recovery-result.json'));
  offlineVerification = readJson(join(evidenceRoot, 'output', 'offline-verification.json'));
  policies = policyObservation();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    writeFileSync(join(evidenceRoot, 'compose-logs.txt'), `${compose('recover', 'logs', '--no-color')}\n`,
      { mode: 0o600 });
  } catch {}
  try { compose('recover', 'down', '--remove-orphans'); } catch {}
}

const remaining = command('docker', [
  'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
]).split('\n').filter(Boolean);
const byName = (observations) => new Map(observations.map((entry) => [entry.name, entry]));
const firstByName = byName(firstObservations);
const secondByName = byName(secondObservations);
const identityChanges = (names) => names.filter((name) => {
  const first = firstByName.get(name)?.containerId;
  const second = secondByName.get(name)?.containerId;
  return first !== undefined && second !== undefined && first !== second;
}).length;
const summary = {
  firstServiceCount: firstObservations.length,
  serviceCount: secondObservations.length,
  recreatedServiceIdentityChanges: identityChanges(protocol.execution.recreatedServices),
  persistentServiceIdentityChanges: identityChanges(protocol.execution.persistentServices),
  staleOwnedSocketsRemoved,
  networkMismatchCount: secondObservations.filter((entry) => !entry.networkMatch).length,
  mountMismatchCount: secondObservations.filter((entry) => !entry.mountMatch).length,
  unexpectedRunningAfterTeardown: remaining.length,
};
const passed = failure === undefined && prepare !== undefined && recovery !== undefined &&
  offlineVerification !== undefined && policies !== undefined &&
  recovery.finalState === protocol.acceptance.finalState &&
  recovery.finalTurn === protocol.acceptance.finalTurn &&
  summary.recreatedServiceIdentityChanges === protocol.acceptance.recreatedServiceIdentityChanges &&
  summary.persistentServiceIdentityChanges === 0 &&
  summary.staleOwnedSocketsRemoved === protocol.acceptance.staleOwnedSocketsRemoved &&
  summary.serviceCount === protocol.acceptance.serviceCount &&
  summary.networkMismatchCount === 0 && summary.mountMismatchCount === 0 &&
  offlineVerification.exitCode === 0 && remaining.length === 0;
const receipt = {
  schemaVersion: 1,
  classification: 'lv01-recurrent-selected-lifecycle-development',
  researchFinding: false,
  scientificDisposition: 'not-tested',
  publicChainTransaction: false,
  externalSpend: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  runId: protocol.runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  firstObservations,
  secondObservations,
  prepare: prepare ?? null,
  recovery: recovery ?? null,
  offlineVerification: offlineVerification ?? null,
  policies: policies ?? null,
  summary,
  failure: failure ?? null,
  passed,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
if (passed) {
  audit(receipt);
  console.log('LV01 recurrent selected-lifecycle development execution passed; broader H07 remains open');
} else {
  throw new Error(`LV01 recurrent lifecycle fixture failed: ${receipt.failure ?? 'acceptance mismatch'}`);
}
