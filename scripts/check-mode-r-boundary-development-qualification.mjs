import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const recordPath = 'reports/research/mode-r-boundary-development-qualification-receipt.json';
const protocolPath = 'protocols/mode-r-boundary-qualification.v1.json';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function countBy(items, key) {
  return Object.fromEntries([...new Set(items.map((item) => item[key]))].sort()
    .map((value) => [value, items.filter((item) => item[key] === value).length]));
}

export function validatePortable(root = process.cwd()) {
  const record = read(resolve(root, recordPath));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.qualificationId, 'mode-r-boundary-v1');
  assert.equal(record.attemptId, 'development-attempt-4');
  assert.equal(record.classification, 'supplemental-development-qualification');
  assert.equal(record.researchFinding, false);
  assert.equal(record.b12Closed, false);
  assert.equal(record.selectedExecution, false);
  assert.equal(record.attemptStatus, 'completed');
  assert.equal(record.qualificationDisposition, 'passed');
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.executionCommit.length, 40);
  assert.equal(record.executionTree.length, 40);
  assert.equal(record.executionVersion, '0.1.254');
  assert.match(record.collectorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(`sha256:${sha256(resolve(root, protocolPath))}`, record.protocolSha256);
  assert.equal(record.externalSpendingUsd, 0);
  assert.equal(record.processCount, 17);
  assert.equal(record.routeCount, 272);
  assert.equal(record.endpointProbeCount, 160);
  assert.deepEqual(record.routeOutcomeCounts, {
    denied: 94, 'no-target-interface': 144, reachable: 34,
  });
  assert.deepEqual(record.endpointOutcomeCounts, { denied: 126, reachable: 34 });
  assert.ok(Object.values(record.summary).every((value) => value === 0));
  assert.equal(record.limitations.length, 4);
  assert.match(record.claimBoundary, /not selected qualification/u);
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
  assert.equal(receipt.classification, 'development-only-container-boundary-qualification');
  assert.equal(receipt.executionCommit, record.executionCommit);
  assert.equal(receipt.protocolSha256, record.protocolSha256);
  assert.equal(receipt.collectedAt, record.collectedAt);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendingUsd, 0);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.failure, null);
  assert.deepEqual(receipt.summary, record.summary);
  assert.equal(receipt.observations.processes.length, record.processCount);
  assert.equal(receipt.observations.routes.length, record.routeCount);
  assert.equal(receipt.observations.routes.flatMap((route) =>
    route.endpointObservations).length, record.endpointProbeCount);
  assert.deepEqual(countBy(receipt.observations.routes, 'probeOutcome'),
    record.routeOutcomeCounts);
  assert.deepEqual(countBy(receipt.observations.routes.flatMap((route) =>
    route.endpointObservations), 'outcome'), record.endpointOutcomeCounts);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
    'usage: node scripts/check-mode-r-boundary-development-qualification.mjs [--live-evidence]',
  );
  if (process.argv[2] === '--live-evidence') validateLive();
  else validatePortable();
  console.log(
    `Mode R boundary development qualification valid (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'}); selected execution remains unattempted`,
  );
}
