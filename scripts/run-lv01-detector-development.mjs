import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveSeedHex } from '@ald/hashing';
import { loadLearnerContract, promptBundleHash, RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

import {
  LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
  validateLv01DetectorConfig,
  validateLv01DetectorObservation,
} from '../deploy/mode-r/lv01-detector-contract.mjs';
import { composeFailureDetail } from './lv01-detector-compose-status.mjs';

const [mode, version = '1'] = process.argv.slice(2);
assert.ok(mode === '--run' || mode === '--check',
  'usage: run-lv01-detector-development.mjs --run|--check <version>');
assert.match(version, /^[1-9]\d*$/u, 'packet version must be positive');

const packetPath = `protocols/lv01-detector-development.v${version}.json`;
const packet = existsSync(packetPath) ? JSON.parse(readFileSync(packetPath, 'utf8')) : null;
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const command = (program, args, options = {}) =>
  execFileSync(program, args, { encoding: 'utf8', ...options }).trim();

// Services whose container identities back the observation. The stage output
// carries their process ids; the collector retains the matching container
// identities so a later restore comparison can prove replacement.
const REPLACEMENT_SERVICES = [
  'controller-scenario', 'gateway', 'model-adapter-a', 'model-adapter-b', 'baby-a', 'baby-b',
];

function requirePacket() {
  assert.ok(packet !== null, `missing ${packetPath}`);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.classification, 'lv01-detector-development');
  assert.equal(packet.status, 'design-locked-not-executed');
  assert.equal(packet.researchFinding, false);
  assert.equal(packet.scientificDisposition, 'not-tested');
  assert.equal(packet.externalSpend, 0);
  assert.equal(packet.publicChainTransaction, false);
  assert.match(packet.runId, /^[a-z0-9-]+$/u);
  assert.match(packet.project, /^[a-z0-9-]+$/u);
  assert.match(packet.evidenceRoot, /^[a-z0-9-/.]+$/u);
  for (const network of ['babyA', 'babyB', 'controlPlane']) {
    assert.match(packet.networkAllocation[network], /^10\.250\.\d{1,3}\.0\/28$/u);
  }
  const slot = packet.seedDerivation.slot;
  for (const purpose of packet.seedDerivation.purposes) {
    const property = purpose === 'learner/baby-a' ? 'babyA'
      : purpose === 'learner/baby-b' ? 'babyB' : purpose;
    assert.equal(slot[property], deriveSeedHex(packet.seedDerivation.root,
      ...packet.seedDerivation.parts.map((part) => (part === 'purpose' ? purpose : part))));
  }
  assert.equal(command('git', ['rev-parse', `${packet.sourceFreeze.commit}^{tree}`]),
    packet.sourceFreeze.tree);
  for (const artifact of packet.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${artifact.path}`]);
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(hash, artifact.sha256, `frozen source differs for ${artifact.path}`);
    assert.equal(sha256(artifact.path), hash,
      `working source differs from frozen ${artifact.path}`);
  }
  for (const path of ['scripts/run-lv01-detector-development.mjs',
    'deploy/mode-r/application-controller.mjs', 'deploy/mode-r/lv01-detector-contract.mjs']) {
    assert.ok(packet.sourceFreeze.artifacts.some((entry) => entry.path === path),
      `source freeze does not bind ${path}`);
  }
  assert.equal(packet.acceptance.sealedTurns, LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE);
  assert.equal(packet.acceptance.evaluationTurns, 0);
  assert.equal(packet.acceptance.remainingContainers, 0);
}

function buildDetectorRunConfig(runId, commit) {
  const slot = packet.seedDerivation.slot;
  const base = buildRunConfig({
    runId,
    experimentId: 'LV01',
    randomSeed: slot.scenario,
    seedBindings: {
      version: 1, scenario: slot.scenario, babyA: slot.babyA, babyB: slot.babyB,
      gateway: slot.gateway, analysis: slot.analysis,
    },
    deploymentMode: 'research-grade',
    registrationClass: 'qualification',
    babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    learningSignal: 'extrinsic-task',
    communicationCondition: 'normal',
    maxTurnsPerRun: LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE,
    evaluationTurns: 0,
    turnResponseBudgetMs: 1_000,
    checkpointEventInterval: 1,
    checkpointTimeIntervalMs: 300_000,
    protocolGitCommit: commit,
    interventionPlan: { version: 1, heldOutTypeCodes: [0, 5, 10, 15] },
    ledgerValuePlan: packet.ledgerValuePlan,
  });
  const scenario = new ReferentialScenarioEngine({
    version: 1, symbolInventory: fixedTokenInventory(32), interactionMode: base.interactionMode,
    heldOutTypeCodes: [0, 5, 10, 15],
  }, base.randomSeed);
  const runConfig = {
    ...base,
    promptBundleHash: promptBundleHash([loadLearnerContract('scratch-rl')]),
    scenarioBundleHash: scenario.bundleHash,
  };
  validateLv01DetectorConfig(runConfig);
  return runConfig;
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

function replacementEvidence() {
  const ids = command('docker', ['ps', '--all', '--quiet', '--filter',
    `label=com.docker.compose.project=${packet.project}`]).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const containers = JSON.parse(command('docker', ['inspect', ...ids]));
  return containers
    .map((container) => ({
      service: container.Config.Labels['com.docker.compose.service'],
      containerId: container.Id,
      imageDigest: container.Image,
      exitCode: container.State.ExitCode,
    }))
    .filter((entry) => REPLACEMENT_SERVICES.includes(entry.service))
    .sort((left, right) => left.service.localeCompare(right.service));
}

function remainingContainers() {
  return command('docker', ['ps', '-aq', '--filter',
    `label=com.docker.compose.project=${packet.project}`]).split('\n').filter(Boolean).length;
}

requirePacket();
const root = packet.evidenceRoot;
if (mode === '--check') {
  assert.equal(existsSync(root), false,
    'single-use detector evidence already exists; audit its retained receipt instead');
  console.log('LV01 detector packet is configured but unexecuted');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'detector collection requires a clean committed source tree');
assert.equal(existsSync(root), false, 'detector evidence is single-use');
mkdirSync(root, { recursive: true, mode: 0o700 });
directories(root);

const commit = command('git', ['rev-parse', 'HEAD']);
const environment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(root),
  ALD_SOFTWARE_COMMIT: commit,
  ALD_MODE_R_RUN_ID: packet.runId,
  ALD_MODE_R_CONTROLLER_STAGE: 'lv01-detector-observation',
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000),
  ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
  ALD_MODE_R_BABY_A_SUBNET: packet.networkAllocation.babyA,
  ALD_MODE_R_BABY_B_SUBNET: packet.networkAllocation.babyB,
  ALD_MODE_R_CONTROL_PLANE_SUBNET: packet.networkAllocation.controlPlane,
};

let stage = 'configuration';
let execution = null;
let failure = null;
let observation = null;
let replacement = [];
try {
  const runConfig = buildDetectorRunConfig(packet.runId, commit);
  writeFileSync(join(root, 'config', 'run-config.json'),
    `${JSON.stringify(runConfig, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  stage = 'container-execution';
  execution = spawnSync('docker', [...composeArgs(), 'up', '--build', '--abort-on-container-exit',
    '--exit-code-from', 'offline-verifier'], { cwd: resolve('.'), encoding: 'utf8', env: environment });
  assert.equal(execution.status, 0,
    `detector Compose failed: ${composeFailureDetail(execution)}`);
  stage = 'replacement-evidence';
  replacement = replacementEvidence();
  assert.ok(replacement.length === REPLACEMENT_SERVICES.length,
    `detector replacement evidence is incomplete: ${replacement.length}/${REPLACEMENT_SERVICES.length} services`);
  stage = 'observation-validation';
  observation = JSON.parse(readFileSync(join(root, 'output', 'lv01-detector-observations.json'), 'utf8'));
  assert.equal(observation.state, 'sealed');
  assert.equal(observation.captured.length, observation.turnCount * 2);
  validateLv01DetectorObservation(observation);
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error);
  try {
    replacement = replacement.length > 0 ? replacement : replacementEvidence();
  } catch {}
} finally {
  const teardown = spawnSync('docker', [...composeArgs(), 'down', '--remove-orphans'], {
    cwd: resolve('.'), encoding: 'utf8', env: environment,
  });
  writeFileSync(join(root, 'output', 'compose-output.log'), [
    execution?.stdout ?? '', execution?.stderr ?? '', '\n-- teardown --\n',
    teardown.stdout ?? '', teardown.stderr ?? '',
  ].join(''), { flag: 'wx', mode: 0o600 });
  if (teardown.status !== 0 && failure === null) {
    failure = `Compose teardown failed: ${composeFailureDetail(teardown)}`;
    stage = 'teardown';
  }
}
const remaining = remainingContainers();
const receipt = {
  schemaVersion: 1,
  classification: 'lv01-detector-development',
  researchFinding: false,
  scientificDisposition: 'not-tested',
  externalSpend: 0,
  publicChainTransaction: false,
  executionCommit: commit,
  protocolSha256: sha256(packetPath),
  runId: packet.runId,
  stage,
  sealedTurnCount: observation?.turnCount ?? null,
  capturedRows: observation?.captured?.length ?? null,
  learnerArchitecture: observation?.learnerArchitecture ?? null,
  stageProcessIds: observation?.processIds ?? null,
  replacementEvidence: replacement,
  remainingContainers: remaining,
  failure,
  passed: failure === null && remaining === 0,
  claimBoundary: 'One selected-topology recurrent detector-observation capture with source-bound 2016 training turns and zero evaluation turns. Labels, detector probes, restoration comparison, and any qualification decision are owned by later work; this is not a pilot or behavioral result.',
};
writeFileSync(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: 'wx', mode: 0o600,
});
assert.equal(receipt.passed, true, receipt.failure ?? 'detector receipt acceptance failed');
console.log('LV01 detector observation collection passed; no research finding');
