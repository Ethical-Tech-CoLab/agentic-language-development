import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
const runId = `lv01-development-v${version}-p0001`;
const slotRoot = join(evidenceRoot, runId);
const resultPath = join(slotRoot, 'output', 'lv01-fixture-result.json');
const resourcePath = join(slotRoot, 'output', 'lv01-fixture-resources.json');
const authorityPath = join(slotRoot, 'output', 'lv01-authority-observation.json');
const composeLogPath = join(slotRoot, 'output', 'compose-output.log');
const authorityFailurePath = join(slotRoot, 'output', 'lv01-authority-failure.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const allocation = existsSync(allocationPath)
  ? JSON.parse(readFileSync(allocationPath, 'utf8'))
  : null;
const controllerStage = process.env.ALD_MODE_R_CONTROLLER_STAGE ?? 'lv01-fixture';
assert.equal(controllerStage, 'lv01-fixture',
  'LV01 slot runner accepts only the fixture controller stage; detector observation is owned by the outer collector');

const APPLICATION_SERVICES = [
  'model-adapter-a', 'model-adapter-b', 'baby-a', 'baby-b',
  'signer-baby-a-ledger', 'signer-baby-b-ledger', 'signer-channel',
  'signer-affect', 'signer-audit', 'witness-signer', 'evidence-writer',
  'gateway', 'checkpoint', 'simulated-anchor', 'audit-interpreter',
  'controller-scenario', 'offline-verifier',
];

function networkAllocation(runOrdinal = 0) {
  const thirdOctet = 1 + (Number(version) * 8) + runOrdinal;
  assert.ok(thirdOctet <= 255, 'LV01 isolated-network allocation requires a new version range');
  return {
    babyA: `10.250.${thirdOctet}.0/28`,
    babyB: `10.250.${thirdOctet}.16/28`,
    controlPlane: `10.250.${thirdOctet}.32/28`,
  };
}

function inspectServiceAccess(containerId, service, target) {
  const probe = spawnSync('docker', [
    'exec', containerId, '/usr/local/bin/node', '-e',
    "process.exit(require('node:fs').existsSync(process.argv[1]) ? 0 : 1)", target,
  ], { encoding: 'utf8' });
  const exitCode = probe.status ?? -1;
  return { service, target, exitCode, denied: exitCode === 1 };
}

function projectContainerIds(project, all = false) {
  return execFileSync('docker', ['ps', ...(all ? ['--all'] : []), '--quiet',
    '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
}

function authorityObservation(project) {
  const ids = projectContainerIds(project, true);
  if (ids.length !== APPLICATION_SERVICES.length) return null;
  const containers = JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' }));
  const services = new Map(containers.map((container) => [
    container.Config.Labels['com.docker.compose.service'], container,
  ]));
  assert.deepEqual([...services.keys()].sort(), [...APPLICATION_SERVICES].sort(),
    'selected application services differ from the expected 17-role topology');
  if (['controller-scenario', 'baby-a', 'baby-b'].some((service) =>
    !services.get(service).State.Running)) return null;
  for (const service of APPLICATION_SERVICES) {
    const container = services.get(service);
    assert.equal(container.HostConfig.ReadonlyRootfs, true, `${service} root must be read-only`);
    assert.ok(container.HostConfig.CapDrop.includes('ALL'), `${service} must drop all capabilities`);
  }
  const mountTargets = (service) => new Set(services.get(service).Mounts.map((mount) => mount.Destination));
  const controllerMounts = mountTargets('controller-scenario');
  assert.ok(![...controllerMounts].some((target) => target.startsWith('/run/ald-mode-r/model-')),
    'controller must not mount private model state');
  assert.ok(![...controllerMounts].some((target) => target.startsWith('/run/ald-mode-r/signer-')),
    'controller must not mount signer capabilities');
  assert.ok(mountTargets('baby-a').has('/run/ald-mode-r/model-a'));
  assert.ok(!mountTargets('baby-a').has('/run/ald-mode-r/model-b'));
  assert.ok(mountTargets('baby-b').has('/run/ald-mode-r/model-b'));
  assert.ok(!mountTargets('baby-b').has('/run/ald-mode-r/model-a'));
  const networks = (service) => Object.keys(services.get(service).NetworkSettings.Networks)
    .filter((network) => network !== 'none').sort();
  for (const service of ['model-adapter-a', 'model-adapter-b', 'signer-baby-a-ledger',
    'signer-baby-b-ledger', 'signer-channel', 'signer-affect', 'signer-audit',
    'witness-signer', 'offline-verifier']) {
    assert.equal(networks(service).length, 0,
      `${service} must have no network route`);
  }
  assert.equal(networks('baby-a').some((network) => networks('baby-b').includes(network)), false,
    'the two learner roles must not share a network');
  const access = [
    ['controller-scenario', '/run/ald-mode-r/model-a'],
    ['controller-scenario', '/run/ald-mode-r/model-b'],
    ['baby-a', '/run/ald-mode-r/model-b'],
    ['baby-b', '/run/ald-mode-r/model-a'],
  ].map(([service, target]) => inspectServiceAccess(services.get(service).Id, service, target));
  assert.ok(access.every((entry) => entry.denied), 'private-model access probe unexpectedly succeeded');
  return {
    schemaVersion: 1,
    classification: 'lv01-selected-application-authority-observation',
    researchFinding: false,
    scientificDisposition: 'not-tested',
    runId,
    services: APPLICATION_SERVICES.map((service) => {
      const container = services.get(service);
      return {
        service,
        containerId: container.Id,
        running: container.State.Running,
        processId: container.State.Pid,
        readOnlyRoot: container.HostConfig.ReadonlyRootfs,
        droppedCapabilities: container.HostConfig.CapDrop,
        networks: networks(service),
        mountTargets: [...mountTargets(service)].sort(),
      };
    }),
    deniedPrivateModelAccess: access,
    claimBoundary: 'A read-only live Docker inspection and negative filesystem probes for the selected LV01 application topology. It does not test malformed envelopes, recurrent state restoration, branch chronology, failure recovery, or behavioral outcomes.',
  };
}

function verifyAllocation() {
  assert.ok(allocation !== null, `missing ${allocationPath}`);
  assert.equal(allocation.studyId, 'LV01');
  assert.equal(allocation.classification, 'prospective-development-only-allocation');
  assert.equal(allocation.status, 'design-locked-not-executed');
  assert.equal(allocation.researchFinding, false);
  assert.equal(allocation.externalSpend, 0);
  assert.equal(allocation.allocation.smallFixture.runId, runId);
  assert.equal(allocation.allocation.smallFixture.trainingCases, 64);
  assert.equal(allocation.allocation.smallFixture.validationFitCases, 24);
  assert.equal(allocation.allocation.smallFixture.validationSelectionCases, 24);
  assert.equal(allocation.allocation.smallFixture.withinSupportTestCases, 24);
  assert.deepEqual(allocation.networkAllocation, networkAllocation());
  assert.equal(allocation.seedDerivation.slots.length, 6);
  for (const slot of allocation.seedDerivation.slots) {
    const derive = (purpose) => deriveSeedHex(allocation.seedDerivation.root,
      ...allocation.seedDerivation.parts.map((part) => {
        if (part === 'four-digit slot index') return slot.index;
        if (part === 'purpose') return purpose;
        return part;
      }));
    assert.equal(slot.scenario, derive('scenario'), 'scenario seed derivation');
    assert.equal(slot.babyA, derive('learner/baby-a'), 'baby A seed derivation');
    assert.equal(slot.babyB, derive('learner/baby-b'), 'baby B seed derivation');
    assert.equal(slot.gateway, derive('gateway'), 'gateway seed derivation');
    assert.equal(slot.analysis, derive('analysis'), 'analysis seed derivation');
  }
  assert.equal(execFileSync('git', ['rev-parse', `${allocation.sourceFreeze.commit}^{tree}`], { encoding: 'utf8' }).trim(), allocation.sourceFreeze.tree);
  assert.equal(JSON.parse(execFileSync('git', ['show', `${allocation.sourceFreeze.commit}:package.json`], { encoding: 'utf8' })).version, allocation.sourceFreeze.version);
  for (const artifact of allocation.sourceFreeze.artifacts) {
    const bytes = execFileSync('git', ['show', `${allocation.sourceFreeze.commit}:${artifact.path}`]);
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.sha256);
  }
  assert.ok(allocation.sourceFreeze.artifacts.some((artifact) => artifact.path === 'deploy/mode-r/run-lv01-slot.mjs'), 'allocation source closure does not bind this runner; compile a fresh version');
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
    interventionPlan: { version: 1, heldOutTypeCodes: [0, 5, 10, 15] },
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
    promptBundleHash: promptBundleHash(['scratch-rl'].map((track) => loadLearnerContract(track))),
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

function bytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB)$/u.exec(value.trim());
  if (match === null) return null;
  const scale = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40 }[match[2]];
  return Math.round(Number(match[1]) * scale);
}

