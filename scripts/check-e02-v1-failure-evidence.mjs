import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function validateArtifact(root, artifact) {
  const path = resolve(root, artifact.path);
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${artifact.path} must not be a symbolic link`);
  assert.equal(stat.size, artifact.bytes, `${artifact.path} byte count changed`);
  assert.equal(sha256(path), artifact.sha256, `${artifact.path} digest changed`);
}

export function validateE02V1FailureRecord(record, receipt) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.experimentId, 'E02');
  assert.equal(record.attemptVersion, 'v1');
  assert.equal(record.classification, 'supplemental-failure-evidence');
  assert.equal(record.researchFinding, false);
  assert.equal(record.historicalEvidenceModified, false);
  assert.equal(record.attemptStatus, 'failed');
  assert.equal(record.scientificDisposition, 'not-tested');
  assert.equal(record.registrationHash, receipt.registrationHash);
  assert.equal(record.executionCommit, receipt.executionCommit);
  assert.equal(record.plannedSlots, 5);
  assert.equal(record.attemptedSlots, 1);
  assert.equal(record.completedSlots, 0);
  assert.equal(record.unattemptedSlots, 4);
  assert.equal(record.progress.runId, 'registered-e02-1');
  assert.equal(record.progress.committedTurns, 465);
  assert.equal(record.progress.lastCommittedTurnIndex, 464);
  assert.equal(record.progress.deliveredAdapterObservations, 930);
  assert.equal(record.progress.completedProbeReports, 0);
  assert.equal(record.progress.restoreCompleted, false);
  assert.equal(record.progress.finalExportCompleted, false);
  assert.deepEqual(record.terminalCause, {
    stage: 'collection',
    eventType: 'safety-trigger',
    actorId: 'symbol-gateway',
    reasonCode: 'max-consecutive-rejections',
    lastReasonCode: 'timeout',
    consecutiveRejections: 5,
    maximumConsecutiveRejections: 5,
    recordedAt: '2026-09-13T15:08:37.160Z',
  });
  assert.equal(record.collectorFailure.relationship, 'secondary-after-safety-pause');
  assert.match(record.collectorFailure.message, /^RunNotAcceptingTurnsError:/u);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.slots.length, 0);
  assert.match(receipt.failure, /RunNotAcceptingTurnsError/u);
  assert.equal(receipt.researchFinding, false);
  assert.match(record.claimBoundary, /not a completed export/u);
}

export function validateE02V1PortableEvidence(root = process.cwd()) {
  const record = read(resolve(root, 'reports/research/e02-v1-failure-evidence.json'));
  const receipt = read(resolve(root, 'reports/research/e02-qualification-receipt.json'));
  validateE02V1FailureRecord(record, receipt);
  for (const artifact of record.trackedArtifacts) validateArtifact(root, artifact);
  const packet = read(resolve(root, 'protocols/e02-registration.v1.json'));
  assert.equal(packet.preRegistrationHash, record.registrationHash);
  const binding = read(resolve(root, 'protocols/e02-registration-binding.v1.json'));
  assert.equal(binding.preRegistrationHash, record.registrationHash);
  return record;
}

export async function validateE02V1LiveEvidence(root = process.cwd()) {
  const record = validateE02V1PortableEvidence(root);
  for (const artifact of record.retainedRawArtifacts) validateArtifact(root, artifact);

  const attempt = read(resolve(root, 'evidence/qualification/e02-v1/attempt.json'));
  assert.equal(attempt.executionCommit, record.executionCommit);
  assert.equal(attempt.registrationHash, record.registrationHash);
  assert.equal(attempt.startedAt, record.startedAt);
  assert.equal(attempt.seeds.length, record.plannedSlots);
  assert.equal(attempt.noSameSeedRerun, true);

  const slot = read(resolve(root, 'evidence/qualification/e02-v1/registered-e02-1/slot.json'));
  assert.equal(slot.runId, record.progress.runId);
  assert.equal(slot.captured.length, record.progress.deliveredAdapterObservations);
  assert.equal(slot.reports.length, record.progress.completedProbeReports);
  assert.equal(slot.restoreRecord, null);
  assert.equal(slot.passed, false);
  assert.equal(slot.failure, record.collectorFailure.message);
  assert.equal(slot.wallMilliseconds, record.resourceObservation.wallMilliseconds);
  assert.equal(slot.resourceUsage.userCPUTime, record.resourceObservation.processUserCpuMicroseconds);
  assert.equal(slot.resourceUsage.systemCPUTime, record.resourceObservation.processSystemCpuMicroseconds);
  assert.equal(slot.resourceUsage.maxRSS, record.resourceObservation.processMaximumResidentSetKiB);
  assert.equal(slot.containerResourceUsage, null);

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(
    resolve(root, 'evidence/qualification/e02-v1/registered-e02-1/evidence.sqlite'),
    { readOnly: true },
  );
  try {
    for (const [table, expected] of Object.entries(record.databaseCounts)) {
      assert.match(table, /^[a-z_]+$/u);
      const actual = database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
      assert.equal(Number(actual), expected, `${table} count changed`);
    }
    const row = database.prepare(
      "SELECT canonical_json FROM intervention_log WHERE json_extract(canonical_json, '$.eventType') = 'safety-trigger'",
    ).get();
    assert.ok(row, 'retained database has no safety-trigger event');
    const event = JSON.parse(row.canonical_json);
    assert.equal(event.runId, record.progress.runId);
    assert.equal(event.sequence, 2);
    assert.equal(event.eventType, record.terminalCause.eventType);
    assert.equal(event.actorId, record.terminalCause.actorId);
    assert.equal(event.reasonCode, record.terminalCause.reasonCode);
    assert.equal(event.recordedAt, record.terminalCause.recordedAt);
    assert.equal(event.details.turn, record.progress.lastCommittedTurnIndex);
    assert.equal(event.details.lastReasonCode, record.terminalCause.lastReasonCode);
    assert.equal(event.details.consecutiveRejections, record.terminalCause.consecutiveRejections);
    assert.equal(event.details.maxConsecutiveRejections, record.terminalCause.maximumConsecutiveRejections);
  } finally {
    database.close();
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
    'usage: node scripts/check-e02-v1-failure-evidence.mjs [--live-evidence]');
  if (process.argv[2] === '--live-evidence') await validateE02V1LiveEvidence();
  else validateE02V1PortableEvidence();
  console.log(`E02 v1 failure evidence reconciles (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`);
}
