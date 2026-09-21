import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const attempt1Path = 'reports/research/mode-r-boundary-development-attempt-1-failure.json';
const attempt2Path = 'reports/research/mode-r-boundary-development-attempt-2-failure.json';
const protocolPath = 'protocols/mode-r-boundary-qualification.v1.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function validatePortable(root = process.cwd()) {
  const record = read(resolve(root, attempt1Path));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.qualificationId, 'mode-r-boundary-v1');
  assert.equal(record.attemptId, 'development-attempt-1');
  assert.equal(record.classification, 'supplemental-failure-evidence');
  assert.equal(record.researchFinding, false);
  assert.equal(record.b12Closed, false);
  assert.equal(record.historicalEvidenceModified, false);
  assert.equal(record.attemptStatus, 'failed');
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.executionCommit.length, 40);
  assert.equal(record.executionTree.length, 40);
  assert.equal(record.executionVersion, '0.1.251');
  assert.match(record.collectorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(`sha256:${sha256(resolve(root, protocolPath))}`, record.protocolSha256);
  assert.equal(record.externalSpendingUsd, 0);
  assert.equal(record.plannedProcesses, 17);
  assert.equal(record.observedProcesses, 17);
  assert.equal(record.plannedRoutes, 272);
  assert.equal(record.observedRoutes, 272);
  assert.equal(record.summary.networkMismatchCount, 212);
  assert.equal(record.summary.mountMismatchCount, 0);
  assert.equal(record.summary.keyDomainMismatchCount, 0);
  assert.equal(record.summary.duplicateContainerIdCount, 0);
  assert.equal(record.summary.duplicateHostPidCount, 0);
  assert.equal(record.summary.unexpectedExternalNetworkCount, 0);
  assert.deepEqual(record.networkMismatchBreakdown, [
    { expectedReachable: false, observedReachable: true, count: 185 },
    { expectedReachable: true, observedReachable: false, count: 27 },
  ]);
  assert.equal(record.collectorDiagnosis.scope, 'development-fixture-defect');
  assert.equal(record.collectorDiagnosis.selectedExecutionWasAttempted, false);
  assert.match(record.claimBoundary, /not a selected topology qualification/u);
  const attempt2 = read(resolve(root, attempt2Path));
  assert.equal(attempt2.schemaVersion, 1);
  assert.equal(attempt2.qualificationId, 'mode-r-boundary-v1');
  assert.equal(attempt2.attemptId, 'development-attempt-2');
  assert.equal(attempt2.classification, 'supplemental-failure-evidence');
  assert.equal(attempt2.researchFinding, false);
  assert.equal(attempt2.b12Closed, false);
  assert.equal(attempt2.historicalEvidenceModified, false);
  assert.equal(attempt2.attemptStatus, 'failed');
  assert.equal(attempt2.scientificDisposition, 'not-tested');
  assert.equal(attempt2.executionCommit.length, 40);
  assert.equal(attempt2.executionTree.length, 40);
  assert.equal(attempt2.executionVersion, '0.1.252');
  assert.match(attempt2.collectorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(attempt2.protocolSha256, record.protocolSha256);
  assert.equal(attempt2.externalSpendingUsd, 0);
  assert.equal(attempt2.plannedProcesses, 17);
  assert.equal(attempt2.observedProcesses, 17);
  assert.equal(attempt2.plannedRoutes, 272);
  assert.equal(attempt2.observedRoutes, 272);
  assert.deepEqual(attempt2.summary, {
    networkMismatchCount: 238,
    mountMismatchCount: 0,
    keyDomainMismatchCount: 0,
    notRunningProcessCount: 0,
    duplicateContainerIdCount: 0,
    duplicateHostPidCount: 0,
    unexpectedExternalNetworkCount: 0,
  });
  assert.deepEqual(attempt2.networkMismatchBreakdown, [
    { expectedReachable: false, observedReachable: true, count: 238 },
  ]);
  assert.equal(attempt2.collectorDiagnosis.scope, 'development-probe-accounting-defect');
  assert.equal(attempt2.collectorDiagnosis.outerTimeoutReturnedStatusZero, true);
  assert.equal(attempt2.collectorDiagnosis.reproducedErrorCode, 'ETIMEDOUT');
  assert.equal(attempt2.collectorDiagnosis.selectedExecutionWasAttempted, false);
  assert.match(attempt2.claimBoundary, /not a selected topology result/u);
  return { attempt1: record, attempt2 };
}

export function validateLive(root = process.cwd()) {
  const records = validatePortable(root);
  const artifactPath = resolve(root, records.attempt1.retainedRawArtifact.path);
  const stat = lstatSync(artifactPath);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.size, records.attempt1.retainedRawArtifact.bytes);
  assert.equal(sha256(artifactPath), records.attempt1.retainedRawArtifact.sha256);
  const receipt = read(artifactPath);
  assert.equal(receipt.executionCommit, records.attempt1.executionCommit);
  assert.equal(receipt.protocolSha256, records.attempt1.protocolSha256);
  assert.equal(receipt.collectedAt, records.attempt1.collectedAt);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendingUsd, 0);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.summary, records.attempt1.summary);
  assert.equal(receipt.observations.processes.length, records.attempt1.observedProcesses);
  assert.equal(receipt.observations.routes.length, records.attempt1.observedRoutes);
  const breakdown = [
    { expectedReachable: false, observedReachable: true },
    { expectedReachable: true, observedReachable: false },
  ].map((kind) => ({
    ...kind,
    count: receipt.observations.routes.filter((route) =>
      route.expectedReachable === kind.expectedReachable &&
      route.observedReachable === kind.observedReachable).length,
  }));
  assert.deepEqual(breakdown, records.attempt1.networkMismatchBreakdown);

  const attempt2Path = resolve(root, records.attempt2.retainedRawArtifact.path);
  const attempt2Stat = lstatSync(attempt2Path);
  assert.equal(attempt2Stat.isSymbolicLink(), false);
  assert.equal(attempt2Stat.size, records.attempt2.retainedRawArtifact.bytes);
  assert.equal(sha256(attempt2Path), records.attempt2.retainedRawArtifact.sha256);
  const attempt2Receipt = read(attempt2Path);
  assert.equal(attempt2Receipt.executionCommit, records.attempt2.executionCommit);
  assert.equal(attempt2Receipt.protocolSha256, records.attempt2.protocolSha256);
  assert.equal(attempt2Receipt.collectedAt, records.attempt2.collectedAt);
  assert.equal(attempt2Receipt.researchFinding, false);
  assert.equal(attempt2Receipt.b12Closed, false);
  assert.equal(attempt2Receipt.externalSpendingUsd, 0);
  assert.equal(attempt2Receipt.passed, false);
  assert.deepEqual(attempt2Receipt.summary, records.attempt2.summary);
  assert.equal(attempt2Receipt.observations.processes.length, records.attempt2.observedProcesses);
  assert.equal(attempt2Receipt.observations.routes.length, records.attempt2.observedRoutes);
  const attempt2Breakdown = [{ expectedReachable: false, observedReachable: true }]
    .map((kind) => ({
      ...kind,
      count: attempt2Receipt.observations.routes.filter((route) =>
        route.expectedReachable === kind.expectedReachable &&
        route.observedReachable === kind.observedReachable).length,
    }));
  assert.deepEqual(attempt2Breakdown, records.attempt2.networkMismatchBreakdown);
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
    'usage: node scripts/check-mode-r-boundary-development-failure.mjs [--live-evidence]',
  );
  if (process.argv[2] === '--live-evidence') validateLive();
  else validatePortable();
  console.log(
    `Mode R boundary development failures reconcile (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`,
  );
}
