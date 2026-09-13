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

export function validateE02V2FailureRecord(record, receipt) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.experimentId, 'E02');
  assert.equal(record.attemptVersion, 'v2');
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
  assert.equal(record.progress.runId, 'registered-e02-v2-1');
  assert.equal(record.progress.stage, 'before-restore-collection');
  assert.equal(record.progress.committedTurns, 161);
  assert.equal(record.progress.lastCommittedTurnIndex, 160);
  assert.equal(record.progress.deliveredAdapterObservations, 324);
  assert.equal(record.progress.acceptedChannelEvents, 162);
  assert.equal(record.progress.checkpointManifests, 1);
  assert.equal(record.progress.completedProbeReports, 0);
  assert.equal(record.progress.restoreCompleted, false);
  assert.equal(record.progress.finalExportCompleted, false);
  assert.match(record.terminalCause.recordedFailure, /^TurnDeadlineExceededError:/u);
  assert.equal(record.terminalCause.deadlineExceededCalls, 1);
  assert.equal(record.terminalCause.hostErrors, 0);
  assert.equal(record.terminalCause.timeouts, 1);
  assert.equal(record.terminalCause.responsesDropped, 1);
  assert.equal(record.terminalCause.safetyEventRecorded, false);
  assert.equal(record.collectorFailure.relationship, 'wrapper-assertion-after-slot-failure');
  assert.match(record.collectorFailure.message, /^AssertionError:/u);
  assert.equal(record.collectorFailure.receiptSlotCount, 0);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.slots.length, 0);
  assert.match(receipt.failure, /TurnDeadlineExceededError/u);
  assert.equal(receipt.researchFinding, false);
  assert.match(record.claimBoundary, /not a completed export/u);
}

export function validateE02V2PortableEvidence(root = process.cwd()) {
  const record = read(resolve(root, 'reports/research/e02-v2-failure-evidence.json'));
  const receipt = read(resolve(root, 'reports/research/e02-v2-qualification-receipt.json'));
  validateE02V2FailureRecord(record, receipt);
  for (const artifact of record.trackedArtifacts) validateArtifact(root, artifact);
  assert.equal(
    read(resolve(root, 'protocols/e02-registration.v2.json')).preRegistrationHash,
    record.registrationHash,
  );
  assert.equal(
    read(resolve(root, 'protocols/e02-registration-binding.v2.json')).preRegistrationHash,
    record.registrationHash,
  );
  return record;
}

export async function validateE02V2LiveEvidence(root = process.cwd()) {
  const record = validateE02V2PortableEvidence(root);
  for (const artifact of record.retainedRawArtifacts) validateArtifact(root, artifact);

  const attempt = read(resolve(root, 'evidence/qualification/e02-v2/attempt.json'));
  assert.equal(attempt.executionCommit, record.executionCommit);
  assert.equal(attempt.registrationHash, record.registrationHash);
  assert.equal(attempt.startedAt, record.startedAt);
  assert.equal(attempt.seeds.length, record.plannedSlots);
  assert.equal(attempt.noSameSeedRerun, true);

  const slot = read(resolve(root, 'evidence/qualification/e02-v2/registered-e02-v2-1/slot.json'));
  assert.equal(slot.runId, record.progress.runId);
  assert.equal(slot.executionProgress.stage, record.progress.stage);
  assert.equal(slot.executionProgress.turnRecords, record.progress.committedTurns);
  assert.equal(slot.captured.length, record.progress.deliveredAdapterObservations);
  assert.equal(slot.reports.length, record.progress.completedProbeReports);
  assert.equal(slot.restoreRecord, null);
  assert.equal(slot.probeEvaluation, 'not-reached');
  assert.equal(slot.passed, false);
  assert.equal(slot.failure, record.terminalCause.recordedFailure);
  assert.equal(slot.wallMilliseconds, record.resourceObservation.wallMilliseconds);
  assert.equal(slot.resourceUsage.userCPUTime, record.resourceObservation.processUserCpuMicroseconds);
  assert.equal(slot.resourceUsage.systemCPUTime, record.resourceObservation.processSystemCpuMicroseconds);
  assert.equal(slot.resourceUsage.maxRSS, record.resourceObservation.processMaximumResidentSetKiB);
  assert.equal(slot.containerResourceUsage.peakBytes, record.resourceObservation.nurseryCgroupPeakBytes);
  assert.equal(slot.containerResourceUsage.cpuUsageMicroseconds, record.resourceObservation.nurseryCgroupCpuUsageMicroseconds);
  const diagnostics = slot.adapterDiagnostics.map((entry) => entry.diagnostics);
  const transport = slot.adapterDiagnostics.map((entry) => entry.transportStats);
  assert.equal(diagnostics.reduce((sum, entry) => sum + entry.deadlineExceeded, 0), record.terminalCause.deadlineExceededCalls);
  assert.equal(diagnostics.reduce((sum, entry) => sum + entry.hostErrors, 0), record.terminalCause.hostErrors);
  assert.equal(transport.reduce((sum, entry) => sum + entry.timeouts, 0), record.terminalCause.timeouts);
  assert.equal(transport.reduce((sum, entry) => sum + entry.responsesDropped, 0), record.terminalCause.responsesDropped);

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(
    resolve(root, 'evidence/qualification/e02-v2/registered-e02-v2-1/evidence.sqlite'),
    { readOnly: true },
  );
  try {
    for (const [table, expected] of Object.entries(record.databaseCounts)) {
      assert.match(table, /^[a-z_]+$/u);
      const actual = database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
      assert.equal(Number(actual), expected, `${table} count changed`);
    }
    const lastTurn = database.prepare(
      'SELECT turn FROM turn_records ORDER BY sequence DESC LIMIT 1',
    ).get();
    assert.equal(Number(lastTurn.turn), record.progress.lastCommittedTurnIndex);
    const lastChannel = database.prepare(
      'SELECT turn, validation_result FROM channel_events ORDER BY sequence DESC LIMIT 1',
    ).get();
    assert.equal(Number(lastChannel.turn), record.progress.lastCommittedTurnIndex + 1);
    assert.equal(lastChannel.validation_result, 'accepted');
    const safetyEvents = database.prepare(
      "SELECT count(*) AS count FROM intervention_log WHERE event_type = 'safety-trigger'",
    ).get();
    assert.equal(Number(safetyEvents.count), 0);
    const receiverEvents = database.prepare(
      "SELECT count(*) AS count FROM ledger_events WHERE baby_id = 'A' AND turn = 161",
    ).get();
    assert.ok(Number(receiverEvents.count) >= 1);
  } finally {
    database.close();
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
    'usage: node scripts/check-e02-v2-failure-evidence.mjs [--live-evidence]',
  );
  if (process.argv[2] === '--live-evidence') await validateE02V2LiveEvidence();
  else validateE02V2PortableEvidence();
  console.log(
    `E02 v2 failure evidence reconciles (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`,
  );
}
