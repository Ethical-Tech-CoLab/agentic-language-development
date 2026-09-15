#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  out: { type: 'string', required: true },
  audit: { type: 'boolean', default: false },
} });
const outputPath = values.out;
assert.equal(outputPath, 'protocols/e03-full-resource-allocation.v1.json');
assert.equal(existsSync(outputPath), values.audit,
  values.audit ? 'full E03 allocation is missing for audit' :
    'refusing to overwrite a prospective full E03 allocation');
const pilotPath = 'evidence/pilots/e03-blinded-v3/receipt.json';
const decisionPath = 'protocols/e03-sample-size-decision.v1.json';
const topologyPath = 'reports/research/e03-prototype-topology-audit-receipt.json';
const priorAllocationPath = 'protocols/e03-pilot-resource-allocation.v1.json';
const policyPath = 'protocols/seed-and-resource-allocation.v1.json';
const campaignPath = 'protocols/campaign-readiness-review.v1.json';
const gib = 1024 ** 3;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256')
  .update(readFileSync(path)).digest('hex')}`;
const ceilingTenth = (value) => Math.ceil(value * 10) / 10;
const originalBytes = (path) => {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path}: retained evidence may not use symlinks`);
  if (stat.isFile()) return stat.size;
  assert.equal(stat.isDirectory(), true, `${path}: unexpected retained evidence entry`);
  return readdirSync(path).reduce((total, entry) =>
    total + originalBytes(join(path, entry)), 0);
};

const pilot = read(pilotPath);
const decision = read(decisionPath);
const prior = read(priorAllocationPath);
const policy = read(policyPath);
const campaign = read(campaignPath);
assert.equal(pilot.experimentId, 'E03');
assert.equal(pilot.stage, 'blinded-pilot');
assert.equal(pilot.plannedRuns, 120);
assert.equal(pilot.attemptedRuns, 120);
assert.equal(pilot.completedRuns, 120);
assert.equal(pilot.validRuns, 120);
assert.equal(pilot.invalidRuns, 0);
assert.equal(pilot.abortedRuns, 0);
assert.equal(pilot.passed, true);
assert.equal(pilot.failure, null);
assert.equal(pilot.researchFinding, false);
assert.equal(pilot.scientificDisposition, 'not-tested');
assert.equal(pilot.externalSpend, 0);
assert.equal(pilot.publicChainTransaction, false);
assert.equal(pilot.slots?.length, 120);
assert.equal(decision.version, 1);
assert.equal(decision.classification, 'outcome-blind-pilot-sample-size-selection');
assert.equal(decision.pilotReceiptPath, pilotPath);
assert.equal(decision.pilotReceiptSha256, sha256(pilotPath));
assert.equal(decision.pilotRegistrationHash, pilot.registrationHash);
assert.equal(decision.selectedPrimarySeeds, 25);
assert.equal(decision.monteCarloRepetitions, 30_000);
assert.ok(decision.monteCarloLower95 >= 0.9);
assert.equal(decision.invalidAsFailureSensitivity?.forcedFailuresPerCondition, 2);
assert.equal(campaign.e03SampleSizeDecisionSupplement?.sha256, sha256(decisionPath));
assert.equal(prior.stage, 'blinded-pilot');
assert.equal(prior.priorCpuHoursCharged, 22.1);
assert.equal(prior.externalSpend, 0);
assert.equal(prior.policySourceSha256, sha256(policyPath));
assert.equal(policy.localCeiling.externalSpend, 0);

for (const slot of pilot.slots) {
  assert.equal(slot.passed, true);
  assert.ok(slot.originalEvidenceBytes > 0 &&
    slot.nurseryResourceUsage?.cpuUsageMicroseconds > 0 &&
    slot.nurseryResourceUsage?.peakBytes > 0 &&
    slot.wallMilliseconds > 0,
  `${slot.runId}: original resource measurement is incomplete`);
}
assert.equal(pilot.attemptedResourceAccounting?.completeMeasurement, true);
assert.deepEqual(pilot.attemptedResourceAccounting?.missingComponents, []);
const maximumCpuMicroseconds = Math.max(...pilot.slots.map((slot) =>
  slot.nurseryResourceUsage.cpuUsageMicroseconds));
const maximumEvidenceBytes = Math.max(...pilot.slots.map((slot) =>
  slot.originalEvidenceBytes));
const maximumPeakBytes = Math.max(...pilot.slots.map((slot) =>
  slot.nurseryResourceUsage.peakBytes));
const maximumWallMilliseconds = Math.max(...pilot.slots.map((slot) =>
  slot.wallMilliseconds));
const hostCpuHours = (pilot.hostResourceUsage.userCPUTime +
  pilot.hostResourceUsage.systemCPUTime) / 3_600_000_000;
