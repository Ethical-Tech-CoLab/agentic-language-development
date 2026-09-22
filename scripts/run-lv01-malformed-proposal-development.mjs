import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createLv01PairedCasePlan } from '@ald/orchestrator';

const [mode, version = '1'] = process.argv.slice(2);
assert.ok(mode === '--run' || mode === '--check',
  'usage: run-lv01-malformed-proposal-development.mjs --run|--check <version>');
assert.match(version, /^[1-9]\d*$/u, 'packet version must be positive');

const packetPath = `protocols/lv01-malformed-proposal-development.v${version}.json`;
const packet = existsSync(packetPath) ? JSON.parse(readFileSync(packetPath, 'utf8')) : null;
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const command = (program, args, options = {}) =>
  execFileSync(program, args, { encoding: 'utf8', ...options }).trim();

function requirePacket() {
  assert.ok(packet !== null, `missing ${packetPath}`);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.classification, 'lv01-malformed-proposal-development');
  assert.equal(packet.status, 'design-locked-not-executed');
  assert.equal(packet.researchFinding, false);
  assert.equal(packet.externalSpend, 0);
  assert.match(packet.childRunIdPrefix, /^[a-z0-9-]+$/u);
  assert.equal(sha256(packet.parent.configPath), packet.parent.configSha256);
  assert.equal(sha256(packet.parent.bundleManifestPath), packet.parent.bundleManifestSha256);
  assert.equal(command('git', ['rev-parse', `${packet.sourceFreeze.commit}^{tree}`]),
    packet.sourceFreeze.tree);
  for (const artifact of packet.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${artifact.path}`]);
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(hash, artifact.sha256, `frozen source differs for ${artifact.path}`);
    assert.equal(sha256(artifact.path), hash,
      `working source differs from frozen ${artifact.path}`);
  }
}

function directories(root) {
  for (const relative of [
    'config', 'evidence', 'gateway-state', 'output', 'runtime/model-a', 'runtime/model-b',
    'runtime/public-keys',
    ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness']
      .map((name) => `runtime/signers/${name}`),
    ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit']
      .map((name) => `runtime/evidence-${name}`),
    'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b',
    'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service',
  ]) mkdirSync(join(root, relative), { recursive: true, mode: 0o700 });
}

function composeArgs() {
  return ['compose', '-p', packet.project,
    '-f', 'deploy/mode-r/docker-compose.application.v1.yml',
    '-f', 'deploy/mode-r/docker-compose.lv01.v1.yml',
    '-f', 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml'];
}

function remainingContainers() {
  return command('docker', ['ps', '-aq', '--filter',
    `label=com.docker.compose.project=${packet.project}`]).split('\n').filter(Boolean).length;
}

requirePacket();
const root = packet.evidenceRoot;
if (mode === '--check') {
  assert.equal(existsSync(root), false,
    'single-use malformed-proposal evidence already exists; audit its retained receipt instead');
  console.log('LV01 malformed-proposal packet is configured but unexecuted');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'malformed-proposal collection requires a clean committed source tree');
assert.equal(existsSync(root), false, 'malformed-proposal evidence is single-use');
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
cpSync(packet.parent.bundlePath, join(root, 'output', 'bundles', 'runs', parent.runId), {
  recursive: true,
  errorOnExist: true,
});
writeFileSync(join(root, 'config', 'run-config.json'),
  `${JSON.stringify(child.config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

const environment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(root),
  ALD_SOFTWARE_COMMIT: command('git', ['rev-parse', 'HEAD']),
  ALD_MODE_R_RUN_ID: child.config.runId,
  ALD_MODE_R_CONTROLLER_STAGE: 'lv01-malformed-proposal',
  ALD_MODE_R_PARENT_BUNDLE: `/output/bundles/runs/${parent.runId}`,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000),
  ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
  ALD_MODE_R_BABY_A_SUBNET: packet.networkAllocation.babyA,
  ALD_MODE_R_BABY_B_SUBNET: packet.networkAllocation.babyB,
  ALD_MODE_R_CONTROL_PLANE_SUBNET: packet.networkAllocation.controlPlane,
};

let execution = null;
let failure = null;
try {
  execution = spawnSync('docker', [...composeArgs(), 'up', '--build', '--abort-on-container-exit',
    '--exit-code-from', 'offline-verifier'], { cwd: resolve('.'), encoding: 'utf8', env: environment });
  assert.equal(execution.status, 0,
    `malformed-proposal Compose failed: ${(execution.stderr ?? execution.stdout ?? '').split('\n')[0]}`);
  const result = JSON.parse(readFileSync(join(root, 'output', 'lv01-malformed-proposal-result.json'), 'utf8'));
  assert.equal(result.state, 'sealed');
  assert.equal(result.turnCount, 1);
  assert.equal(result.channelCount, 1);
  assert.equal(result.senderLedgerEventsAdded, 0);
  assert.equal(result.receiverLedgerEventsAdded, 0);
  assert.equal(result.gatewayValidationResult, 'rejected');
  assert.equal(result.rejectionReasonCode, 'trusted-metadata-present');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const teardown = spawnSync('docker', [...composeArgs(), 'down', '--remove-orphans'], {
    cwd: resolve('.'), encoding: 'utf8', env: environment,
  });
  writeFileSync(join(root, 'compose-output.log'), [
    execution?.stdout ?? '', execution?.stderr ?? '', '\n-- teardown --\n',
    teardown.stdout ?? '', teardown.stderr ?? '',
  ].join(''), { flag: 'wx', mode: 0o600 });
  if (teardown.status !== 0 && failure === null) {
    failure = `Compose teardown failed: ${(teardown.stderr ?? teardown.stdout ?? '').split('\n')[0]}`;
  }
}
const receipt = {
  schemaVersion: 1,
  classification: 'lv01-malformed-proposal-development',
  researchFinding: false,
  scientificDisposition: 'not-tested',
  externalSpend: 0,
  executionCommit: command('git', ['rev-parse', 'HEAD']),
  protocolSha256: sha256(packetPath),
  childRunId: child.config.runId,
  parentRunId: parent.runId,
  remainingContainers: remainingContainers(),
  failure,
  passed: failure === null && remainingContainers() === 0,
  claimBoundary: 'One selected-topology malformed proposal rejected by the Gateway. It is not a pilot or behavioral result.',
};
writeFileSync(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
assert.equal(receipt.passed, true, receipt.failure ?? 'malformed-proposal receipt acceptance failed');
console.log('LV01 malformed-proposal qualification passed; no research finding');
