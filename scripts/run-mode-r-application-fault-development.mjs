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

import { loadLearnerContract, promptBundleHash, RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';
import { verifyBundle, VERIFIER_VERSION } from '@ald/verifier';

const mode = process.argv[2];
const lv01 = mode === '--run-lv01-v1' || mode === '--audit-lv01-v1';
assert.ok(lv01 || /^--(?:run|audit)-v3$/u.test(mode ?? ''),
  'expected --run-v3, --audit-v3, --run-lv01-v1, or --audit-lv01-v1');
const runMode = mode === '--run-v3' || mode === '--run-lv01-v1';
const version = lv01 ? 1 : 3;
const protocolPath = lv01
  ? `protocols/lv01-application-fault-development.v${String(version)}.json`
  : `protocols/mode-r-application-fault-development.v${String(version)}.json`;
const evidenceRoot = lv01
  ? `evidence/lv01/application-fault-v${String(version)}`
  : `evidence/mode-r-application-fault-development-v${String(version)}`;
const receiptPath = join(evidenceRoot, 'receipt.json');
const baseComposePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const lv01ComposePath = 'deploy/mode-r/docker-compose.lv01.v1.yml';
const lv01NetworkComposePath = 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml';
const overlayComposePath = 'deploy/mode-r/docker-compose.application-fault.v1.yml';
const project = lv01
  ? `ald-lv01-application-fault-v${String(version)}`
  : `ald-mode-r-application-fault-development-v${String(version)}`;
const rustAuditor = '.artifacts/cargo-target/release/ald-integrity-auditor';
const protocol = readJson(protocolPath);
const commit = command('git', ['rev-parse', 'HEAD']);

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

function caseEnvironment(caseRoot, runId, faultCase, networks) {
  return {
    ...process.env,
    ALD_MODE_R_APPLICATION_ROOT: resolve(caseRoot),
    ALD_SOFTWARE_COMMIT: commit,
    ALD_MODE_R_RUN_ID: runId,
    ALD_MODE_R_FAULT_CASE: faultCase,
    ALD_MODE_R_UID: String(process.getuid?.() ?? 1000),
    ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
    ...(networks === undefined ? {} : {
      ALD_MODE_R_BABY_A_SUBNET: networks.babyA,
      ALD_MODE_R_BABY_B_SUBNET: networks.babyB,
      ALD_MODE_R_CONTROL_PLANE_SUBNET: networks.controlPlane,
    }),
  };
}

function compose(environment, ...args) {
  return command('docker', [
    'compose', '-p', project,
    '-f', baseComposePath,
    ...(lv01 ? ['-f', lv01ComposePath, '-f', lv01NetworkComposePath] : []),
    '-f', overlayComposePath,
    ...args,
  ], { env: environment, timeout: 600_000 });
}

function containerIds(service) {
  return command('docker', [
    'ps', '-aq',
    '--filter', `label=com.docker.compose.project=${project}`,
    ...(service === undefined
      ? []
      : ['--filter', `label=com.docker.compose.service=${service}`]),
  ]).split('\n').filter(Boolean);
}

async function waitForFile(path, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(250);
  }
  throw new Error(`${path} did not appear within ${String(timeoutMs)} ms`);
}

async function waitForServiceExit(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = containerIds(name);
    assert.ok(ids.length <= 1, `${name} has multiple containers`);
    if (ids.length === 1) {
      const inspected = JSON.parse(command('docker', ['inspect', ids[0]]))[0];
      if (inspected.State.Status === 'exited') {
        return {
          containerId: inspected.Id,
          exitCode: inspected.State.ExitCode,
          error: inspected.State.Error,
          oomKilled: inspected.State.OOMKilled,
        };
      }
    }
    await delay(250);
  }
  throw new Error(`${name} did not exit within ${String(timeoutMs)} ms`);
}

function resourceSnapshot() {
  const ids = containerIds().filter((id) => {
    const inspected = JSON.parse(command('docker', ['inspect', id]))[0];
    return inspected.State.Running;
  });
  if (ids.length === 0) return [];
  return command('docker', [
    'stats', '--no-stream', '--format', '{{json .}}', ...ids,
  ]).split('\n').filter(Boolean).map(JSON.parse);
}

