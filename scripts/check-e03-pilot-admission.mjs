import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson, hashCanonical } from '@ald/hashing';
import { evaluateResearchPreflight } from '@ald/ops';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';
import { resolveRewrittenCommit } from './git-history-rewrite.mjs';

const attemptVersion = process.argv.includes('--v3') ? 'v3' :
  process.argv.includes('--v2') ? 'v2' : 'v1';
const packetPath = `protocols/e03-pilot-registration.${attemptVersion}.json`;
const bindingPath = `protocols/e03-pilot-registration-binding.${attemptVersion}.json`;
const evidenceRoot = `evidence/pilots/e03-blinded-${attemptVersion}`;
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
const gib = 1024 ** 3;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (path) => sha256(readFileSync(path));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const ancestor = (left, right) => {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', resolveRewrittenCommit(left), right]);
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

export function assertFrozenE03Sources(protocolCommit, executionCommit) {
  assert.match(protocolCommit, /^[a-f0-9]{40}$/u);
  assert.match(executionCommit, /^[a-f0-9]{40}$/u);
  const sourceDiff = spawnSync('git', ['diff', '--quiet', '--no-ext-diff',
    resolveRewrittenCommit(protocolCommit), executionCommit, '--', 'packages', 'twins', 'deploy', 'scripts']);
  assert.equal(sourceDiff.status, 0,
    'E03 execution sources changed after the protocol base commit; amend and register fresh allocations');
}

function checkOriginalTopology(topology) {
  assert.equal(topology.classification, 'original-prototype-development-audit');
  assert.equal(topology.profile, 'prototype-v2');
  assert.equal(topology.auditExitStatus, 0);
  assert.equal(topology.conditionsAudited, 6);
  assert.equal(topology.roleContainerCount, 0);
  assert.equal(topology.nurseryContainerCount, 6);
  assert.equal(topology.sharedProcessCheck, true);
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
    assert.equal(slot.signedOriginalDataReconciled, true,
      'development pairing must derive from signed original control data');
    const path = join('evidence/qualification/e03-topology-prototype-v2',
      `e03-topology-prototype-v2-${slot.condition}`);
    assert.equal(digest(join(path, 'slot.json')), slot.slotSha256);
    assert.equal(slot.learnerResourceSha256, null);
    assert.equal(existsSync(join(path, 'learner-resources.json')), false);
    assert.match(slot.nurseryContainerId, /^[a-f0-9]{12}$/u);
    assert.deepEqual(slot.roleProcessIds,
      { 'baby-a': slot.nurseryProcessId, 'baby-b': slot.nurseryProcessId });
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
  const maxHostOverheadHours = Math.max(0,
    original.wallMilliseconds - original.slots.reduce((total, slot) =>
      total + slot.wallMilliseconds, 0)) / 6 / 3_600_000;
  assert.ok(allocation.reservedCpuHours >= Math.max(1,
    tenth((maxContainerCpuHours + hostCpuHours / 6) * 120 * 2)),
  'pilot CPU reserve is below the measured prospective rule');
  assert.ok(allocation.reservedWorkingStorageGiB >= Math.max(1,
    tenth(maxEvidenceGiB * 120 * 2)),
  'pilot evidence reserve is below the measured prospective rule');
  assert.ok(allocation.maximumResidentGiB >= Math.max(1,
    tenth((maxResidentGiB + hostResidentGiB) * 1.5)),
  'pilot resident-memory reserve is below the measured prospective rule');
  assert.ok(allocation.measuredMaximums.maximumPerSlotHostOverheadHours >= maxHostOverheadHours,
    'pilot host startup/audit wall overhead is below the measured topology');
  assert.ok(allocation.projectedSequentialWallHours >=
    tenth((maxWallHours + maxHostOverheadHours) * 120 * 1.25),
  'pilot sequential wall projection omits observed host overhead');

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
    slot.containerResourceUsage.cpuUsageMicroseconds, 0) / 3_600_000_000;
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
  if (attemptVersion !== 'v1') {
    const amendmentPath = `protocols/e03-pilot-registration-amendment.${attemptVersion}.json`;
    const amendment = read(amendmentPath);
    const priorVersion = attemptVersion === 'v3' ? 'v2' : 'v1';
    const prior = read(`protocols/e03-pilot-registration.${priorVersion}.json`);
    assert.equal(artifact.parameters.executionBinding.registrationAmendment?.path,
      amendmentPath);
    assert.equal(artifact.parameters.executionBinding.registrationAmendment?.sha256,
      digest(amendmentPath));
    assert.equal(amendment.priorRegistrationHash, prior.preRegistrationHash);
    assert.equal(amendment.priorSeedsUsed, false);
    assert.equal(existsSync(amendment.priorPilotEvidenceRoot), false,
      'prior pilot outcomes exist; the prospective unused-registration amendment is invalid');
    const runIds = (registered) => new Set(registered.runs.map((run) => run.config.runId));
    const seeds = (registered) => new Set(registered.runs.flatMap((run) =>
      Object.values(run.config.seedBindings ?? {}).filter((seed) => typeof seed === 'string')));
    assert.ok(packet.runs.every((run) => run.config.runId.startsWith(`e03-pilot-${attemptVersion}-`)));
    for (const version of attemptVersion === 'v3' ? ['v1', 'v2'] : ['v1']) {
      const registered = read(`protocols/e03-pilot-registration.${version}.json`);
      assert.equal(existsSync(`evidence/pilots/e03-blinded-${version}`), false,
        `${version} pilot evidence exists; fresh-registration premise is invalid`);
      const priorRunIds = runIds(registered);
      const priorSeeds = seeds(registered);
      assert.ok([...runIds(packet)].every((runId) => !priorRunIds.has(runId)),
        `${attemptVersion} pilot reuses a ${version} registered run identifier`);
      assert.ok([...seeds(packet)].every((seed) => !priorSeeds.has(seed)),
        `${attemptVersion} pilot reuses a ${version} registered seed`);
    }
  }
  assert.equal(packet.preRegistrationHash, hashCanonical(HASH_DOMAINS.preRegistration, artifact));
  assert.equal(packet.canonicalArtifact, canonicalJson(artifact));
  const binding = read(bindingPath);
  const packetCommit = git('log', '-1', '--format=%H', '--', packetPath);
  assert.ok(ancestor(artifact.protocolGitCommit, packetCommit));
  assert.ok(ancestor(packetCommit, head));
  assertFrozenE03Sources(artifact.protocolGitCommit, head);
  assert.equal(packetBytes.toString('utf8'),
    execFileSync('git', ['show', `${packetCommit}:${packetPath}`], { encoding: 'utf8' }));
  const activation = spawnSync(process.execPath,
    ['scripts/activate-e03-registration.mjs', 'pilot', '--check', attemptVersion],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(activation.status, 0, activation.error?.message ?? activation.stderr);
  assert.equal(binding.repositoryRegistration.commit, packetCommit);
  assert.equal(binding.preRunAnchor.anchorClass, 'simulated');
  assert.equal(binding.preRunAnchor.status, 'confirmed');

  const execution = artifact.parameters.executionBinding;
  assert.equal(execution.topology.mode, 'prototype');
  assert.equal(execution.topology.learnerContainersPerSlot, 0);
  assert.equal(execution.topology.nurseryContainersPerSlot, 1);
  assert.equal(execution.topology.sharedNurseryProcess, true);
  assert.equal(execution.topology.maximumParallelSlots, 1);
  assert.equal(execution.topology.adapterTransport, 'in-process');
  assert.equal(execution.topology.adapterTiming, 'immediate');
  assert.equal(execution.topology.turnResponseBudgetMs, 2_000);
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
  assert.deepEqual(process.argv.slice(2), attemptVersion === 'v1' ? ['--live'] :
    ['--live', `--${attemptVersion}`],
  'usage: node scripts/check-e03-pilot-admission.mjs --live [--v2|--v3]');
  console.log(JSON.stringify(validateE03PilotAdmission(), null, 2));
}
