import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
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
assert.ok(mode === '--run' || mode === '--audit', 'expected --run or --audit');
const runMode = mode === '--run';
const protocolPath = 'protocols/mode-r-uncertain-write-development.v3.json';
const evidenceRoot = 'evidence/mode-r-uncertain-write-development-v3';
const receiptPath = join(evidenceRoot, 'receipt.json');
const baseComposePath = 'deploy/mode-r/docker-compose.application.v1.yml';
const overlayComposePath = 'deploy/mode-r/docker-compose.application-uncertain-write.v1.yml';
const project = 'ald-mode-r-uncertain-write-development-v3';
const rustAuditor = '.artifacts/cargo-target/release/ald-integrity-auditor';
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
    env: { ...baseEnvironment, ALD_MODE_R_UNCERTAIN_STAGE: stage },
    timeout: 600_000,
  });
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

async function waitForServiceLog(name, marker, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ids = containerIds(name);
    assert.equal(ids.length, 1, `${name} container count is not one`);
    const inspected = JSON.parse(command('docker', ['inspect', ids[0]]))[0];
    assert.equal(inspected.State.Status, 'running', `${name} exited before ${marker}`);
    if (command('docker', ['logs', ids[0]]).split('\n').includes(marker)) return;
    await delay(250);
  }
  throw new Error(`${name} did not report ${marker}`);
}

function resourceSnapshot() {
  const ids = containerIds().filter((id) =>
    JSON.parse(command('docker', ['inspect', id]))[0].State.Running);
  return ids.length === 0 ? [] : command('docker', [
    'stats', '--no-stream', '--format', '{{json .}}', ...ids,
  ]).split('\n').filter(Boolean).map(JSON.parse);
}

function removeGatewaySockets() {
  const paths = [
    'runtime/gateway-controller/gateway.sock',
    'runtime/gateway-baby-a/learner.sock',
    'runtime/gateway-baby-b/learner.sock',
  ];
  for (const relativePath of paths) {
    const path = join(evidenceRoot, relativePath);
    const info = lstatSync(path);
    assert.equal(info.isSocket(), true, `${relativePath} is not a socket`);
    assert.equal(info.isSymbolicLink(), false, `${relativePath} is a symlink`);
    unlinkSync(path);
  }
}

function journalAccounting() {
  const names = readdirSync(join(evidenceRoot, 'gateway-state'));
  return {
    intentCount: names.filter((name) => name.endsWith('.intent.json')).length,
    confirmationCount: names.filter((name) => name.endsWith('.confirmed.json')).length,
  };
}

function equalCounts(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function audit(receipt) {
  const acceptance = protocol.acceptance;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'selected-mode-r-uncertain-write-development');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.failure, null);
  assert.equal(receipt.protocolSha256, sha256(protocolPath));
  assert.equal(receipt.declaredServiceCount, acceptance.serviceCount);
  assert.equal(receipt.inject.firstError.name, acceptance.remoteUnconfirmedErrorName);
  assert.equal(receipt.inject.secondError.name, acceptance.quarantineErrorName);
  assert.equal(receipt.inject.finalState, acceptance.state);
  assert.equal(receipt.inject.finalTurn, acceptance.turn);
  assert.equal(receipt.inject.operationalQuarantine, acceptance.operationalQuarantine);
  assert.equal(receipt.inject.afterFirst.channel - receipt.inject.before.channel,
    acceptance.channelDeltaAfterCommit);
  assert.equal(receipt.inject.afterFirst.babyALedger - receipt.inject.before.babyALedger,
    acceptance.senderLedgerDeltaAfterCommit);
  assert.equal(receipt.inject.afterFirst.turns - receipt.inject.before.turns,
    acceptance.turnRecordDeltaAfterCommit);
  assert.equal(equalCounts(receipt.inject.afterFirst, receipt.inject.afterSecond), true);
  assert.equal(receipt.recovery.recoveryError.name, acceptance.quarantineErrorName);
  assert.equal(receipt.recovery.stepError.name, acceptance.quarantineErrorName);
  assert.equal(receipt.recovery.operationalQuarantine, acceptance.operationalQuarantine);
  assert.equal(equalCounts(receipt.recovery.before, receipt.recovery.afterRecovery), true);
  assert.equal(equalCounts(receipt.recovery.afterRecovery, receipt.recovery.afterStep), true);
  assert.equal(equalCounts(receipt.inject.afterSecond, receipt.recovery.afterStep), true);
  assert.deepEqual(receipt.journal, acceptance.journal);
  assert.equal(receipt.injectTerminal.exitCode, 0);
  assert.equal(receipt.recoveryTerminal.exitCode, 0);
  assert.equal(receipt.injectTerminal.oomKilled, false);
  assert.equal(receipt.recoveryTerminal.oomKilled, false);
  assert.equal(receipt.verification.inject.typescript.exitCode,
    acceptance.typescriptVerifierExitCode);
  assert.equal(receipt.verification.inject.rust.integrityPass,
    acceptance.rustIntegrityPass);
  assert.equal(receipt.verification.recovery.typescript.exitCode,
    acceptance.typescriptVerifierExitCode);
  assert.equal(receipt.verification.recovery.rust.integrityPass,
    acceptance.rustIntegrityPass);
  assert.ok(receipt.resourceSnapshots.length >= acceptance.minimumResourceSnapshots);
  assert.equal(receipt.unexpectedRunningAfterTeardown, 0);
  assert.equal(receipt.passed, true);
  return receipt;
}

if (!runMode) {
  assert.ok(existsSync(receiptPath), `missing ${receiptPath}`);
  audit(readJson(receiptPath));
  console.log('selected uncertain-write development receipt valid; B12 remains open');
  process.exit(0);
}

