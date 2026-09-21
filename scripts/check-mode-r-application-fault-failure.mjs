import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(
  'reports/research/mode-r-application-fault-development-v1-failure.json',
  'utf8',
));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

assert.equal(report.schemaVersion, 1);
assert.equal(report.classification,
  'selected-mode-r-application-fault-development-failure');
assert.equal(report.researchFinding, false);
assert.equal(report.b12Closed, false);
assert.equal(report.passed, false);
assert.equal(report.summary.caseCount, 6);
assert.equal(report.summary.passedCaseCount, 4);
assert.equal(report.summary.failedCaseCount, 2);
assert.equal(report.summary.resourceSnapshotCount, 12);
assert.equal(report.summary.unexpectedRunningAfterTeardown, 0);
assert.equal(report.deviations.length, 2);
assert.equal(report.verifiedPrefixEvidence.typescriptPassCount, 6);
assert.equal(report.verifiedPrefixEvidence.rustIntegrityPassCount, 6);
assert.equal(report.verifiedPrefixEvidence.issueCount, 0);
assert.equal(command('git', ['show', '-s', '--format=%T', report.executionCommit]),
  report.executionTree);
const sourcePackage = JSON.parse(command('git', [
  'show', `${report.executionCommit}:package.json`,
]));
assert.equal(sourcePackage.version, report.executionVersion);
assert.equal(readFileSync(report.protocol.path).byteLength, report.protocol.bytes);
assert.equal(sha256(report.protocol.path), report.protocol.sha256.slice(7));

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(report.rawReceipt.path).byteLength, report.rawReceipt.bytes);
  assert.equal(sha256(report.rawReceipt.path), report.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, report.executionCommit);
  assert.equal(raw.passed, false);
  assert.deepEqual(raw.summary, report.summary);
  assert.deepEqual(raw.cases.filter((entry) => entry.passed).map((entry) => entry.id),
    report.passingCases);
  assert.equal(raw.cases.every((entry) =>
    entry.typescriptVerification.exitCode === 0 &&
    entry.rustVerification.integrityPass === true), true);
}

console.log('selected application fault v1 failure reconciles; B12 remains open');