function resourceSnapshot(project) {
  const capturedAt = new Date().toISOString();
  const ids = projectContainerIds(project);
  if (ids.length === 0) return [];
  try {
    return execFileSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean).flatMap((line) => {
      const stat = JSON.parse(line);
      const memory = bytes(String(stat.MemUsage ?? '').split('/')[0] ?? '');
      const cpuPercent = Number.parseFloat(String(stat.CPUPerc ?? '').replace('%', ''));
      return [{ capturedAt, container: String(stat.Name ?? 'unknown'), cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        memoryBytes: memory, pids: Number.parseInt(String(stat.PIDs ?? ''), 10) || null }];
    });
  } catch { return []; }
}

function summarizeResources(samples) {
  const services = new Map();
  for (const sample of samples) {
    for (const row of sample.rows) {
      const prior = services.get(row.container) ?? { maxCpuPercent: 0, maxMemoryBytes: 0, maxPids: 0, estimatedCpuSeconds: 0, lastAt: null };
      const now = Date.parse(row.capturedAt);
      if (prior.lastAt !== null && row.cpuPercent !== null) prior.estimatedCpuSeconds += (row.cpuPercent / 100) * ((now - prior.lastAt) / 1_000);
      prior.maxCpuPercent = Math.max(prior.maxCpuPercent, row.cpuPercent ?? 0);
      prior.maxMemoryBytes = Math.max(prior.maxMemoryBytes, row.memoryBytes ?? 0);
      prior.maxPids = Math.max(prior.maxPids, row.pids ?? 0);
      prior.lastAt = now;
      services.set(row.container, prior);
    }
  }
  return [...services.entries()].map(([container, value]) => ({ container, ...value, lastAt: undefined }));
}

