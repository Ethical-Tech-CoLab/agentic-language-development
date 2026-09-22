import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { hashCanonical } from '@ald/hashing';
import { createLv01PairedCasePlan, LV01_BRANCHES, verifyLv01PairedCase } from '@ald/orchestrator';

const [mode, version] = process.argv.slice(2);
assert.ok(mode === '--run' || mode === '--check', 'usage: run-lv01-paired-case.mjs --run|--check <version>');
assert.match(version ?? '', /^[1-9]\d*$/u);

const packetPath = `protocols/lv01-paired-development-allocation.v${version}.json`;
const packet = existsSync(packetPath) ? JSON.parse(readFileSync(packetPath, 'utf8')) : null;
const parentRunId = `lv01-development-v${version}-p0001`;
const parentRoot = join('evidence/lv01', `development-v${version}`, parentRunId);
const root = join('evidence/lv01', `paired-development-v${version}`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function networkAllocation(runOrdinal) {
  const thirdOctet = 1 + (Number(version) * 8) + runOrdinal;
  assert.ok(thirdOctet <= 255, 'LV01 isolated-network allocation requires a new version range');
  return {
    babyA: `10.250.${thirdOctet}.0/28`,
    babyB: `10.250.${thirdOctet}.16/28`,
    controlPlane: `10.250.${thirdOctet}.32/28`,
  };
}

function requirePacket() {
  assert.ok(packet !== null, `missing ${packetPath}`);
  assert.equal(packet.studyId, 'LV01');
  assert.equal(packet.classification, 'prospective-development-only-paired-case');
  assert.equal(packet.status, 'design-locked-not-executed');
  assert.equal(packet.researchFinding, false);
  assert.equal(packet.externalSpend, 0);
  assert.equal(packet.parentRunId, parentRunId);
  assert.deepEqual(packet.branchOrder, LV01_BRANCHES);
  assert.deepEqual(packet.networkAllocation.parent, networkAllocation(0));
  assert.deepEqual(packet.networkAllocation.children,
    Object.fromEntries(LV01_BRANCHES.map((branch, index) => [branch, networkAllocation(index + 1)])));
  assert.equal(packet.sourceFreeze.tree,
    execFileSync('git', ['rev-parse', `${packet.sourceFreeze.commit}^{tree}`], { encoding: 'utf8' }).trim());
  for (const artifact of packet.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${artifact.path}`]);
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(hash, artifact.sha256,
      `source freeze changed for ${artifact.path}`);
    assert.equal(`sha256:${createHash('sha256').update(readFileSync(artifact.path)).digest('hex')}`, hash,
      `working source differs from frozen ${artifact.path}`);
  }
  assert.ok(packet.sourceFreeze.artifacts.some((entry) => entry.path === 'deploy/mode-r/run-lv01-paired-case.mjs'));
}

function prepare(rootPath) {
  for (const directory of [
    'config', 'evidence', 'gateway-state', 'output', 'runtime/model-a', 'runtime/model-b', 'runtime/public-keys',
    ...['baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness'].map((name) => `runtime/signers/${name}`),
    ...['controller', 'gateway', 'checkpoint', 'anchor', 'audit'].map((name) => `runtime/evidence-${name}`),
    'runtime/gateway-controller', 'runtime/gateway-baby-a', 'runtime/gateway-baby-b',
    'runtime/checkpoint-service', 'runtime/anchor-service', 'runtime/audit-service',
  ]) mkdirSync(join(rootPath, directory), { recursive: true, mode: 0o700 });
}

function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }

function lastCheckpoint(bundle) {
  const checkpointRoot = join(bundle, 'checkpoints');
  const files = readdirSync(checkpointRoot)
    .filter((name) => /^\d{6}\.json$/u.test(name)).sort()
    .map((name) => join(checkpointRoot, name));
  assert.ok(files.length > 0, 'parent bundle has no checkpoint');
  return json(files.at(-1));
}

function compose(rootPath, runId, networks) {
  const project = `ald-lv01-paired-v${version}-${runId.slice(-12)}`;
  const command = ['compose', '--project-name', project,
    '--file', 'deploy/mode-r/docker-compose.application.v1.yml',
    '--file', 'deploy/mode-r/docker-compose.lv01.v1.yml',
    '--file', 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml'];
  const environment = {
    ...process.env, ALD_MODE_R_APPLICATION_ROOT: resolve(rootPath), ALD_SOFTWARE_COMMIT: commit,
    ALD_MODE_R_RUN_ID: runId, ALD_MODE_R_CONTROLLER_STAGE: 'lv01-paired-branch',
    ALD_MODE_R_UID: String(process.getuid?.() ?? 1000), ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
    ALD_MODE_R_BABY_A_SUBNET: networks.babyA,
    ALD_MODE_R_BABY_B_SUBNET: networks.babyB,
    ALD_MODE_R_CONTROL_PLANE_SUBNET: networks.controlPlane,
  };
  let result;
  let teardown;
  try {
    result = spawnSync('docker', [...command, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'offline-verifier'], {
      cwd: resolve('.'), encoding: 'utf8', env: environment,
    });
  } finally {
    teardown = spawnSync('docker', [...command, 'down', '--remove-orphans'], {
      cwd: resolve('.'), encoding: 'utf8', env: environment,
    });
  }
  writeFileSync(join(rootPath, 'output', 'compose-output.log'), [
    result?.stdout ?? '', result?.stderr ?? '', '\n-- teardown --\n', teardown?.stdout ?? '', teardown?.stderr ?? '',
  ].join(''), { flag: 'wx', mode: 0o600 });
  assert.equal(result.status, 0, `branch Compose failed: ${(result.stderr ?? result.stdout ?? '').split('\n')[0]}`);
  assert.equal(teardown.status, 0, `branch Compose teardown failed: ${(teardown.stderr ?? teardown.stdout ?? '').split('\n')[0]}`);
}

function runBranch(branchPlan, parentBundle, networks) {
  const childRoot = join(root, branchPlan.config.runId);
  assert.equal(existsSync(childRoot), false, `single-use branch evidence already exists: ${branchPlan.config.runId}`);
  prepare(childRoot);
  const parentDestination = join(childRoot, 'output', 'bundles', 'runs', parentRunId);
  cpSync(parentBundle, parentDestination, { recursive: true, errorOnExist: true });
  assert.deepEqual(json(join(parentDestination, 'run-manifest.json')), json(join(parentBundle, 'run-manifest.json')),
    'copied parent bundle changed before child launch');
  writeFileSync(join(childRoot, 'config', 'run-config.json'), `${JSON.stringify(branchPlan.config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  compose(childRoot, branchPlan.config.runId, networks);
  const output = join(childRoot, 'output');
  const result = json(join(output, 'lv01-paired-branch-result.json'));
  assert.equal(result.state, 'sealed');
  assert.equal(result.turnCount, 1);
  const bundle = join(output, 'bundle');
  const turn = readFileSync(join(bundle, 'turn-records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(turn.length, 1);
  const interventions = readFileSync(join(bundle, 'intervention-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const prediction = interventions.find((entry) => entry.reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed');
  assert.ok(prediction, 'branch has no pre-action LV01 prediction commitment');
  assert.deepEqual(prediction.details.preStateCommitment, branchPlan.config.lv01PairedCase.preStateCommitment);
  return {
    branch: branchPlan.branch,
    scenarioHash: turn[0].scenarioStateHash,
    receiverDrawCommitment: hashCanonical('lv01-receiver-draw/v1', turn[0].roles),
    preStateCommitment: branchPlan.config.lv01PairedCase.preStateCommitment,
    predictionCommitment: prediction.details.commitment,
    actionRecordedAfterPrediction: true,
    restoredBeforeAction: true,
    runId: branchPlan.config.runId,
  };
}

requirePacket();
if (mode === '--check') {
  assert.equal(existsSync(root), false, 'paired-case evidence already exists; audit retained evidence instead');
  console.log(`LV01 paired development v${version} is configured but unexecuted`);
  process.exit(0);
}

assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'paired collector requires a clean committed source tree');
assert.equal(existsSync(root), false, 'paired-case evidence is single-use');
mkdirSync(root, { recursive: false, mode: 0o700 });
let stage = 'parent-launch';
try {
  const parentLaunch = spawnSync(process.execPath, ['deploy/mode-r/run-lv01-slot.mjs', '--run', version], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(parentLaunch.status, 0, `parent fixture failed: ${(parentLaunch.stderr ?? parentLaunch.stdout ?? '').split('\n')[0]}`);
  const parentBundle = join(parentRoot, 'output', 'bundle');
  const parentConfig = json(join(parentBundle, 'configuration', 'run-config.json'));
  const checkpoint = lastCheckpoint(parentBundle);
  const plan = createLv01PairedCasePlan({ parent: parentConfig, parentCheckpointHash: checkpoint.checkpointHash,
    babyAInitialPolicyRef: 'policies/baby-a-latest.json', babyBInitialPolicyRef: 'policies/baby-b-latest.json',
    childRunIdPrefix: `lv01-paired-development-v${version}-p0001` });
  const branches = plan.branches.map((branch, index) => {
    stage = `branch:${branch.branch}`;
    return runBranch(branch, parentBundle, packet.networkAllocation.children[branch.branch]);
  });
  const verification = verifyLv01PairedCase(branches);
  writeFileSync(join(root, 'paired-case-receipt.json'), `${JSON.stringify({ schemaVersion: 1,
    classification: 'lv01-seven-branch-development-fixture', researchFinding: false,
    scientificDisposition: 'not-tested', parentRunId, parentCheckpointHash: checkpoint.checkpointHash,
    preStateCommitment: plan.preStateCommitment, branches, ...verification,
    claimBoundary: 'One local seven-branch software fixture. It is not a pilot or behavioral result.' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`LV01 paired development complete: ${verification.caseCommitment}; no research finding`);
} catch (error) {
  writeFileSync(join(root, 'paired-case-failure.json'), `${JSON.stringify({
    schemaVersion: 1, classification: 'lv01-seven-branch-development-fixture', researchFinding: false,
    scientificDisposition: 'not-tested', parentRunId, stage,
    failure: `${error.name}: ${error.message.split('\n')[0]}`,
    claimBoundary: 'The local paired development fixture did not complete. No pilot or behavioral result exists.',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  throw error;
}