const hostResidentGiB = pilot.hostResourceUsage.maxRSS * 1024 / gib;
const measuredPilotCpuHours = pilot.measuredCpuHours;
assert.ok(Number.isFinite(measuredPilotCpuHours) && measuredPilotCpuHours > 0);
const retainedEvidenceBytes = originalBytes('evidence');
const primarySlotsPerCondition = decision.selectedPrimarySeeds;
const reserveSlotsPerCondition = Math.ceil(0.1 * primarySlotsPerCondition);
const plannedRuns = 6 * (primarySlotsPerCondition + reserveSlotsPerCondition);
assert.equal(plannedRuns, 168);
const reservedCpuHours = Math.max(1, ceilingTenth(
  (maximumCpuMicroseconds / 3_600_000_000 + hostCpuHours / 120) *
    plannedRuns * 2));
const reservedWorkingStorageGiB = Math.max(1, ceilingTenth(
  maximumEvidenceBytes / gib * plannedRuns * 2));
const maximumResidentGiB = Math.max(1, ceilingTenth(
  (maximumPeakBytes / gib + hostResidentGiB) * 1.5));
const projectedSequentialWallHours = Math.max(0.5, ceilingTenth(
  Math.max(maximumWallMilliseconds, pilot.wallMilliseconds / 120) *
    plannedRuns * 1.5 / 3_600_000));
const priorCpuHoursCharged = ceilingTenth(
  prior.priorCpuHoursCharged + measuredPilotCpuHours + hostCpuHours + 0.01);
const priorRetainedStorageGiB = ceilingTenth(retainedEvidenceBytes / gib);
assert.ok(priorCpuHoursCharged + reservedCpuHours <= policy.localCeiling.cpuHours,
  'full E03 CPU reservation exceeds the authorized local ceiling');
assert.ok(priorRetainedStorageGiB + reservedWorkingStorageGiB <=
  policy.localCeiling.workingStorageGiB,
'full E03 retained evidence plus reserve exceeds the authorized storage ceiling');
assert.ok(maximumResidentGiB <= policy.localCeiling.maximumResidentGiB,
  'full E03 resident reserve exceeds the authorized local ceiling');

const allocation = {
  schemaVersion: 1,
  experimentId: 'E03',
  classification: 'prospective-local-stage-allocation',
  stage: 'full-qualification',
  researchFinding: false,
  decision: 'ready',
  plannedRuns,
  primarySlotsPerCondition,
  reserveSlotsPerCondition,
  maximumParallelRuns: 1,
  reservedCpuHours,
  reservedWorkingStorageGiB,
  maximumResidentGiB,
  priorCpuHoursCharged,
  priorRetainedStorageGiB,
  projectedSequentialWallHours,
  measurementSourcePath: topologyPath,
  measurementSourceSha256: sha256(topologyPath),
  pilotMeasurementSourcePath: pilotPath,
  pilotMeasurementSourceSha256: sha256(pilotPath),
  sampleSizeDecisionPath: decisionPath,
  sampleSizeDecisionSha256: sha256(decisionPath),
  policySourcePath: policyPath,
  policySourceSha256: sha256(policyPath),
  measuredMaximums: {
    maximumPerSlotContainerCpuHours: maximumCpuMicroseconds / 3_600_000_000,
    maximumPerSlotEvidenceGiB: maximumEvidenceBytes / gib,
    maximumCombinedContainerResidentGiB: maximumPeakBytes / gib,
    hostCpuHoursAcross120Runs: hostCpuHours,
    hostResidentGiB,
    maximumPerSlotWallHours: maximumWallMilliseconds / 3_600_000,
    actualSequentialPilotWallHours: pilot.wallMilliseconds / 3_600_000,
    retainedEvidenceBytesBeforeFullAllocation: retainedEvidenceBytes,
  },
  reserveMethod: 'double measured maximum per-run Nursery plus controller CPU/evidence across all 168 primary/reserve slots; 1.5x measured Nursery-plus-controller resident peak and sequential wall rate',
  priorChargeMethod: 'retain the prior 22.1-hour prospective charge, add measured pilot Nursery and controller CPU plus 0.01-hour bounded selector/audit allowance, and charge the complete retained evidence tree rather than selected pilot roots',
  authorizationScope: 'existing local synthetic software qualification only; zero external spending',
  externalSpend: 0,
  publicChainTransaction: false,
  claimBoundary: 'This measured allocation covers only full E03 Prototype-Mode software qualification, not E10+ Research-Grade isolation, the confirmatory family, or replication. Post-batch accounting and fresh live admission remain mandatory.',
};
const rendered = `${JSON.stringify(allocation, null, 2)}\n`;
if (values.audit) {
  assert.equal(readFileSync(outputPath, 'utf8'), rendered,
    'prospective full E03 allocation does not reproduce from retained pre-run measurements');
  console.log(`audited ${outputPath}`);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, { flag: 'wx' });
  console.log(`wrote ${outputPath}`);
}
console.log(`E03 full allocation: ${plannedRuns} maximum runs, ${reservedCpuHours} CPU-hour, ${reservedWorkingStorageGiB} GiB evidence, ${maximumResidentGiB} GiB resident, ${projectedSequentialWallHours} h projected wall; no research finding`);