function audit(receipt) {
  const acceptance = protocol.acceptance;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, lv01
    ? 'lv01-selected-application-fault-development'
    : 'selected-mode-r-application-fault-development');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.cases.length, acceptance.caseCount);
  assert.equal(receipt.summary.passedCaseCount, acceptance.caseCount);
  assert.equal(receipt.summary.failedCaseCount, 0);
  assert.equal(receipt.summary.unexpectedRunningAfterTeardown,
    acceptance.unexpectedRunningAfterTeardown);
  for (const entry of receipt.cases) {
    assert.equal(entry.declaredServiceCount, acceptance.serviceCount);
    assert.equal(entry.ready.prefixTurn, acceptance.prefixTurn);
    const expected = protocol.cases.find((fault) => fault.id === entry.id);
    assert.ok(expected, `${entry.id} is not in the protocol`);
    assert.equal(entry.faultResult.postFaultDisposition,
      expected.expectedDisposition);
    assert.equal(entry.faultResult.stateAfterFault, expected.expectedState);
    assert.equal(entry.faultResult.turnAfterFault, expected.expectedTurnAfterFault);
    assert.equal(entry.targetTerminal.exitCode, acceptance.targetExitCode);
    assert.equal(entry.targetTerminal.oomKilled, false);
    assert.equal(entry.typescriptVerification.exitCode,
      acceptance.prefixTypeScriptVerifierExitCode);
    assert.equal(entry.rustVerification.integrityPass,
      acceptance.prefixRustIntegrityPass);
    assert.equal(entry.postFaultTypeScriptVerification.exitCode,
      acceptance.postFaultTypeScriptVerifierExitCode);
    assert.equal(entry.postFaultRustVerification.integrityPass,
      acceptance.postFaultRustIntegrityPass);
    assert.ok(entry.resourceSnapshots.length >=
      acceptance.minimumResourceSnapshotsPerCase);
    assert.equal(entry.passed, true);
  }
  assert.equal(receipt.passed, true);
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log(`${lv01 ? 'LV01 selected' : 'selected application'} fault development receipt valid; B12 remains open`);
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'fault collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'fault evidence is single-use');
assert.equal(existsSync(rustAuditor), true, 'independent Rust auditor is missing');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
assert.equal(protocol.b12Closed, false);
assert.equal(sha256(protocol.predecessorFailure.path),
  protocol.predecessorFailure.sha256);
