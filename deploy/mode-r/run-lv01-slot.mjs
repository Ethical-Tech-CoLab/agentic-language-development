import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveSeedHex } from '@ald/hashing';
import { loadLearnerContract, promptBundleHash, RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory } from '@ald/types';

const [mode, version] = process.argv.slice(2);
assert.ok(mode === '--run' || mode === '--check', 'usage: run-lv01-slot.mjs --run|--check <version>');
assert.match(version ?? '', /^[1-9]\d*$/u);

const allocationPath = `protocols/lv01-development-resource-allocation.v${version}.json`;
const evidenceRoot = `evidence/lv01/development-v${version}`;
const slotRoot = join(evidenceRoot, 'lv01-development-v1-p0001');
const resultPath = join(slotRoot, 'output', 'lv01-fixture-result.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const allocation = existsSync(allocationPath)
  ? JSON.parse(readFileSync(allocationPath, 'utf8'))
  : null;

function verifyAllocation() {
  assert.ok(allocation !== null, `missing ${allocationPath}`);
  assert.equal(allocation.studyId, 'LV01');
  assert.equal(allocation.classification, 'prospective-development-only-allocation');
  assert.equal(allocation.status, 'design-locked-not-executed');
  assert.equal(allocation.researchFinding, false);
  assert.equal(allocation.externalSpend, 0);
  assert.equal(allocation.allocation.smallFixture.runId, 'lv01-development-v1-p0001');
  assert.equal(allocation.allocation.smallFixture.trainingCases, 64);
  assert.equal(allocation.allocation.smallFixture.validationFitCases, 24);
  assert.equal(allocation.allocation.smallFixture.validationSelectionCases, 24);
  assert.equal(allocation.allocation.smallFixture.withinSupportTestCases, 24);
  assert.equal(allocation.seedDerivation.slots.length, 6);
  assert.ok(allocation.sourceFreeze.artifacts.some((artifact) =>
    artifact.path === 'deploy/mode-r/run-lv01-slot.mjs'),
  'allocation source closure does not bind this runner; compile a fresh version');
}

function config() {
  const slot = allocation.seedDerivation.slots[0];
  const planHash = (path) => sha256(path);
  const base = buildRunConfig({
    runId: allocation.allocation.smallFixture.runId,
    experimentId: 'LV01',
    randomSeed: slot.scenario,
    seedBindings: { version: 1, scenario: slot.scenario, babyA: slot.babyA, babyB: slot.babyB, gateway: slot.gateway, analysis: slot.analysis },
    deploymentMode: 'research-grade',
    registrationClass: 'qualification',
    babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE, trainingIsolation: 'independent' },
    learningSignal: 'extrinsic-task', communicationCondition: 'normal', maxTurnsPerRun: 64,
    evaluationTurns: 24, evaluationSeeds: 1, turnResponseBudgetMs: 1_000,
    checkpointEventInterval: 64, checkpointTimeIntervalMs: 300_000, protocolGitCommit: commit,
    ledgerValuePlan: {
      version: 1,
      designCommitmentHash: planHash('protocols/lv01-study-design.v1.json'),
      analysisCommitmentHash: planHash('protocols/lv01-analysis-plan.v1.json'),
      seedResourceCommitmentHash: planHash('protocols/lv01-seed-resource-policy.v1.json'),
      predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
      partitionContractVersion: 'lv01-within-support/v1',
    },
  });
  const scenario = new ReferentialScenarioEngine({
    version: 1, symbolInventory: fixedTokenInventory(32), interactionMode: base.interactionMode,
    heldOutTypeCodes: [0, 5, 10, 15],
  }, base.randomSeed);
  return {
    ...base,
    promptBundleHash: promptBundleHash(['scratch-rl'].map(loadLearnerContract)),
    scenarioBundleHash: scenario.bundleHash,
  };
}

function prepareDirectories() {
  for (const directory of [
    'config', 'evidence', 'gateway-state', 'output', 'runtime/model-a', 'runtime/model-b', 'runtime/public-keys',
    ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness'].map((domain) => `runtime/signers/${domain}`),
    ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit'].map((name) => `runtime/evidence-${name}`),
    'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b',
    'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service',
  ]) mkdirSync(join(slotRoot, directory), { recursive: true, mode: 0o700 });
}

verifyAllocation();
if (mode === '--check') {
  assert.equal(existsSync(resultPath), false, 'fixture evidence already exists; audit the retained attempt instead');
  console.log(`LV01 development fixture v${version} is configured but unexecuted`);
  process.exit(0);
}

assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'LV01 fixture requires a clean committed source tree');
assert.equal(existsSync(slotRoot), false, 'LV01 fixture evidence is single-use');
prepareDirectories();
writeFileSync(join(slotRoot, 'config', 'run-config.json'), `${JSON.stringify(config(), null, 2)}\n`, { mode: 0o600 });
const environment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(slotRoot), ALD_SOFTWARE_COMMIT: commit,
  ALD_MODE_R_RUN_ID: allocation.allocation.smallFixture.runId,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000), ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
  ALD_MODE_R_CONTROLLER_STAGE: 'lv01-fixture',
};
const compose = ['compose', '--project-name', `ald-lv01-development-v${version}`,
  '--file', 'deploy/mode-r/docker-compose.application.v1.yml',
  '--file', 'deploy/mode-r/docker-compose.lv01.v1.yml'];
const result = execFileSync('docker', [...compose, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'offline-verifier'], {
  env: environment, encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
});
assert.ok(result.length >= 0);
assert.ok(existsSync(resultPath), 'controller did not write the LV01 fixture result');
const fixture = JSON.parse(readFileSync(resultPath, 'utf8'));
assert.equal(fixture.state, 'sealed');
assert.equal(fixture.trainingTurns, 64);
assert.equal(fixture.evaluationTurns, 24);
assert.equal(fixture.researchFinding, false);
console.log(`LV01 development fixture complete: ${fixture.runId}; no research finding`);
