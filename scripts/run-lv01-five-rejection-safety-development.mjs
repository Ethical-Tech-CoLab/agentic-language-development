import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadLearnerContract, promptBundleHash, RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

const [mode, version = '1'] = process.argv.slice(2);
assert.ok(mode === '--run' || mode === '--check');
const packetPath = `protocols/lv01-five-rejection-safety-development.v${version}.json`;
const packet = existsSync(packetPath) ? JSON.parse(readFileSync(packetPath, 'utf8')) : null;
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const command = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', ...options }).trim();

function requirePacket() {
  assert.ok(packet, `missing ${packetPath}`);
  assert.equal(packet.classification, 'lv01-five-rejection-safety-development');
  assert.equal(packet.status, 'design-locked-not-executed');
  assert.equal(packet.researchFinding, false);
  assert.equal(packet.externalSpend, 0);
  assert.equal(command('git', ['rev-parse', `${packet.sourceFreeze.commit}^{tree}`]), packet.sourceFreeze.tree);
  for (const source of packet.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${source.path}`]);
    const frozen = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(frozen, source.sha256);
    assert.equal(hash(source.path), frozen, `working source differs from ${source.path}`);
  }
}

function configure() {
  const base = buildRunConfig({
    runId: packet.runId, experimentId: 'LV01', randomSeed: packet.seed,
    deploymentMode: 'research-grade', registrationClass: 'qualification',
    babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    learningSignal: 'extrinsic-task', communicationCondition: 'normal',
    maxTurnsPerRun: 6, evaluationTurns: 1, turnResponseBudgetMs: 1_000,
    maxConsecutiveRejections: 5, checkpointEventInterval: 1, protocolGitCommit: command('git', ['rev-parse', 'HEAD']),
    interventionPlan: { version: 1, heldOutTypeCodes: [0, 5, 10, 15] },
    ledgerValuePlan: {
      version: 1, designCommitmentHash: hash('protocols/lv01-study-design.v1.json'),
      analysisCommitmentHash: hash('protocols/lv01-analysis-plan.v1.json'),
      seedResourceCommitmentHash: hash('protocols/lv01-seed-resource-policy.v1.json'),
      predictionFunctionVersion: 'lv01-ledger-value-prediction/v1', partitionContractVersion: 'lv01-within-support/v1',
    },
  });
  const scenario = new ReferentialScenarioEngine({ version: 1, symbolInventory: fixedTokenInventory(32), interactionMode: base.interactionMode, heldOutTypeCodes: [0, 5, 10, 15] }, base.randomSeed);
  return { ...base, promptBundleHash: promptBundleHash([loadLearnerContract('scratch-rl')]), scenarioBundleHash: scenario.bundleHash };
}

function prepare(root) {
  for (const path of ['config', 'evidence', 'gateway-state', 'output', 'runtime/model-a', 'runtime/model-b', 'runtime/public-keys', ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness'].map((name) => `runtime/signers/${name}`), ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit'].map((name) => `runtime/evidence-${name}`), 'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b', 'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service']) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
}

requirePacket();
if (mode === '--check') {
  assert.equal(existsSync(packet.evidenceRoot), false, 'single-use evidence already exists');
  console.log('LV01 five-rejection safety packet is configured but unexecuted');
  process.exit(0);
}
assert.equal(command('git', ['status', '--porcelain']), '', 'collection requires clean committed source');
assert.equal(existsSync(packet.evidenceRoot), false, 'single-use evidence already exists');
prepare(packet.evidenceRoot);
const config = configure();
writeFileSync(join(packet.evidenceRoot, 'config/run-config.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const environment = { ...process.env, ALD_MODE_R_APPLICATION_ROOT: resolve(packet.evidenceRoot), ALD_SOFTWARE_COMMIT: command('git', ['rev-parse', 'HEAD']), ALD_MODE_R_RUN_ID: config.runId, ALD_MODE_R_CONTROLLER_STAGE: 'lv01-five-rejection-safety', ALD_MODE_R_UID: String(process.getuid?.() ?? 1000), ALD_MODE_R_GID: String(process.getgid?.() ?? 1000), ALD_MODE_R_BABY_A_SUBNET: packet.networkAllocation.babyA, ALD_MODE_R_BABY_B_SUBNET: packet.networkAllocation.babyB, ALD_MODE_R_CONTROL_PLANE_SUBNET: packet.networkAllocation.controlPlane };
const compose = (args) => spawnSync('docker', ['compose', '-p', packet.project, '-f', 'deploy/mode-r/docker-compose.application.v1.yml', '-f', 'deploy/mode-r/docker-compose.lv01.v1.yml', '-f', 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml', ...args], { cwd: resolve('.'), encoding: 'utf8', env: environment });
let execution = null;
let failure = null;
try {
  execution = compose(['up', '--build', '--abort-on-container-exit', '--exit-code-from', 'offline-verifier']);
  assert.equal(execution.status, 0, `Compose failed: ${(execution.stderr ?? execution.stdout ?? '').split('\n')[0]}`);
  const result = JSON.parse(readFileSync(join(packet.evidenceRoot, 'output/lv01-five-rejection-safety-result.json'), 'utf8'));
  assert.equal(result.state, 'paused');
  assert.equal(result.turnCount, 5);
  assert.equal(result.channelCount, 5);
  assert.equal(result.safetyTriggerCount, 1);
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  const teardown = compose(['down', '--remove-orphans']);
  writeFileSync(join(packet.evidenceRoot, 'compose-output.log'), `${execution?.stdout ?? ''}${execution?.stderr ?? ''}\n-- teardown --\n${teardown.stdout ?? ''}${teardown.stderr ?? ''}`, { flag: 'wx', mode: 0o600 });
  if (teardown.status !== 0 && failure === null) failure = 'Compose teardown failed';
}
const remainingContainers = command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${packet.project}`]).split('\n').filter(Boolean).length;
const receipt = { schemaVersion: 1, classification: 'lv01-five-rejection-safety-development', researchFinding: false, scientificDisposition: 'not-tested', externalSpend: 0, executionCommit: command('git', ['rev-parse', 'HEAD']), protocolSha256: hash(packetPath), runId: config.runId, remainingContainers, failure, passed: failure === null && remainingContainers === 0, claimBoundary: 'One selected-topology five-rejection safety pause. It is not a deadline or behavioral result.' };
writeFileSync(join(packet.evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
assert.equal(receipt.passed, true, receipt.failure ?? 'safety receipt failed');
console.log('LV01 five-rejection safety qualification passed; no research finding');
