import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function validateArtifact(root, artifact) {
  const path = resolve(root, artifact.path);
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${artifact.path} must not be a symbolic link`);
  assert.equal(stat.size, artifact.bytes, `${artifact.path} byte count changed`);
  assert.equal(sha256(path), artifact.sha256, `${artifact.path} digest changed`);
}

export function validateE02V3ExecutionStart(record) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.experimentId, 'E02');
  assert.equal(record.attemptVersion, 'v3');
  assert.equal(record.stage, 'qualification');
  assert.equal(record.classification, 'registered-qualification-attempt-start');
  assert.equal(record.attemptStatus, 'running');
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.researchFinding, false);
  assert.equal(record.executionCommit, '9ec08ecf4528c6da8867d55900d6ca8667ded7ce');
  assert.equal(record.registrationHash, 'sha256:d35e6b118e4c811f80b426680a0b2f4b0c9b8da3e59bdc56293e557ef979f248');
  assert.equal(record.plannedSlots, 5);
  assert.equal(record.attemptedSlots, 1);
  assert.equal(record.completedSlots, 0);
  assert.equal(record.currentSlot, 1);
  assert.equal(record.currentRunId, 'registered-e02-v3-1');
  assert.equal(record.noSameSeedRerun, true);
  assert.equal(record.serviceObservation.unit, 'ald-e02-v3-qualification.service');
  assert.equal(record.serviceObservation.activeState, 'active');
  assert.equal(record.serviceObservation.subState, 'running');
  assert.equal(record.serviceObservation.restartPolicy, 'no');
  assert.equal(record.serviceObservation.restartCount, 0);
  assert.equal(record.trackedArtifacts.length, 3);
  assert.match(record.claimBoundary, /not a completed slot/u);
}

export function validateE02V3ExecutionStartPortable(root = process.cwd()) {
  const record = read(resolve(root, 'reports/research/e02-v3-execution-start.json'));
  validateE02V3ExecutionStart(record);
  for (const artifact of record.trackedArtifacts) validateArtifact(root, artifact);
  const packet = read(resolve(root, record.trackedArtifacts[0].path));
  const binding = read(resolve(root, record.trackedArtifacts[1].path));
  const gate = read(resolve(root, record.trackedArtifacts[2].path));
  assert.equal(packet.preRegistrationHash, record.registrationHash);
  assert.equal(binding.preRegistrationHash, record.registrationHash);
  assert.equal(gate.decision, 'ready');
  assert.equal(gate.registeredExecutionStarted, false);
  return record;
}

export function validateE02V3ExecutionStartLive(root = process.cwd()) {
  const record = validateE02V3ExecutionStartPortable(root);
  validateArtifact(root, record.retainedAttemptArtifact);
  const attempt = read(resolve(root, record.retainedAttemptArtifact.path));
  assert.equal(attempt.executionCommit, record.executionCommit);
  assert.equal(attempt.registrationHash, record.registrationHash);
  assert.equal(attempt.startedAt, record.startedAt);
  assert.equal(attempt.noSameSeedRerun, true);
  assert.equal(attempt.seeds.length, record.plannedSlots);
  assert.equal(new Set(attempt.seeds.map((entry) => entry.scenario)).size, record.plannedSlots);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
  'usage: node scripts/check-e02-v3-execution-start.mjs [--live-evidence]');
  if (process.argv[2] === '--live-evidence') validateE02V3ExecutionStartLive();
  else validateE02V3ExecutionStartPortable();
  console.log(`E02 v3 execution start valid (${process.argv[2] === '--live-evidence' ? 'tracked and retained attempt evidence' : 'portable tracked evidence'})`);
}