async function runComposeWithMeasurements(compose, environment) {
  const startedAt = new Date().toISOString();
  const project = compose[compose.indexOf('--project-name') + 1];
  const samples = [];
  let authority = null;
  let authorityFailure = null;
  const sample = () => {
    try { samples.push({ capturedAt: new Date().toISOString(), rows: resourceSnapshot(project) }); }
    catch { /* Resource observation must not alter the fixture outcome. */ }
    if (authority === null && authorityFailure === null) {
      try { authority = authorityObservation(project); }
      catch (error) { authorityFailure = `${error.name}: ${error.message}`; }
    }
  };
  const child = spawn('docker', [...compose, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'offline-verifier'], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setInterval(sample, 1_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    sample();
    writeFileSync(resourcePath, `${JSON.stringify({
      schemaVersion: 1, classification: 'lv01-development-resource-observation', researchFinding: false,
      scientificDisposition: 'not-tested', runId, startedAt, endedAt: new Date().toISOString(),
      samplingIntervalMs: 1_000, sampleCount: samples.length, samples,
      services: summarizeResources(samples),
      claimBoundary: 'Sampled local Docker observations support only bounded development resource accounting; they are not a calibrated resource authorization or scientific result.',
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assert.ok(authority !== null, authorityFailure ?? 'selected authority observation was never available');
    writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    if (code !== 0) throw new Error(`docker compose exited with ${String(code)}: ${output.split('\n')[0]}`);
    return output;
  } finally {
    clearInterval(timer);
    const teardown = spawnSync('docker', [...compose, 'down', '--remove-orphans'], {
      env: environment, encoding: 'utf8',
    });
    output += `\n-- teardown --\n${teardown.stdout ?? ''}${teardown.stderr ?? ''}`;
    writeFileSync(composeLogPath, output, { flag: 'wx', mode: 0o600 });
    if (authority === null) {
      writeFileSync(authorityFailurePath, `${JSON.stringify({
        schemaVersion: 1,
        classification: 'lv01-selected-application-authority-observation',
        researchFinding: false,
        scientificDisposition: 'not-tested',
        runId,
        failure: authorityFailure ?? 'no live selected-application authority observation was available',
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    assert.equal(teardown.status, 0, `LV01 fixture teardown failed: ${(teardown.stderr ?? teardown.stdout ?? '').split('\n')[0]}`);
  }
}

verifyAllocation();
if (mode === '--check') {
  assert.equal(existsSync(slotRoot), false, 'fixture evidence already exists; audit the retained attempt instead');
  console.log(`LV01 development fixture v${version} is configured but unexecuted`);
  process.exit(0);
}

assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'LV01 fixture requires a clean committed source tree');
assert.equal(existsSync(slotRoot), false, 'LV01 fixture evidence is single-use');
prepareDirectories();
let resolvedConfig;
try { resolvedConfig = config(); }
catch (error) {
  writeFileSync(join(slotRoot, 'fixture-failure.json'), `${JSON.stringify({
    schemaVersion: 1, classification: 'lv01-development-topology-fixture', researchFinding: false,
    scientificDisposition: 'not-tested', runId, stage: 'configuration',
    failure: `${error.name}: ${error.message}`,
    claimBoundary: 'The development fixture failed before Docker launch. No pilot, scientific result, or resource measurement exists.',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  throw error;
}
writeFileSync(join(slotRoot, 'config', 'run-config.json'), `${JSON.stringify(resolvedConfig, null, 2)}\n`, { mode: 0o600 });
const environment = {
  ...process.env,
  ALD_MODE_R_APPLICATION_ROOT: resolve(slotRoot), ALD_SOFTWARE_COMMIT: commit,
  ALD_MODE_R_RUN_ID: runId,
  ALD_MODE_R_UID: String(process.getuid?.() ?? 1000), ALD_MODE_R_GID: String(process.getgid?.() ?? 1000),
  ALD_MODE_R_CONTROLLER_STAGE: controllerStage,
  ALD_MODE_R_BABY_A_SUBNET: allocation.networkAllocation.babyA,
  ALD_MODE_R_BABY_B_SUBNET: allocation.networkAllocation.babyB,
  ALD_MODE_R_CONTROL_PLANE_SUBNET: allocation.networkAllocation.controlPlane,
};
const compose = ['compose', '--project-name', `ald-lv01-development-v${version}`,
  '--file', 'deploy/mode-r/docker-compose.application.v1.yml',
  '--file', 'deploy/mode-r/docker-compose.lv01.v1.yml',
  '--file', 'deploy/mode-r/docker-compose.lv01-isolated-networks.v1.yml'];
let result;
let fixture;
try {
  result = await runComposeWithMeasurements(compose, environment);
  assert.ok(existsSync(resultPath), 'controller did not write the LV01 fixture result');
  fixture = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(fixture.state, 'sealed');
  assert.equal(fixture.trainingTurns, 64);
  assert.equal(fixture.evaluationTurns, 24);
  assert.equal(fixture.researchFinding, false);
} catch (error) {
  writeFileSync(join(slotRoot, 'fixture-failure.json'), `${JSON.stringify({
    schemaVersion: 1, classification: 'lv01-development-topology-fixture', researchFinding: false,
    scientificDisposition: 'not-tested', runId,
    stage: existsSync(resultPath) ? 'result-validation' : 'container-execution',
    failure: `${error.name}: ${error.message.split('\n')[0]}`,
    claimBoundary: 'The development fixture reached the selected container topology but did not complete. No pilot, scientific result, or resource measurement exists.',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  throw error;
}
assert.ok(result.length >= 0);
console.log(`LV01 development fixture complete: ${fixture.runId}; no research finding`);
