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
import { verifyBundle, VERIFIER_VERSION } from '@ald/verifier';

const mode = process.argv[2];
assert.ok(['--run', '--audit', '--run-lv01-v1', '--audit-lv01-v1'].includes(mode),
  'expected --run, --audit, --run-lv01-v1, or --audit-lv01-v1');
const lv01Mode = mode.endsWith('lv01-v1');
const runMode = mode.startsWith('--run');
const protocolPath = lv01Mode
  ? 'protocols/lv01-late-callback-development.v1.json'
  : 'protocols/mode-r-late-callback-development.v2.json';
const evidenceRoot = lv01Mode
  ? 'evidence/lv01/late-callback-v1/lv01-late-callback-v1-p0001'
  : 'evidence/mode-r-late-callback-development-v2';
const receiptPath = join(evidenceRoot, 'receipt.json');
const baseComposePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const lv01ComposePath = 'deploy/mode-r/docker-compose.lv01.v1.yml';
const overlayComposePath = 'deploy/mode-r/docker-compose.application-late-callback.v1.yml';
const project = lv01Mode ? 'ald-lv01-late-callback-v1' : 'ald-mode-r-late-callback-development-v2';
const rustAuditor = '.artifacts/cargo-target/release/ald-integrity-auditor';
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

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  }).trim();
}

function compose(...args) {
  return command('docker', [
    'compose', '-p', project,
    '-f', baseComposePath,
    ...(lv01Mode ? ['-f', lv01ComposePath] : []),
    '-f', overlayComposePath,
    ...args,
  ], { env: environment, timeout: 600_000 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function containerIds(service) {
  return command('docker', [
    'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
    ...(service === undefined ? [] : [
      '--filter', `label=com.docker.compose.service=${service}`,
    ]),
  ]).split('\n').filter(Boolean);
}

async function waitForServiceExit(name, timeoutMs = 180_000) {
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
          oomKilled: inspected.State.OOMKilled,
        };
      }
    }
    await delay(250);
  }
  throw new Error(`${name} did not exit within ${String(timeoutMs)} ms`);
}

function resourceSnapshot() {
  const ids = containerIds().filter((id) =>
    JSON.parse(command('docker', ['inspect', id]))[0].State.Running);
  return ids.length === 0 ? [] : command('docker', [
    'stats', '--no-stream', '--format', '{{json .}}', ...ids,
  ]).split('\n').filter(Boolean).map(JSON.parse);
}

function sameCounts(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function audit(receipt) {
  const acceptance = protocol.acceptance;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, lv01Mode
    ? 'lv01-selected-late-callback-development'
    : 'selected-mode-r-late-callback-development');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.failure, null);
  assert.equal(receipt.declaredServiceCount, acceptance.serviceCount);
  assert.equal(receipt.result.createdState, acceptance.createdState);
  assert.equal(receipt.result.step.turn, acceptance.turn);
  assert.equal(receipt.result.step.phase, acceptance.phase);
  assert.equal(receipt.result.step.state, acceptance.terminalState);
  assert.equal(receipt.result.step.channelValidation, acceptance.channelValidation);
  assert.equal(receipt.result.step.channelReasonCode, acceptance.channelReasonCode);
  assert.equal(receipt.result.step.logicalSender, acceptance.logicalSender);
  assert.equal(receipt.result.step.outcome.details.reasonCode,
    acceptance.outcomeReasonCode);
  assert.equal(receipt.result.afterTimeout.turns - receipt.result.before.turns,
    acceptance.turnDelta);
  assert.equal(receipt.result.afterTimeout.channel - receipt.result.before.channel,
    acceptance.channelDelta);
  assert.equal(sameCounts(receipt.result.afterTimeout,
    receipt.result.afterLateWindow), true);
  assert.equal(sameCounts(receipt.result.afterLateWindow,
    receipt.result.afterRefusals), true);
  assert.equal(receipt.result.deadlineEvents.length, acceptance.deadlineEventCount);
  assert.deepEqual(receipt.result.deadlineEvents[0].details,
    { turn: 0, phase: 'running', ...acceptance.deadlineEvent });
  assert.equal(receipt.result.resumeError.name, acceptance.resumeErrorName);
  assert.equal(receipt.result.stepError.name, acceptance.stepErrorName);
  assert.equal(receipt.controllerTerminal.exitCode, 0);
  assert.equal(receipt.controllerTerminal.oomKilled, false);
  assert.equal(receipt.verification.typescript.exitCode,
    acceptance.typescriptVerifierExitCode);
  assert.equal(receipt.verification.rust.integrityPass, acceptance.rustIntegrityPass);
  assert.ok(receipt.resourceSnapshots.length >= acceptance.minimumResourceSnapshots);
  assert.equal(receipt.unexpectedRunningAfterTeardown, 0);
  assert.equal(receipt.passed, true);
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log('selected late-callback development receipt valid; B12 remains open');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'late-callback collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'late-callback evidence is single-use');
assert.equal(existsSync(rustAuditor), true, 'independent Rust auditor is missing');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
  assert.equal(protocol.b12Closed, false);
assert.equal(sha256(protocol.prerequisite.path), protocol.prerequisite.sha256);
assert.equal(sha256(protocol.predecessorFailure.path), protocol.predecessorFailure.sha256);
for (const source of protocol.sources) assert.equal(sha256(source.path), source.sha256);

