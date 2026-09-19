#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const originalPath = 'evidence/qualification/e03-full-v1/receipt.json';
const outputPath = 'reports/research/e03-full-v1-status-receipt.json';
const packetPath = 'protocols/e03-full-registration.v1.json';
const bindingPath = 'protocols/e03-full-registration-binding.v1.json';
const allocationPath = 'protocols/e03-full-resource-allocation.v1.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

export function buildE03FullStatusReceipt() {
  const original = read(originalPath);
  const packet = read(packetPath);
  assert.equal(original.experimentId, 'E03');
  assert.equal(original.stage, 'full-qualification');
  assert.equal(original.classification, 'registered-original-full-qualification-terminal');
  assert.equal(original.attemptStatus, 'completed');
  assert.equal(original.qualificationDisposition, 'thresholds-met');
  assert.equal(original.qualificationPassed, true);
  assert.equal(original.registrationHash, packet.preRegistrationHash);
  assert.equal(original.packetSha256, sha256(packetPath));
  assert.equal(original.bindingSha256, sha256(bindingPath));
  assert.equal(original.allocationSha256, sha256(allocationPath));
  assert.equal(original.plannedRuns, 168);
  assert.equal(original.primaryAttempts, 150);
  assert.equal(original.reserveAttempts, 0);
  assert.equal(original.attemptedRuns, 150);
  assert.equal(original.validRuns, 150);
  assert.equal(original.invalidRuns, 0);
  assert.equal(original.unattemptedRuns, 18);
  assert.equal(original.schedulerTerminal.state, 'done');
  assert.equal(original.analysis.reconciliation.includedPairs.length, 25);
  assert.equal(original.analysis.numericDisposition, 'thresholds-met');
  assert.deepEqual(original.analysis.numericAnalysis.criteria, {
    allControlsEquivalent: true, oracleAdequate: true, allSeparationsMeet: true,
  });
  assert.deepEqual(original.analysis.numericAnalysis.unmetCriteria, []);
  assert.deepEqual(original.analysis.numericAnalysis.auditTriggers, []);
  assert.deepEqual(original.analysis.leakageReviewRunIds, []);
  assert.equal(original.allIncludedEvidenceVerified, true);
  assert.equal(original.unplannedLeakageDetected, false);
  assert.equal(original.attemptedResourceAccounting.completeMeasurement, true);
  assert.deepEqual(original.attemptedResourceAccounting.missingComponents, []);
  assert.equal(original.researchFinding, false);
  assert.equal(original.scientificDisposition, 'not-tested');
  assert.equal(original.externalSpend, 0);
  assert.equal(original.publicChainTransaction, false);

  return {
    schemaVersion: 1,
    experimentId: 'E03',
    attemptVersion: 'v1',
    stage: 'full-qualification',
    classification: 'portable-original-full-qualification-status-summary',
    attemptStatus: 'completed',
    qualificationDisposition: 'thresholds-met',
    passed: true,
    failure: null,
    executionCommit: original.executionCommit,
    registrationHash: original.registrationHash,
    packetPath,
    packetSha256: original.packetSha256,
    bindingPath,
    bindingSha256: original.bindingSha256,
    allocationPath,
    allocationSha256: original.allocationSha256,
    admissionSha256: original.admissionSha256,
    retainedAuditorSha256: original.auditorSha256,
    originalReceiptPath: originalPath,
    originalReceiptSha256: sha256(originalPath),
    originalEvidenceRoot: 'evidence/qualification/e03-full-v1',
    auditSourceCommit: 'b2ea190b71223289e5ceb8bddf9ba652be7ffcf4',
    auditCommand: 'pnpm run audit:e03-full:live',
    auditExitStatus: 0,
    auditTerminalOutput: 'E03 full original audit passed: thresholds-met; no language-emergence finding',
    originalBundlesRecomputed: 150,
    typescriptVerifierPassed: true,
    retainedRustAuditorPassed: true,
    registeredAnalysisRecomputed: true,
    plannedRuns: 168,
    primaryRuns: 150,
    maximumReserveRuns: 18,
    attemptedRuns: 150,
    completedRuns: 150,
    validRuns: 150,
    invalidRuns: 0,
    reserveRunsAttempted: 0,
    unattemptedRuns: 18,
    unattemptedReserveRuns: 18,
    includedPairedSlots: 25,
    criteria: original.analysis.numericAnalysis.criteria,
    unmetCriteria: original.analysis.numericAnalysis.unmetCriteria,
    caseAuditTriggers: original.analysis.numericAnalysis.auditTriggers,
    leakageReviewRunIds: original.analysis.leakageReviewRunIds,
    oracle: {
      seeds: original.analysis.numericAnalysis.oracle.n,
      mean: original.analysis.numericAnalysis.oracle.summary.mean,
      simultaneousLower: original.analysis.numericAnalysis.oracle.simultaneousInterval.lower,
      meetsAdequacy: original.analysis.numericAnalysis.oracle.meetsAdequacy,
    },
    controls: original.analysis.numericAnalysis.conditions.map((condition) => ({
      condition: condition.condition,
      seeds: condition.n,
      mean: condition.summary.mean,
      holmAdjustedEquivalenceP: condition.holmAdjustedP,
      equivalenceDecision: condition.decision,
      simultaneousSeparationLower: condition.separation.simultaneousInterval.lower,
      holmAdjustedSeparationP: condition.separation.holmAdjustedP,
      separationMeets: condition.separation.meets,
      highSeedCount: condition.highSeeds.count,
    })),
    resources: {
      measuredCpuHours: original.measuredCpuHours,
      wallMilliseconds: original.wallMilliseconds,
      evidenceBytesBeforeTerminalReceipt: original.evidenceBytesBeforeTerminalReceipt,
      hostPeakResidentBytes: original.hostResourceUsage.maxRSS * 1024,
      maximumNurseryPeakBytes: Math.max(...original.attempts
        .filter((attempt) => attempt.valid)
        .map((attempt) => attempt.nurseryResourceUsage.peakBytes)),
      remainingCpuHours: original.remainingCpuHours,
      remainingWorkingStorageGiB: original.remainingWorkingStorageGiB,
      completeMeasurement: original.attemptedResourceAccounting.completeMeasurement,
    },
    allIncludedEvidenceVerified: true,
    unplannedLeakageDetected: false,
    researchFinding: false,
    scientificDisposition: 'not-tested',
    externalSpend: 0,
    publicChainTransaction: false,
    claimBoundary: 'Registered E03 Prototype-Mode chance-control software qualification only. The thresholds-met disposition qualifies this control baseline for dependent design work; it is not Research-Grade isolation, a language-emergence result, independent review, or a public timestamp.',
  };
}

const built = buildE03FullStatusReceipt();
if (process.argv.length === 3 && process.argv[2] === '--write') {
  writeFileSync(outputPath, `${JSON.stringify(built, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
} else {
  assert.deepEqual(process.argv.slice(2), [], 'usage: build-e03-full-status-receipt.mjs [--write]');
  assert.deepEqual(read(outputPath), built);
  console.log('E03 portable full-stage status receipt valid');
}
