import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const recordPath = 'reports/research/mode-r-boundary-development-attempt-1-failure.json';
const protocolPath = 'protocols/mode-r-boundary-qualification.v1.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function validatePortable(root = process.cwd()) {
  const record = read(resolve(root, recordPath));
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
  return record;
}

export function validateLive(root = process.cwd()) {
  const record = validatePortable(root);
  const artifactPath = resolve(root, record.retainedRawArtifact.path);
  const stat = lstatSync(artifactPath);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.size, record.retainedRawArtifact.bytes);
  assert.equal(sha256(artifactPath), record.retainedRawArtifact.sha256);
  const receipt = read(artifactPath);
  assert.equal(receipt.executionCommit, record.executionCommit);
  assert.equal(receipt.protocolSha256, record.protocolSha256);
  assert.equal(receipt.collectedAt, record.collectedAt);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendingUsd, 0);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.summary, record.summary);
  assert.equal(receipt.observations.processes.length, record.observedProcesses);
  assert.equal(receipt.observations.routes.length, record.observedRoutes);
  const breakdown = [
    { expectedReachable: false, observedReachable: true },
    { expectedReachable: true, observedReachable: false },
  ].map((kind) => ({
    ...kind,
    count: receipt.observations.routes.filter((route) =>
      route.expectedReachable === kind.expectedReachable &&
      route.observedReachable === kind.observedReachable).length,
  }));
  assert.deepEqual(breakdown, record.networkMismatchBreakdown);
  return record;
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
    `Mode R boundary development attempt 1 failure reconciles (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`,
  );
}