const unresolvedConfig = buildRunConfig({
  runId: protocol.runId,
  experimentId: 'E02',
  randomSeed: protocol.runId,
  deploymentMode: 'research-grade',
  babyA: {
    track: lv01Mode ? 'scratch-rl' : 'no-learning',
    modelRef: lv01Mode ? 'gru-actor-critic-v1' : 'selected-application-no-learning',
    trainingIsolation: 'independent',
  },
  babyB: {
    track: lv01Mode ? 'scratch-rl' : 'no-learning',
    modelRef: lv01Mode ? 'gru-actor-critic-v1' : 'selected-application-no-learning',
    trainingIsolation: 'independent',
  },
  learningSignal: lv01Mode ? 'extrinsic-task' : 'none',
  communicationCondition: 'normal',
  maxTurnsPerRun: 3,
  evaluationTurns: 1,
  checkpointEventInterval: 1,
  turnResponseBudgetMs: protocol.injection.outerDeadlineMs,
  protocolGitCommit: commit,
});
const tracks = [...new Set([unresolvedConfig.babyA.track, unresolvedConfig.babyB.track])];
const scenario = new ReferentialScenarioEngine({
  version: 1,
  symbolInventory: fixedTokenInventory(unresolvedConfig.symbolInventorySize ?? 32),
  interactionMode: unresolvedConfig.interactionMode,
  heldOutTypeCodes: unresolvedConfig.interventionPlan?.heldOutTypeCodes ?? [],
}, unresolvedConfig.randomSeed);
const runConfig = {
  ...unresolvedConfig,
  promptBundleHash: promptBundleHash(tracks.map((track) => loadLearnerContract(track))),
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
let failure = null;
let declaredServiceCount = 0;
let controllerTerminal = null;
let result = null;
let verification = null;
const resourceSnapshots = [];
try {
  compose('build');
  const resolved = JSON.parse(compose('config', '--format', 'json'));
  declaredServiceCount = Object.keys(resolved.services).length;
  compose('up', '-d', 'controller-scenario');
  controllerTerminal = await waitForServiceExit('controller-scenario');
  assert.equal(controllerTerminal.exitCode, 0, 'late-callback controller failed');
  resourceSnapshots.push({ recordedAt: new Date().toISOString(), services: resourceSnapshot() });
  result = readJson(join(evidenceRoot, 'output/late-callback-result.json'));
  const bundle = join(evidenceRoot, 'output/late-callback-bundle');
  verification = {
    typescript: await verifyBundle(bundle, {
      verifierVersion: VERIFIER_VERSION,
      now: () => new Date().toISOString(),
      allowUnanchored: true,
    }),
    rust: JSON.parse(command(rustAuditor, [bundle])),
  };
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    writeFileSync(join(evidenceRoot, 'compose-logs.txt'),
      `${compose('logs', '--no-color')}\n`, { mode: 0o600 });
  } catch {}
  try { compose('down', '--remove-orphans'); } catch {}
}

const unexpectedRunningAfterTeardown = containerIds().length;
const acceptance = protocol.acceptance;
const expectedDeadlineDetails = {
  turn: acceptance.turn,
  phase: acceptance.phase,
  ...acceptance.deadlineEvent,
};
const passed = failure === null && result !== null && controllerTerminal?.exitCode === 0 &&
  result.createdState === acceptance.createdState &&
  result.step?.turn === acceptance.turn && result.step?.phase === acceptance.phase &&
  result.step?.state === acceptance.terminalState &&
  result.step?.channelValidation === acceptance.channelValidation &&
  result.step?.channelReasonCode === acceptance.channelReasonCode &&
  result.step?.logicalSender === acceptance.logicalSender &&
  result.step?.outcome?.details?.reasonCode === acceptance.outcomeReasonCode &&
  result.afterTimeout?.turns - result.before?.turns === acceptance.turnDelta &&
  result.afterTimeout?.channel - result.before?.channel === acceptance.channelDelta &&
  sameCounts(result.afterTimeout, result.afterLateWindow) &&
  sameCounts(result.afterLateWindow, result.afterRefusals) &&
  result.deadlineEvents?.length === acceptance.deadlineEventCount &&
  Object.keys(result.deadlineEvents?.[0]?.details ?? {}).length ===
    Object.keys(expectedDeadlineDetails).length &&
  Object.entries(expectedDeadlineDetails).every(([key, value]) =>
    result.deadlineEvents?.[0]?.details?.[key] === value) &&
  result.resumeError?.name === acceptance.resumeErrorName &&
  result.stepError?.name === acceptance.stepErrorName &&
  verification?.typescript.exitCode === acceptance.typescriptVerifierExitCode &&
  verification?.rust.integrityPass === acceptance.rustIntegrityPass &&
  unexpectedRunningAfterTeardown === 0;
const receipt = {
  schemaVersion: 1,
  classification: lv01Mode
    ? 'lv01-selected-late-callback-development'
    : 'selected-mode-r-late-callback-development',
  researchFinding: false,
  b12Closed: false,
  publicChainTransaction: false,
  externalSpendingUsd: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  startedAt,
  finishedAt: new Date().toISOString(),
  declaredServiceCount,
  controllerTerminal,
  result,
  verification,
  resourceSnapshots,
  unexpectedRunningAfterTeardown,
  failure,
  passed,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
audit(receipt);
console.log('selected late-callback development execution passed; B12 remains open');
