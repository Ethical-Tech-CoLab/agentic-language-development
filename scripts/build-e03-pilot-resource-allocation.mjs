import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

assert.deepEqual(process.argv.slice(2), ['--write'],
  'usage: node scripts/build-e03-pilot-resource-allocation.mjs --write');

const rawRoot = 'evidence/qualification/e03-topology-prototype-v2';
const priorTopologyRoot = 'evidence/qualification/e03-topology-development-v1';
const e02Root = 'evidence/qualification/e02-v3';
const rawReceiptPath = join(rawRoot, 'receipt.json');
const topologyPath = 'reports/research/e03-prototype-topology-audit-receipt.json';
const allocationPath = 'protocols/e03-pilot-resource-allocation.v1.json';
const policyPath = 'protocols/seed-and-resource-allocation.v1.json';
const gib = 1024 ** 3;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const ceilingTenth = (value) => Math.ceil(value * 10) / 10;

function originalBytes(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path}: original evidence may not use symlinks`);
  if (stat.isFile()) return stat.size;
  assert.equal(stat.isDirectory(), true, `${path}: unexpected original-evidence entry`);
  return readdirSync(path).reduce((total, entry) => total + originalBytes(join(path, entry)), 0);
}

assert.equal(existsSync(topologyPath), false, 'topology audit summary is single-use');
assert.equal(existsSync(allocationPath), false, 'pilot allocation is prospective and single-use');
const rawReceipt = read(rawReceiptPath);
assert.equal(rawReceipt.experimentId, 'E03');
assert.equal(rawReceipt.profile, 'prototype-v2');
assert.equal(rawReceipt.classification, 'development-only-topology-qualification');
assert.equal(rawReceipt.passed, true);
assert.equal(rawReceipt.failure, null);
assert.equal(rawReceipt.researchFinding, false);
assert.equal(rawReceipt.externalSpend, 0);
assert.equal(rawReceipt.publicChainTransaction, false);
assert.equal(rawReceipt.slots.length, 6);
const audit = spawnSync(process.execPath,
  ['scripts/run-e03-topology-qualification.mjs', '--audit-prototype-v2'],
  { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(audit.status, 0, audit.error?.message ?? audit.stderr);
assert.match(audit.stdout, /E03 six-condition prototype-v2 development topology audit passed/u);

const policy = read(policyPath);
assert.equal(policy.localCeiling.externalSpend, 0);
const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
assert.deepEqual(rawReceipt.conditions, conditions);
const observedSlots = rawReceipt.slots.map((slot) => {
  assert.equal(slot.passed, true);
  assert.equal(slot.signedOriginalDataReconciled, true,
    'Prototype-Mode topology must pair scenarios from signed original records');
  assert.equal(slot.scenarioStateHashes.length, 200);
  assert.equal(slot.rust.integrityPass, true);
  assert.equal(slot.rust.anchored, true);
  const runPath = join(rawRoot,
    `e03-topology-prototype-v2-${slot.condition}`);
  assert.deepEqual(slot.learnerContainerResourceUsage, {});
  assert.equal(slot.learnerResourceSha256, null);
  assert.deepEqual(slot.containerIds, []);
  assert.match(slot.nurseryContainerId, /^[a-f0-9]{12}$/u);
  assert.deepEqual(slot.roleProcessIds,
    { 'baby-a': slot.nurseryProcessId, 'baby-b': slot.nurseryProcessId });
  const cpuUsageMicroseconds = slot.containerResourceUsage.cpuUsageMicroseconds;
  const combinedPeakBytes = slot.containerResourceUsage.peakBytes;
  return {
    condition: slot.condition,
    originalEvidenceBytes: originalBytes(runPath),
    containerCpuUsageMicroseconds: cpuUsageMicroseconds,
    combinedContainerPeakBytes: combinedPeakBytes,
    wallMilliseconds: slot.wallMilliseconds,
    slotSha256: slot.slotSha256,
    learnerResourceSha256: slot.learnerResourceSha256,
    bundleManifestHash: slot.bundleManifestHash,
    nurseryContainerId: slot.nurseryContainerId,
    nurseryProcessId: slot.nurseryProcessId,
    roleProcessIds: slot.roleProcessIds,
    signedOriginalDataReconciled: true,
  };
});
assert.deepEqual(observedSlots.map((slot) => slot.condition), conditions);
const uniqueRoleContainers = new Set(rawReceipt.slots.flatMap((slot) => slot.containerIds));
assert.equal(uniqueRoleContainers.size, 0);
assert.equal(new Set(rawReceipt.slots.map((slot) => slot.nurseryContainerId)).size, 6);

const topology = {
  schemaVersion: 1,
  experimentId: 'E03',
  classification: 'original-prototype-development-audit',
  profile: 'prototype-v2',
  researchFinding: false,
  externalSpend: 0,
  publicChainTransaction: false,
  executionCommit: rawReceipt.executionCommit,
  rawReceiptPath,
  rawReceiptSha256: sha256(rawReceiptPath),
  auditCommand: 'node scripts/run-e03-topology-qualification.mjs --audit-prototype-v2',
  auditExitStatus: 0,
  conditionsAudited: 6,
  roleContainerCount: 0,
  nurseryContainerCount: 6,
  sharedProcessCheck: true,
  pairedScenarioCheck: true,
  typescriptVerifierPassed: true,
  rustAuditorPassed: true,
  originalSlots: observedSlots,
  hostResourceUsage: rawReceipt.hostResourceUsage,
  passed: true,
  capturedAt: new Date().toISOString(),
  claimBoundary: 'First-party raw Prototype-Mode development mechanics/resource audit only; not full Research-Grade writer/signer isolation, an E03 pilot, a behavioral result, or independent review.',
};
const topologyBytes = Buffer.from(`${JSON.stringify(topology, null, 2)}\n`, 'utf8');
const topologySha256 = `sha256:${createHash('sha256').update(topologyBytes).digest('hex')}`;

const hostCpuHours = (rawReceipt.hostResourceUsage.userCPUTime +
  rawReceipt.hostResourceUsage.systemCPUTime) / 3_600_000_000;
const maximumPerSlotContainerCpuHours = Math.max(...observedSlots.map((slot) =>
  slot.containerCpuUsageMicroseconds / 3_600_000_000));
const maximumPerSlotEvidenceGiB = Math.max(...observedSlots.map((slot) =>
  slot.originalEvidenceBytes / gib));
const maximumCombinedContainerResidentGiB = Math.max(...observedSlots.map((slot) =>
  slot.combinedContainerPeakBytes / gib));
const hostResidentGiB = rawReceipt.hostResourceUsage.maxRSS * 1024 / gib;
const maximumPerSlotWallHours = Math.max(...observedSlots.map((slot) =>
  slot.wallMilliseconds / 3_600_000));
const plannedRuns = 120;
const reserveMultiplier = 2;
const reservedCpuHours = Math.max(1, ceilingTenth(
  (maximumPerSlotContainerCpuHours + hostCpuHours / 6) * plannedRuns * reserveMultiplier));
const reservedWorkingStorageGiB = Math.max(1, ceilingTenth(
  maximumPerSlotEvidenceGiB * plannedRuns * reserveMultiplier));
const maximumResidentGiB = Math.max(1, ceilingTenth(
  (maximumCombinedContainerResidentGiB + hostResidentGiB) * 1.5));
const projectedSequentialWallHours = ceilingTenth(maximumPerSlotWallHours * plannedRuns * 1.25);
const priorTopology = read(join(priorTopologyRoot, 'receipt.json'));
assert.equal(priorTopology.experimentId, 'E03');
assert.equal(priorTopology.slots.length, 6);
assert.equal(priorTopology.externalSpend, 0);
const priorTopologyCpuHours = (priorTopology.hostResourceUsage.userCPUTime +
  priorTopology.hostResourceUsage.systemCPUTime +
  priorTopology.slots.reduce((total, slot) => total +
    slot.containerResourceUsage.cpuUsageMicroseconds +
    slot.learnerContainerResourceUsage['baby-a'].cpuUsageMicroseconds +
    slot.learnerContainerResourceUsage['baby-b'].cpuUsageMicroseconds, 0)) / 3_600_000_000;
const prototypeCpuHours = hostCpuHours + rawReceipt.slots.reduce((total, slot) => total +
  slot.containerResourceUsage.cpuUsageMicroseconds, 0) / 3_600_000_000;
const e02ConservativeCpuChargeHours = 22;
const priorCpuHoursCharged = ceilingTenth(e02ConservativeCpuChargeHours +
  priorTopologyCpuHours + prototypeCpuHours);
const priorRetainedStorageGiB = ceilingTenth((originalBytes(e02Root) +
  originalBytes(priorTopologyRoot) + originalBytes(rawRoot)) / gib);
assert.ok(reservedCpuHours + priorCpuHoursCharged <= policy.localCeiling.cpuHours,
  'measured pilot CPU reserve exceeds the authorized local ceiling');
assert.ok(reservedWorkingStorageGiB + priorRetainedStorageGiB <= policy.localCeiling.workingStorageGiB,
  'measured pilot evidence reserve exceeds the authorized local ceiling');
assert.ok(maximumResidentGiB <= policy.localCeiling.maximumResidentGiB,
  'measured pilot memory reserve exceeds the authorized local ceiling');

const allocation = {
  schemaVersion: 1,
  experimentId: 'E03',
  classification: 'prospective-local-stage-allocation',
  stage: 'blinded-pilot',
  researchFinding: false,
  decision: 'ready',
  plannedRuns,
  primarySlotsPerCondition: 20,
  reserveSlots: 0,
  maximumParallelRuns: 1,
  reservedCpuHours,
  reservedWorkingStorageGiB,
  maximumResidentGiB,
  priorCpuHoursCharged,
  priorRetainedStorageGiB,
  projectedSequentialWallHours,
  measurementSourcePath: topologyPath,
  measurementSourceSha256: topologySha256,
  policySourcePath: policyPath,
  policySourceSha256: sha256(policyPath),
  measuredMaximums: {
    maximumPerSlotContainerCpuHours,
    hostCpuHoursAcrossSixConditions: hostCpuHours,
    maximumPerSlotEvidenceGiB,
    maximumCombinedContainerResidentGiB,
    hostResidentGiB,
    maximumPerSlotWallHours,
  },
  reserveMethod: 'double the measured worst-slot Nursery CPU and original-evidence rate across 120 runs; 1.5x the Nursery-plus-controller resident peaks; 1.25x sequential wall projection',
  priorChargeMethod: 'charge E02 its 22-hour prospective CPU reservation; add measured v1/v2 controller and container CPU; retain original E02 and E03 development storage',
  authorizationScope: 'existing user-approved local synthetic research; no external spending',
  externalSpend: 0,
  publicChainTransaction: false,
  capturedAt: new Date().toISOString(),
  claimBoundary: 'Prospective measured pilot allocation only. Docker-daemon and full host background CPU are not included in cgroup plus controller CPU, so post-batch accounting and ceiling enforcement remain required.',
};
writeFileSync(topologyPath, topologyBytes, { flag: 'wx' });
writeFileSync(allocationPath, `${JSON.stringify(allocation, null, 2)}\n`, { flag: 'wx' });
console.log(`E03 Prototype-Mode development audit and prospective pilot allocation written; CPU ${reservedCpuHours} h, storage ${reservedWorkingStorageGiB} GiB, resident ${maximumResidentGiB} GiB; no research finding`);
