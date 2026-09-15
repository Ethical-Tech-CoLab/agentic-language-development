import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson, hashCanonical } from '@ald/hashing';
import { evaluateResearchPreflight } from '@ald/ops';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';

const packetPath = 'protocols/e03-pilot-registration.v1.json';
const bindingPath = 'protocols/e03-pilot-registration-binding.v1.json';
const evidenceRoot = 'evidence/pilots/e03-blinded-v1';
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
const gib = 1024 ** 3;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (path) => sha256(readFileSync(path));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const ancestor = (left, right) => {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', left, right]);
  return result.status === 0;
};
const tenth = (value) => Math.ceil(value * 10) / 10;

function originalBytes(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path}: original evidence must not be a symlink`);
  if (stat.isFile()) return stat.size;
  assert.equal(stat.isDirectory(), true, `${path}: unexpected evidence entry`);
  return readdirSync(path).reduce((total, entry) => total + originalBytes(join(path, entry)), 0);
}

function sourceTreeDigest() {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter((path) =>
      path.startsWith('packages/') || path.startsWith('twins/') ||
      path.startsWith('deploy/') || path.startsWith('scripts/'));
  return sha256(Buffer.from(paths.map((path) =>
    `${path}\t${digest(path)}\n`).sort().join(''), 'utf8'));
}

function checkOriginalTopology(topology) {
  assert.equal(topology.classification, 'original-prototype-development-audit');
  assert.equal(topology.profile, 'prototype-v2');
  assert.equal(topology.auditExitStatus, 0);
  assert.equal(topology.conditionsAudited, 6);
  assert.equal(topology.roleContainerCount, 12);
  assert.equal(topology.pairedScenarioCheck, true);
  assert.equal(topology.typescriptVerifierPassed, true);
  assert.equal(topology.rustAuditorPassed, true);
  assert.equal(topology.passed, true);
  assert.equal(topology.researchFinding, false);
  assert.equal(topology.externalSpend, 0);
  assert.equal(topology.publicChainTransaction, false);
  assert.equal(digest(topology.rawReceiptPath), topology.rawReceiptSha256);
  const original = read(topology.rawReceiptPath);
  assert.equal(original.executionCommit, topology.executionCommit);
  assert.equal(original.profile, 'prototype-v2');
  assert.equal(original.slots.length, 6);
  assert.equal(original.passed, true);
  assert.deepEqual(topology.originalSlots.map((slot) => slot.condition), conditions);
  for (const slot of topology.originalSlots) {
    const path = join('evidence/qualification/e03-topology-prototype-v2',
      `e03-topology-prototype-v2-${slot.condition}`);
    assert.equal(digest(join(path, 'slot.json')), slot.slotSha256);
    assert.equal(digest(join(path, 'learner-resources.json')), slot.learnerResourceSha256);
    assert.equal(originalBytes(path), slot.originalEvidenceBytes);
  }
  const audit = spawnSync(process.execPath,
    ['scripts/run-e03-topology-qualification.mjs', '--audit-prototype-v2'],
    { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(audit.status, 0, audit.error?.message ?? audit.stderr);
  return original;
}

function checkResourceAllocation(allocation, policy, topology, original) {
  assert.equal(allocation.experimentId, 'E03');
  assert.equal(allocation.classification, 'prospective-local-stage-allocation');
  assert.equal(allocation.stage, 'blinded-pilot');
  assert.equal(allocation.decision, 'ready');
  assert.equal(allocation.plannedRuns, 120);
  assert.equal(allocation.primarySlotsPerCondition, 20);
  assert.equal(allocation.reserveSlots, 0);
  assert.equal(allocation.maximumParallelRuns, 1);
  assert.equal(allocation.externalSpend, 0);
  assert.equal(allocation.publicChainTransaction, false);
  assert.equal(allocation.policySourceSha256,
    digest('protocols/seed-and-resource-allocation.v1.json'));
  assert.equal(allocation.measurementSourceSha256,
    digest('reports/research/e03-prototype-topology-audit-receipt.json'));

  const observed = topology.originalSlots;
  const hostCpuHours = (original.hostResourceUsage.userCPUTime +
    original.hostResourceUsage.systemCPUTime) / 3_600_000_000;
  const maxContainerCpuHours = Math.max(...observed.map((slot) =>
    slot.containerCpuUsageMicroseconds / 3_600_000_000));
  const maxEvidenceGiB = Math.max(...observed.map((slot) =>
    slot.originalEvidenceBytes / gib));
  const maxResidentGiB = Math.max(...observed.map((slot) =>
    slot.combinedContainerPeakBytes / gib));
  const hostResidentGiB = original.hostResourceUsage.maxRSS * 1024 / gib;
  const maxWallHours = Math.max(...observed.map((slot) =>
    slot.wallMilliseconds / 3_600_000));
  assert.ok(allocation.reservedCpuHours >= Math.max(1,
    tenth((maxContainerCpuHours + hostCpuHours / 6) * 120 * 2)),
  'pilot CPU reserve is below the measured prospective rule');
  assert.ok(allocation.reservedWorkingStorageGiB >= Math.max(1,
    tenth(maxEvidenceGiB * 120 * 2)),
  'pilot evidence reserve is below the measured prospective rule');
  assert.ok(allocation.maximumResidentGiB >= Math.max(1,
    tenth((maxResidentGiB + hostResidentGiB) * 1.5)),
  'pilot resident-memory reserve is below the measured prospective rule');
  assert.ok(allocation.projectedSequentialWallHours >= tenth(maxWallHours * 120 * 1.25));

  const prior = read('evidence/qualification/e03-topology-development-v1/receipt.json');
  assert.equal(prior.experimentId, 'E03');
  assert.equal(prior.slots.length, 6);
  const priorCpuHours = (prior.hostResourceUsage.userCPUTime +
    prior.hostResourceUsage.systemCPUTime +
    prior.slots.reduce((total, slot) => total +
      slot.containerResourceUsage.cpuUsageMicroseconds +
      slot.learnerContainerResourceUsage['baby-a'].cpuUsageMicroseconds +
      slot.learnerContainerResourceUsage['baby-b'].cpuUsageMicroseconds, 0)) / 3_600_000_000;
  const prototypeCpuHours = hostCpuHours + original.slots.reduce((total, slot) => total +
    slot.containerResourceUsage.cpuUsageMicroseconds +
    slot.learnerContainerResourceUsage['baby-a'].cpuUsageMicroseconds +
    slot.learnerContainerResourceUsage['baby-b'].cpuUsageMicroseconds, 0) / 3_600_000_000;
  assert.ok(allocation.priorCpuHoursCharged >= tenth(22 + priorCpuHours + prototypeCpuHours),
    'prior CPU charge understates retained attempts');
  const retainedGiB = (originalBytes('evidence/qualification/e02-v3') +
    originalBytes('evidence/qualification/e03-topology-development-v1') +
    originalBytes('evidence/qualification/e03-topology-prototype-v2')) / gib;
  assert.ok(allocation.priorRetainedStorageGiB >= tenth(retainedGiB),
    'prior storage charge understates retained evidence');
  assert.ok(allocation.priorCpuHoursCharged + allocation.reservedCpuHours <= policy.localCeiling.cpuHours);
  assert.ok(allocation.priorRetainedStorageGiB + allocation.reservedWorkingStorageGiB <=
    policy.localCeiling.workingStorageGiB);
  assert.ok(allocation.maximumResidentGiB <= policy.localCeiling.maximumResidentGiB);
  assert.equal(policy.localCeiling.externalSpend, 0);
  const filesystem = statfsSync('.');
  assert.ok(filesystem.bavail * filesystem.bsize >= allocation.reservedWorkingStorageGiB * gib,
    'host free storage is below the prospective pilot reserve');
}

export function validateE03PilotAdmission() {
  assert.equal(git('status', '--porcelain'), '', 'pilot admission requires a clean execution commit');
  assert.equal(existsSync(evidenceRoot), false, 'pilot evidence allocation is single-use');
  const head = git('rev-parse', 'HEAD');
  const packetBytes = readFileSync(packetPath);
  const packet = JSON.parse(packetBytes.toString('utf8'));
  const artifact = PreRegistrationArtifactSchema.parse(packet.artifact);
  assert.equal(artifact.experimentId, 'E03');
  assert.equal(artifact.parameters.stage, 'blinded-pilot');
  assert.equal(packet.preRegistrationHash, hashCanonical(HASH_DOMAINS.preRegistration, artifact));
  assert.equal(packet.canonicalArtifact, canonicalJson(artifact));
  const binding = read(bindingPath);
  const packetCommit = git('log', '-1', '--format=%H', '--', packetPath);
  assert.ok(ancestor(artifact.protocolGitCommit, packetCommit));
  assert.ok(ancestor(packetCommit, head));
  assert.equal(packetBytes.toString('utf8'),
    execFileSync('git', ['show', `${packetCommit}:${packetPath}`], { encoding: 'utf8' }));
  const activation = spawnSync(process.execPath,
    ['scripts/activate-e03-registration.mjs', 'pilot', '--check'],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(activation.status, 0, activation.error?.message ?? activation.stderr);
  assert.equal(binding.repositoryRegistration.commit, packetCommit);
  assert.equal(binding.preRunAnchor.anchorClass, 'simulated');
  assert.equal(binding.preRunAnchor.status, 'confirmed');

  const execution = artifact.parameters.executionBinding;
  assert.equal(execution.topology.mode, 'prototype');
  assert.equal(execution.topology.maximumParallelSlots, 1);
  assert.equal(execution.signing.provider, 'controller-ephemeral-per-run');
  assert.equal(execution.signing.exactRunAuthorization, false);
  assert.equal(sourceTreeDigest(), execution.rootBuildInputs.sourceTreeSha256);
  assert.equal(digest('pnpm-lock.yaml'), execution.rootBuildInputs.lockfileSha256);
  assert.equal(sha256(execFileSync('git', ['show',
    `${artifact.protocolGitCommit}:package.json`])), execution.rootBuildInputs.packageJsonSha256);
  for (const source of execution.sourceFiles) assert.equal(digest(source.path), source.sha256,
    `${source.path}: source binding changed`);

  const review = read('protocols/campaign-readiness-review.v1.json');
  for (const id of ['E00', 'E01', 'E02']) {
    const entry = review.experiments.find((candidate) => candidate.id === id);
    assert.equal(entry?.executionReadiness.decision, 'complete', `${id}: software prerequisite incomplete`);
    assert.equal(entry?.attempt.status, 'completed');
  }
  const e03 = review.experiments.find((entry) => entry.id === 'E03');
  assert.equal(e03?.executionReadiness.stage, 'pilot');
  assert.equal(e03?.executionReadiness.decision, 'ready', 'E03 pilot status has not passed its progression gate');
  assert.deepEqual(e03.executionReadiness.reasonCodes, []);
  assert.equal(e03.attempt.status, 'not-started');
  assert.equal(e03.scientificDisposition, 'not-tested');

  const terminal = read(execution.dependency.receiptPath);
  assert.equal(digest(execution.dependency.receiptPath), execution.dependency.receiptSha256);
  const e02Audit = read('reports/research/e02-v3-full-audit-receipt.json');
  assert.equal(e02Audit.terminalReceiptSha256, execution.dependency.receiptSha256);
  assert.equal(e02Audit.auditExitStatus, 0);
  assert.equal(e02Audit.probeReportsRecomputed, 60);
  assert.equal(terminal.passed, true);
  assert.equal(terminal.registrationHash, execution.dependency.registrationHash);
  const topology = read(execution.prototypeTopology.path);
  assert.equal(digest(execution.prototypeTopology.path), execution.prototypeTopology.sha256);
  assert.ok(ancestor(topology.executionCommit, head));
  const originalTopology = checkOriginalTopology(topology);
  const policy = read(execution.resourceAllocation.path);
  assert.equal(digest(execution.resourceAllocation.path), execution.resourceAllocation.sha256);
  const allocation = read(execution.stageResourceAllocation.path);
  assert.equal(digest(execution.stageResourceAllocation.path), execution.stageResourceAllocation.sha256);
  checkResourceAllocation(allocation, policy, topology, originalTopology);
  for (const field of ['reservedCpuHours', 'reservedWorkingStorageGiB',
    'maximumResidentGiB', 'priorCpuHoursCharged', 'priorRetainedStorageGiB']) {
    assert.equal(execution.stageResourceAllocation[field], allocation[field]);
  }

  const governance = read('protocols/research-governance-and-funding.v1.json');
  assert.equal(governance.status, 'approved');
  assert.equal(governance.dataScope.syntheticOnly, true);
  assert.equal(governance.dataScope.personalDataPermitted, false);
  assert.equal(governance.fundingPolicy.profile, 'simulation-only');
  assert.equal(governance.fundingPolicy.externalSpendAuthorized, 0);
  assert.equal(governance.fundingPolicy.publicChainTransactionsAuthorized, false);
  const seedManifest = artifact.parameters.seedManifest;
  assert.equal(seedManifest.stage, 'blinded-pilot');
  assert.equal(seedManifest.reserveSeeds, 0);
  assert.equal(seedManifest.entries.length, 20);
  assert.deepEqual(artifact.parameters.communicationConditions, conditions);
  assert.equal(packet.runs.length, 120);
  assert.equal(new Set(packet.runs.map((run) => run.config.runId)).size, 120);
  for (const condition of conditions) assert.equal(packet.runs.filter((run) =>
    run.condition === condition && run.use === 'primary').length, 20);
  assert.match(artifact.parameters.reservePolicy, /zero reserves/u);
  assert.match(artifact.analysisPlan, /no outcome-dependent stopping/u);

  const repository = {
    headCommit: head, clean: true, protocolCommitIsAncestor: true,
    registrationRecordMatches: true,
  };
  for (const run of packet.runs) {
    const report = evaluateResearchPreflight({
      config: run.config, artifact, preRegistrationHash: packet.preRegistrationHash,
      binding, repository,
    });
    assert.equal(report.ready, true,
      `${run.config.runId}: registered preflight failed ${report.blockers.join(', ')}`);
  }
  return {
    schemaVersion: 1, experimentId: 'E03', stage: 'blinded-pilot',
    classification: 'pre-execution-admission-gate', decision: 'ready',
    researchFinding: false, scientificDisposition: 'not-tested',
    executionCommit: head, protocolCommit: artifact.protocolGitCommit,
    packetCommit, registrationHash: packet.preRegistrationHash,
    packetSha256: digest(packetPath), bindingSha256: digest(bindingPath),
    topologyAuditSha256: execution.prototypeTopology.sha256,
    resourceAllocationSha256: execution.stageResourceAllocation.sha256,
    plannedRuns: 120, validRegisteredPreflights: 120,
    reservedCpuHours: allocation.reservedCpuHours,
    reservedWorkingStorageGiB: allocation.reservedWorkingStorageGiB,
    priorCpuHoursCharged: allocation.priorCpuHoursCharged,
    priorRetainedStorageGiB: allocation.priorRetainedStorageGiB,
    externalSpend: 0, publicChainTransaction: false,
    checkedAt: new Date().toISOString(),
    claimBoundary: 'Exact zero-spend registered E03 pilot admission only; no pilot data has been collected and no behavioral or Research-Grade isolation claim follows.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.deepEqual(process.argv.slice(2), ['--live'],
    'usage: node scripts/check-e03-pilot-admission.mjs --live');
  console.log(JSON.stringify(validateE03PilotAdmission(), null, 2));
}
