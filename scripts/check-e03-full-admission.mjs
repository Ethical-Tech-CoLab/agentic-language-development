#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { canonicalJson, hashCanonical } from '@ald/hashing';
import { evaluateResearchPreflight } from '@ald/ops';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';
import { validateE03FullCollectorQualification } from './check-e03-full-collector-qualification.mjs';
import { assertFrozenE03Sources } from './check-e03-pilot-admission.mjs';
import { resolveRewrittenCommit } from './git-history-rewrite.mjs';

const packetPath = 'protocols/e03-full-registration.v1.json';
const bindingPath = 'protocols/e03-full-registration-binding.v1.json';
const evidenceRoot = 'evidence/qualification/e03-full-v1';
const allocationPath = 'protocols/e03-full-resource-allocation.v1.json';
const policyPath = 'protocols/seed-and-resource-allocation.v1.json';
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
const gib = 1024 ** 3;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (path) => sha256(readFileSync(path));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const ancestor = (left, right) => spawnSync('git', ['merge-base', '--is-ancestor',
  resolveRewrittenCommit(left), right]).status === 0;

function sourceTreeDigest() {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter((path) => path.startsWith('packages/') ||
      path.startsWith('twins/') || path.startsWith('deploy/') || path.startsWith('scripts/'));
  return sha256(Buffer.from(paths.map((path) => `${path}\t${digest(path)}\n`).sort().join(''), 'utf8'));
}

function validateAllocation(execution, allocation, policy) {
  assert.equal(execution.stageResourceAllocation.path, allocationPath);
  assert.equal(execution.stageResourceAllocation.sha256, digest(allocationPath));
  assert.equal(allocation.experimentId, 'E03');
  assert.equal(allocation.classification, 'prospective-local-stage-allocation');
  assert.equal(allocation.stage, 'full-qualification');
  assert.equal(allocation.decision, 'ready');
  assert.equal(allocation.plannedRuns, 168);
  assert.equal(allocation.primarySlotsPerCondition, 25);
  assert.equal(allocation.reserveSlotsPerCondition, 3);
  assert.equal(allocation.maximumParallelRuns, 1);
  assert.equal(allocation.externalSpend, 0);
  assert.equal(allocation.publicChainTransaction, false);
  assert.equal(allocation.policySourceSha256, digest(policyPath));
  assert.equal(allocation.sampleSizeDecisionSha256,
    digest('protocols/e03-sample-size-decision.v1.json'));
  assert.ok(allocation.priorCpuHoursCharged + allocation.reservedCpuHours <=
    policy.localCeiling.cpuHours);
  assert.ok(allocation.priorRetainedStorageGiB + allocation.reservedWorkingStorageGiB <=
    policy.localCeiling.workingStorageGiB);
  assert.ok(allocation.maximumResidentGiB <= policy.localCeiling.maximumResidentGiB);
  assert.equal(policy.localCeiling.externalSpend, 0);
  const filesystem = statfsSync('.');
  assert.ok(filesystem.bavail * filesystem.bsize >= allocation.reservedWorkingStorageGiB * gib,
    'host free storage is below the prospective E03 full-stage reserve');
}