assert.equal(sha256(protocol.prerequisite.path), protocol.prerequisite.sha256);
assert.equal(sha256(protocol.compose.basePath), protocol.compose.baseSha256);
assert.equal(sha256(protocol.compose.overlayPath), protocol.compose.overlaySha256);
assert.equal(sha256(protocol.controller.path), protocol.controller.sha256);
if (lv01) {
  assert.equal(command('git', ['rev-parse', `${protocol.sourceFreeze.commit}^{tree}`]),
    protocol.sourceFreeze.tree);
  for (const artifact of protocol.sourceFreeze.artifacts) {
    assert.equal(
      `sha256:${createHash('sha256').update(execFileSync('git', ['show',
        `${protocol.sourceFreeze.commit}:${artifact.path}`])).digest('hex')}`,
      artifact.sha256,
    );
    assert.equal(`sha256:${createHash('sha256').update(readFileSync(artifact.path)).digest('hex')}`,
      artifact.sha256, `working source differs from frozen ${artifact.path}`);
  }
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const cases = [];
for (const fault of protocol.cases) {
  const caseRoot = join(evidenceRoot, fault.id);
  const runId = lv01
    ? `${protocol.qualificationId}-p0001-${fault.id}`
    : `${protocol.qualificationId}-${fault.id}`;
  const environment = caseEnvironment(caseRoot, runId, fault.id,
    lv01 ? protocol.networkAllocation[fault.id] : undefined);
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
    mkdirSync(join(caseRoot, directory), { recursive: true, mode: 0o700 });
  }
  const unresolvedConfig = buildRunConfig({
    runId,
    experimentId: lv01 ? 'LV01' : 'E02',
    randomSeed: runId,
    deploymentMode: 'research-grade',
    babyA: {
      track: lv01 ? 'scratch-rl' : protocol.execution.learnerTrack,
      modelRef: lv01 ? RECURRENT_ARCHITECTURE : 'selected-application-no-learning',
      trainingIsolation: 'independent',
    },
    babyB: {
      track: lv01 ? 'scratch-rl' : protocol.execution.learnerTrack,
      modelRef: lv01 ? RECURRENT_ARCHITECTURE : 'selected-application-no-learning',
      trainingIsolation: 'independent',
    },
    learningSignal: lv01 ? 'extrinsic-task' : 'none',
    communicationCondition: 'normal',
    maxTurnsPerRun: protocol.execution.trainingTurns,
    evaluationTurns: protocol.execution.evaluationTurns,
    checkpointEventInterval: protocol.execution.checkpointEventInterval,
    protocolGitCommit: commit,
    ...(lv01 ? {
      interventionPlan: { version: 1, heldOutTypeCodes: [0, 5, 10, 15] },
      ledgerValuePlan: protocol.ledgerValuePlan,
    } : {}),
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
  writeFileSync(join(caseRoot, 'config/run-config.json'),
    `${JSON.stringify(runConfig, null, 2)}\n`, { mode: 0o600 });

  const entry = {
    id: fault.id,
    runId,
    targetService: fault.targetService,
    postFaultAction: fault.postFaultAction,
    declaredServiceCount: 0,
    ready: null,
    targetTerminal: null,
    controllerTerminal: null,
    faultResult: null,
    typescriptVerification: null,
    rustVerification: null,
    postFaultTypeScriptVerification: null,
    postFaultRustVerification: null,
    resourceSnapshots: [],
    failure: null,
    passed: false,
  };
  try {
    compose(environment, 'build');
    const resolved = JSON.parse(compose(environment, 'config', '--format', 'json'));
    entry.declaredServiceCount = Object.keys(resolved.services).length;
    compose(environment, 'up', '-d', 'controller-scenario');
    await waitForFile(join(caseRoot, 'output/fault-ready.json'));
    entry.ready = readJson(join(caseRoot, 'output/fault-ready.json'));
    entry.resourceSnapshots.push({
      recordedAt: new Date().toISOString(),
      services: resourceSnapshot(),
    });
    const targetIds = containerIds(fault.targetService);
    assert.equal(targetIds.length, 1, `${fault.targetService} target count is not one`);
    command('docker', ['kill', '--signal=KILL', targetIds[0]]);
    entry.targetTerminal = await waitForServiceExit(fault.targetService);
    writeFileSync(join(caseRoot, 'output/fault-triggered'),
      `${new Date().toISOString()}\n`, { mode: 0o600 });
    entry.controllerTerminal = await waitForServiceExit('controller-scenario');
    entry.resourceSnapshots.push({
      recordedAt: new Date().toISOString(),
      services: resourceSnapshot(),
    });
    entry.faultResult = readJson(join(caseRoot, 'output/fault-result.json'));
    entry.typescriptVerification = await verifyBundle(
      join(caseRoot, 'output/prefix-bundle'),
      {
        verifierVersion: VERIFIER_VERSION,
        now: () => new Date().toISOString(),
        allowUnanchored: true,
      },
    );
    entry.rustVerification = JSON.parse(command(rustAuditor, [
      join(caseRoot, 'output/prefix-bundle'),
    ]));
    entry.postFaultTypeScriptVerification = await verifyBundle(
      join(caseRoot, 'output/post-fault-bundle'),
      {
        verifierVersion: VERIFIER_VERSION,
        now: () => new Date().toISOString(),
        allowUnanchored: true,
      },
    );
    entry.postFaultRustVerification = JSON.parse(command(rustAuditor, [
      join(caseRoot, 'output/post-fault-bundle'),
    ]));
    entry.passed = entry.declaredServiceCount === protocol.acceptance.serviceCount &&
      entry.ready.prefixTurn === protocol.acceptance.prefixTurn &&
      entry.targetTerminal.exitCode === protocol.acceptance.targetExitCode &&
      entry.targetTerminal.oomKilled === false &&
      entry.controllerTerminal.exitCode === 0 &&
      entry.faultResult.postFaultDisposition === fault.expectedDisposition &&
      entry.faultResult.stateAfterFault === fault.expectedState &&
      entry.faultResult.turnAfterFault === fault.expectedTurnAfterFault &&
      entry.typescriptVerification.exitCode === 0 &&
      entry.rustVerification.integrityPass === true &&
      entry.postFaultTypeScriptVerification.exitCode === 0 &&
      entry.postFaultRustVerification.integrityPass === true &&
      entry.resourceSnapshots.length >=
        protocol.acceptance.minimumResourceSnapshotsPerCase;
  } catch (error) {
    entry.failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      writeFileSync(join(caseRoot, 'compose-logs.txt'),
        `${compose(environment, 'logs', '--no-color')}\n`, { mode: 0o600 });
    } catch {}
    try { compose(environment, 'down', '--remove-orphans'); } catch {}
  }
  cases.push(entry);
}

const remaining = containerIds();
const summary = {
  caseCount: cases.length,
  passedCaseCount: cases.filter((entry) => entry.passed).length,
  failedCaseCount: cases.filter((entry) => !entry.passed).length,
  resourceSnapshotCount: cases.reduce(
    (sum, entry) => sum + entry.resourceSnapshots.length, 0),
  unexpectedRunningAfterTeardown: remaining.length,
};
const receipt = {
  schemaVersion: 1,
  classification: lv01
    ? 'lv01-selected-application-fault-development'
    : 'selected-mode-r-application-fault-development',
  researchFinding: false,
  b12Closed: false,
  publicChainTransaction: false,
  externalSpendingUsd: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  qualificationId: protocol.qualificationId,
  startedAt,
  finishedAt: new Date().toISOString(),
  cases,
  summary,
  passed: summary.failedCaseCount === 0 &&
    summary.unexpectedRunningAfterTeardown === 0,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
audit(receipt);
console.log(`${lv01 ? 'LV01 selected' : 'selected application'} fault development execution passed; B12 remains open`);
