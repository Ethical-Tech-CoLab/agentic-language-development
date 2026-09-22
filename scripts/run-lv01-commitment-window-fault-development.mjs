import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createLv01PairedCasePlan } from '@ald/orchestrator';

const mode = process.argv[2];
const version = process.argv[3] ?? '1';
assert.ok(mode === '--run' || mode === '--check', 'usage: run-lv01-commitment-window-fault-development.mjs --run|--check');
assert.match(version, /^[1-9]\d*$/u, 'packet version must be positive');
const packetPath = `protocols/lv01-commitment-window-fault-development.v${version}.json`;
const packet = existsSync(packetPath) ? JSON.parse(readFileSync(packetPath, 'utf8')) : null;
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const command = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', ...options }).trim();

function requirePacket() {
  assert.ok(packet !== null, `missing ${packetPath}`);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.classification, 'lv01-commitment-window-fault-development');
  assert.equal(packet.status, 'design-locked-not-executed');
  assert.equal(packet.researchFinding, false);
  assert.equal(packet.externalSpend, 0);
  assert.match(packet.childRunIdPrefix, /^[a-z0-9-]+$/u);
  assert.match(packet.parent.checkpointHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(sha256(packet.parent.configPath), packet.parent.configSha256);
  assert.equal(sha256(packet.parent.bundleManifestPath), packet.parent.bundleManifestSha256);
  assert.equal(command('git', ['rev-parse', `${packet.sourceFreeze.commit}^{tree}`]), packet.sourceFreeze.tree);
  for (const artifact of packet.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${artifact.path}`]);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.sha256);
    assert.equal(sha256(artifact.path), artifact.sha256, `working source differs from frozen ${artifact.path}`);
  }
}

function directories(root) {
  for (const relative of [
    'config', 'evidence', 'gateway-state', 'output', 'runtime/model-a', 'runtime/model-b', 'runtime/public-keys',
    ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness'].map((name) => `runtime/signers/${name}`),
    ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit'].map((name) => `runtime/evidence-${name}`),
    'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b',
    'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service',
  ]) mkdirSync(join(root, relative), { recursive: true, mode: 0o700 });
}

function projectContainer(service) {
  const ids = command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${packet.project}`, '--filter', `label=com.docker.compose.service=${service}`]).split('\n').filter(Boolean);
  assert.equal(ids.length, 1, `${service} container count`);
  return ids[0];
}

async function waitFor(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(service, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = JSON.parse(command('docker', ['inspect', projectContainer(service)]))[0];
    if (inspected.State.Status === 'exited') return { containerId: inspected.Id, exitCode: inspected.State.ExitCode, oomKilled: inspected.State.OOMKilled };
    await delay(250);
  }
  throw new Error(`${service} did not exit`);
}

requirePacket();
const root = packet.evidenceRoot;
if (mode === '--check') {
  assert.equal(existsSync(root), false, 'single-use fault evidence already exists; audit its retained receipt instead');
  console.log('LV01 commitment-window fault packet is configured but unexecuted');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '', 'fault collection requires a clean committed source tree');
assert.equal(existsSync(root), false, 'fault evidence is single-use');
mkdirSync(root, { recursive: true, mode: 0o700 });
const parent = JSON.parse(readFileSync(packet.parent.configPath, 'utf8'));
const plan = createLv01PairedCasePlan({
  parent,
  parentCheckpointHash: packet.parent.checkpointHash,
  babyAInitialPolicyRef: packet.parent.babyAInitialPolicyRef,
  babyBInitialPolicyRef: packet.parent.babyBInitialPolicyRef,
  childRunIdPrefix: packet.childRunIdPrefix,
});
const child = plan.branches[0];
assert.ok(child !== undefined && child.branch === 'normal');
assert.equal(child.config.runId, packet.childRunId);
directories(root);
const parentBundle = packet.parent.bundlePath;
const parentTarget = join(root, 'output', 'bundles', 'runs', parent.runId);
cpSync(parentBundle, parentTarget, { recursive: true, errorOnExist: true });
assert.equal(sha256(join(parentTarget, 'run-manifest.json')), packet.parent.bundleManifestSha256);
writeFileSync(join(root, 'config', 'run-config.json'), `${JSON.stringify(child.config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

const env = (stage) => ({ ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(root), ALD_SOFTWARE_COMMIT: command('git', ['rev-parse', 'HEAD']),
  ALD_MODE_R_RUN_ID: child.config.runId, ALD_MODE_R_CONTROLLER_STAGE: stage,
  ALD_MODE_R_PARENT_BUNDLE: `/output/bundles/runs/${parent.runId}`,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000), ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
  ALD_MODE_R_BABY_A_SUBNET: packet.networkAllocation.babyA,
  ALD_MODE_R_BABY_B_SUBNET: packet.networkAllocation.babyB,
  ALD_MODE_R_CONTROL_PLANE_SUBNET: packet.networkAllocation.controlPlane,
});
const compose = (stage, args) => command('docker', ['compose', '-p', packet.project,
  '-f', 'deploy/mode-r/docker-compose.application.v1.yml', '-f', 'deploy/mode-r/docker-compose.lv01.v1.yml',
  '-f', 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml', ...args], { env: env(stage), timeout: 600_000 });

let failure = null;
let stopped = null;
let recovery = null;
try {
  compose('lv01-commitment-window-fault', ['build']);
  compose('lv01-commitment-window-fault', ['up', '-d', 'controller-scenario']);
  await waitFor(join(root, 'output', 'lv01-commitment-window-ready.json'));
  const controller = projectContainer('controller-scenario');
  command('docker', ['kill', controller]);
  stopped = await waitForExit('controller-scenario');
  assert.notEqual(stopped.exitCode, 0, 'fault controller must be terminated');
  compose('lv01-commitment-window-recover', ['up', '-d', '--no-deps', 'controller-scenario']);
  const replacement = await waitForExit('controller-scenario');
  assert.equal(replacement.exitCode, 0, 'replacement controller must record refusal successfully');
  recovery = JSON.parse(readFileSync(join(root, 'output', 'lv01-commitment-window-recovery.json'), 'utf8'));
  assert.equal(recovery.recoveryError?.name, 'IncompleteTurnEvidenceError');
  assert.equal(recovery.evidenceCounts.turns, 0);
  assert.ok(recovery.evidenceCounts.channel >= 1);
  assert.ok(recovery.evidenceCounts.intervention >= 1);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try { writeFileSync(join(root, 'compose-logs.txt'), `${compose('lv01-commitment-window-recover', ['logs', '--no-color'])}\n`, { mode: 0o600 }); } catch {}
  try { compose('lv01-commitment-window-recover', ['down', '--remove-orphans']); } catch {}
}
const remaining = command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${packet.project}`]).split('\n').filter(Boolean).length;
const receipt = {
  schemaVersion: 1, classification: 'lv01-commitment-window-fault-development', researchFinding: false,
  scientificDisposition: 'not-tested', externalSpend: 0, executionCommit: command('git', ['rev-parse', 'HEAD']),
  protocolSha256: sha256(packetPath), childRunId: child.config.runId, parentRunId: parent.runId,
  stopped, recovery, remainingContainers: remaining, failure, passed: failure === null && remaining === 0,
  claimBoundary: 'One selected-topology controller-loss qualification after a durable LV01 paired prediction commitment. It is not a pilot or behavioral result.',
};
writeFileSync(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
assert.equal(receipt.passed, true, receipt.failure ?? 'fault receipt acceptance failed');
console.log('LV01 commitment-window fault qualification passed; no research finding');