export function validateE03FullAdmission() {
  assert.equal(git('status', '--porcelain'), '',
    'E03 full admission requires a clean execution commit');
  assert.equal(existsSync(evidenceRoot), false,
    'E03 full original evidence allocation is single-use');
  const head = git('rev-parse', 'HEAD');
  const packetBytes = readFileSync(packetPath);
  const packet = JSON.parse(packetBytes.toString('utf8'));
  const artifact = PreRegistrationArtifactSchema.parse(packet.artifact);
  assert.equal(artifact.experimentId, 'E03');
  assert.equal(artifact.registrationClass, 'qualification');
  assert.equal(artifact.parameters.stage, 'full-qualification');
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
    ['scripts/activate-e03-registration.mjs', 'full', '--check'],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(activation.status, 0, activation.error?.message ?? activation.stderr);
  assert.equal(binding.repositoryRegistration.commit, packetCommit);
  assert.equal(binding.preRegistrationHash, packet.preRegistrationHash);
  assert.equal(binding.preRunAnchor.anchorClass, 'simulated');
  assert.equal(binding.preRunAnchor.status, 'confirmed');

  const execution = artifact.parameters.executionBinding;
  assert.equal(execution.topology.mode, 'prototype');
  assert.equal(execution.topology.maximumParallelSlots, 1);
  assert.equal(execution.topology.nurseryContainersPerSlot, 1);
  assert.equal(execution.topology.learnerContainersPerSlot, 0);
  assert.equal(execution.topology.sharedNurseryProcess, true);
  assert.equal(execution.topology.adapterTransport, 'in-process');
  assert.equal(execution.topology.adapterTiming, 'immediate');
  assert.equal(execution.topology.turnResponseBudgetMs, 2_000);
  assert.equal(sourceTreeDigest(), execution.rootBuildInputs.sourceTreeSha256);
  assert.equal(digest('pnpm-lock.yaml'), execution.rootBuildInputs.lockfileSha256);
  assert.equal(sha256(execFileSync('git', ['show',
    `${artifact.protocolGitCommit}:package.json`])), execution.rootBuildInputs.packageJsonSha256);
  for (const source of execution.sourceFiles) {
    assert.equal(digest(source.path), source.sha256, `${source.path}: source binding changed`);
  }

  const review = read('protocols/campaign-readiness-review.v1.json');
  for (const id of ['E00', 'E01', 'E02']) {
    const entry = review.experiments.find((candidate) => candidate.id === id);
    assert.equal(entry?.executionReadiness.decision, 'complete', `${id}: prerequisite incomplete`);
    assert.equal(entry?.attempt.status, 'completed');
  }
  const e03 = review.experiments.find((entry) => entry.id === 'E03');
  assert.equal(e03?.executionReadiness.stage, 'qualification');
  assert.equal(e03?.executionReadiness.decision, 'ready');
  assert.deepEqual(e03.executionReadiness.reasonCodes, []);
  assert.equal(e03.attempt.status, 'not-started');
  assert.equal(e03.attempt.planned, 168);
  assert.equal(e03.scientificDisposition, 'not-tested');

  const pilot = read('evidence/pilots/e03-blinded-v3/receipt.json');
  const decision = read('protocols/e03-sample-size-decision.v1.json');
  assert.equal(pilot.passed, true);
  assert.equal(pilot.validRuns, 120);
  assert.equal(decision.pilotReceiptSha256,
    digest('evidence/pilots/e03-blinded-v3/receipt.json'));
  assert.equal(decision.selectedPrimarySeeds, 25);
  assert.equal(decision.monteCarloRepetitions, 30_000);
  assert.ok(decision.monteCarloLower95 >= 0.9);

  const qualificationPath = execution.fullCollectorQualification.path;
  assert.equal(digest(qualificationPath), execution.fullCollectorQualification.sha256);
  validateE03FullCollectorQualification(read(qualificationPath));
  assert.ok(ancestor(execution.fullCollectorQualification.executionCommit, head));
  const reserve = read(execution.reserveDesignAmendment.path);
  assert.equal(digest(execution.reserveDesignAmendment.path),
    execution.reserveDesignAmendment.sha256);
  assert.equal(reserve.reserveUnit, 'paired-six-condition-scenario-slot');
  assert.equal(reserve.primaryPairedSlots, 25);
  assert.equal(reserve.orderedReservePairedSlots, 3);
  assert.equal(reserve.scientificThresholdsChanged, false);

  const topology = read(execution.prototypeTopology.path);
  assert.equal(digest(execution.prototypeTopology.path), execution.prototypeTopology.sha256);
  assert.equal(topology.passed, true);
  assert.equal(topology.auditExitStatus, 0);
  assert.equal(topology.profile, 'prototype-v2');
  assert.ok(ancestor(topology.executionCommit, head));
  const policy = read(policyPath);
  assert.equal(digest(execution.resourceAllocation.path), execution.resourceAllocation.sha256);
  const allocation = read(allocationPath);
  validateAllocation(execution, allocation, policy);

  const governance = read('protocols/research-governance-and-funding.v1.json');
  assert.equal(governance.status, 'approved');
  assert.equal(governance.dataScope.syntheticOnly, true);
  assert.equal(governance.dataScope.personalDataPermitted, false);
  assert.equal(governance.fundingPolicy.profile, 'simulation-only');
  assert.equal(governance.fundingPolicy.externalSpendAuthorized, 0);
  assert.equal(governance.fundingPolicy.publicChainTransactionsAuthorized, false);

  assert.equal(packet.runs.length, 168);
  assert.equal(new Set(packet.runs.map((run) => run.config.runId)).size, 168);
  for (let slot = 1; slot <= 28; slot += 1) {
    const group = packet.runs.filter((run) => run.slot === slot);
    assert.equal(group.length, 6);
    assert.deepEqual(group.map((run) => run.condition).sort(), [...conditions].sort());
    assert.ok(group.every((run) => run.use === (slot <= 25 ? 'primary' : 'reserve')));
    assert.equal(new Set(group.map((run) => run.config.randomSeed)).size, 1);
  }
  assert.match(artifact.parameters.reservePolicy, /six-condition paired reserve/u);
  assert.match(artifact.analysisPlan, /no outcome-dependent stopping/u);
  const repository = { headCommit: head, clean: true, protocolCommitIsAncestor: true,
    registrationRecordMatches: true };
  for (const run of packet.runs) {
    const report = evaluateResearchPreflight({ config: run.config, artifact,
      preRegistrationHash: packet.preRegistrationHash, binding, repository });
    assert.equal(report.ready, true,
      `${run.config.runId}: registered preflight failed ${report.blockers.join(', ')}`);
  }
  return {
    schemaVersion: 1, experimentId: 'E03', stage: 'full-qualification',
    classification: 'pre-execution-admission-gate', decision: 'ready',
    researchFinding: false, scientificDisposition: 'not-tested',
    executionCommit: head, protocolCommit: artifact.protocolGitCommit, packetCommit,
    registrationHash: packet.preRegistrationHash, packetSha256: digest(packetPath),
    bindingSha256: digest(bindingPath), topologyAuditSha256: execution.prototypeTopology.sha256,
    collectorQualificationSha256: execution.fullCollectorQualification.sha256,
    resourceAllocationSha256: execution.stageResourceAllocation.sha256,
    plannedRuns: 168, primaryRuns: 150, maximumReserveRuns: 18,
    validRegisteredPreflights: 168, reservedCpuHours: allocation.reservedCpuHours,
    reservedWorkingStorageGiB: allocation.reservedWorkingStorageGiB,
    priorCpuHoursCharged: allocation.priorCpuHoursCharged,
    priorRetainedStorageGiB: allocation.priorRetainedStorageGiB,
    externalSpend: 0, publicChainTransaction: false, checkedAt: new Date().toISOString(),
    claimBoundary: 'Exact zero-spend registered E03 Prototype-Mode full qualification admission only; no full-stage data has been collected and no language-emergence finding follows.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.deepEqual(process.argv.slice(2), ['--live'],
    'usage: node scripts/check-e03-full-admission.mjs --live');
  console.log(JSON.stringify(validateE03FullAdmission(), null, 2));
}
