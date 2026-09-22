import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(
  'reports/research/lv01-application-fault-v3-receipt.json', 'utf8',
));
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const raw = JSON.parse(readFileSync(report.rawReceiptPath, 'utf8'));

assert.equal(report.status, 'completed-bounded-development-observation');
assert.equal(report.researchFinding, false);
assert.equal(report.scientificDisposition, 'not-tested');
assert.equal(report.b12Closed, false);
assert.equal(hash(report.rawReceiptPath), report.rawReceiptSha256);
assert.equal(raw.qualificationId, 'lv01-application-fault-v3');
assert.equal(raw.executionCommit, report.executionCommit);
assert.equal(raw.researchFinding, false);
assert.equal(raw.b12Closed, false);
assert.equal(raw.passed, true);
assert.equal(raw.summary.caseCount, report.observed.caseCount);
assert.equal(raw.summary.passedCaseCount, report.observed.passedCaseCount);
assert.equal(raw.summary.failedCaseCount, report.observed.failedCaseCount);
assert.equal(raw.summary.resourceSnapshotCount, report.observed.resourceSnapshotCount);
assert.equal(raw.summary.unexpectedRunningAfterTeardown, report.observed.remainingContainers);
for (const expected of report.observed.cases) {
  const actual = raw.cases.find((entry) => entry.id === expected.id);
  assert.ok(actual, `missing case ${expected.id}`);
  assert.equal(actual.runId, expected.runId);
  assert.equal(actual.targetService, expected.targetService);
  assert.equal(actual.targetTerminal.exitCode, expected.targetExitCode);
  assert.equal(actual.targetTerminal.oomKilled, false);
  assert.equal(actual.faultResult.postFaultDisposition, expected.postFaultDisposition);
  assert.equal(actual.faultResult.stateAfterFault, expected.stateAfterFault);
  assert.equal(actual.faultResult.turnAfterFault, expected.turnAfterFault);
  assert.equal(actual.typescriptVerification.exitCode, 0);
  assert.equal(actual.rustVerification.integrityPass, true);
  assert.equal(actual.postFaultTypeScriptVerification.exitCode, 0);
  assert.equal(actual.postFaultRustVerification.integrityPass, true);
  assert.equal(actual.resourceSnapshots.length, expected.resourceSnapshots);
  assert.equal(actual.passed, true);
}
console.log('LV01 application fault v3 receipt verified against retained local evidence');