assert.equal(command('git', ['status', '--porcelain']), '',
  'uncertain-write collection requires a clean committed source tree');
assert.equal(existsSync(evidenceRoot), false, 'uncertain-write evidence is single-use');
assert.equal(existsSync(rustAuditor), true, 'independent Rust auditor is missing');
assert.equal(protocol.status, 'design-locked-not-executed');
assert.equal(protocol.researchFinding, false);
assert.equal(protocol.b12Closed, false);
assert.equal(sha256(protocol.predecessorFailure.path), protocol.predecessorFailure.sha256);
assert.equal(sha256(protocol.prerequisite.path), protocol.prerequisite.sha256);
for (const source of protocol.sources) assert.equal(sha256(source.path), source.sha256);

const unresolvedConfig = buildRunConfig({
  runId: protocol.runId,
  experimentId: 'E02',
  randomSeed: protocol.runId,
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
  maxTurnsPerRun: 3,
  evaluationTurns: 1,
  checkpointEventInterval: 1,
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
let inject = null;
let recovery = null;
let injectTerminal = null;
let recoveryTerminal = null;
let journal = null;
let verification = null;
const resourceSnapshots = [];
try {
  compose('inject', 'build');
  const resolved = JSON.parse(compose('inject', 'config', '--format', 'json'));
  declaredServiceCount = Object.keys(resolved.services).length;
  compose('inject', 'up', '-d', 'controller-scenario');
  injectTerminal = await waitForServiceExit('controller-scenario');
  assert.equal(injectTerminal.exitCode, 0, 'injection controller failed');
  resourceSnapshots.push({ recordedAt: new Date().toISOString(), services: resourceSnapshot() });
  inject = readJson(join(evidenceRoot, 'output/uncertain-inject-result.json'));
  journal = journalAccounting();

  compose('recover', 'rm', '--stop', '--force', 'controller-scenario', 'gateway');
  removeGatewaySockets();
  compose('recover', 'up', '-d', '--no-deps', 'gateway');
  await waitForServiceLog('gateway', 'ready');
  compose('recover', 'up', '-d', '--no-deps', 'controller-scenario');
  recoveryTerminal = await waitForServiceExit('controller-scenario');
  assert.equal(recoveryTerminal.exitCode, 0, 'recovery controller failed');
  resourceSnapshots.push({ recordedAt: new Date().toISOString(), services: resourceSnapshot() });
  recovery = readJson(join(evidenceRoot, 'output/uncertain-recovery-result.json'));
  verification = {
    inject: {
      typescript: await verifyBundle(join(evidenceRoot, 'output/uncertain-bundle'), {
        verifierVersion: VERIFIER_VERSION,
        now: () => new Date().toISOString(),
        allowUnanchored: true,
      }),
      rust: JSON.parse(command(rustAuditor, [
        join(evidenceRoot, 'output/uncertain-bundle'),
      ])),
    },
    recovery: {
      typescript: await verifyBundle(join(evidenceRoot, 'output/recovery-refusal-bundle'), {
        verifierVersion: VERIFIER_VERSION,
        now: () => new Date().toISOString(),
        allowUnanchored: true,
      }),
      rust: JSON.parse(command(rustAuditor, [
        join(evidenceRoot, 'output/recovery-refusal-bundle'),
      ])),
    },
  };
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  try {
    writeFileSync(join(evidenceRoot, 'compose-logs.txt'),
      `${compose('recover', 'logs', '--no-color')}\n`, { mode: 0o600 });
  } catch {}
  try { compose('recover', 'down', '--remove-orphans'); } catch {}
}

const unexpectedRunningAfterTeardown = containerIds().length;
const acceptance = protocol.acceptance;
const passed = failure === null && inject !== null && recovery !== null &&
  injectTerminal?.exitCode === 0 && recoveryTerminal?.exitCode === 0 &&
  inject.firstError?.name === acceptance.remoteUnconfirmedErrorName &&
  inject.secondError?.name === acceptance.quarantineErrorName &&
  inject.operationalQuarantine === acceptance.operationalQuarantine &&
  recovery.recoveryError?.name === acceptance.quarantineErrorName &&
  recovery.stepError?.name === acceptance.quarantineErrorName &&
  recovery.operationalQuarantine === acceptance.operationalQuarantine &&
  equalCounts(inject.afterFirst, inject.afterSecond) &&
  equalCounts(recovery.before, recovery.afterRecovery) &&
  equalCounts(recovery.afterRecovery, recovery.afterStep) &&
  equalCounts(inject.afterSecond, recovery.afterStep) &&
  journal?.intentCount === acceptance.journal.intentCount &&
  journal?.confirmationCount === acceptance.journal.confirmationCount &&
  verification?.inject.typescript.exitCode === acceptance.typescriptVerifierExitCode &&
  verification?.inject.rust.integrityPass === acceptance.rustIntegrityPass &&
  verification?.recovery.typescript.exitCode === acceptance.typescriptVerifierExitCode &&
  verification?.recovery.rust.integrityPass === acceptance.rustIntegrityPass &&
  unexpectedRunningAfterTeardown === 0;
const receipt = {
  schemaVersion: 1,
  classification: 'selected-mode-r-uncertain-write-development',
  researchFinding: false,
  b12Closed: false,
  publicChainTransaction: false,
  externalSpendingUsd: 0,
  executionCommit: commit,
  protocolSha256: sha256(protocolPath),
  startedAt,
  finishedAt: new Date().toISOString(),
  declaredServiceCount,
  inject,
  recovery,
  injectTerminal,
  recoveryTerminal,
  journal,
  verification,
  resourceSnapshots,
  unexpectedRunningAfterTeardown,
  failure,
  passed,
  claimBoundary: protocol.claimBoundary,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
audit(receipt);
console.log('selected uncertain-write development execution passed; B12 remains open');
