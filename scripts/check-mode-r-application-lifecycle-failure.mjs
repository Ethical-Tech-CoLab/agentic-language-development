import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(
  'reports/research/mode-r-application-lifecycle-development-v1-failure.json',
  'utf8',
));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

assert.equal(report.schemaVersion, 1);
assert.equal(report.classification,
  'selected-mode-r-application-lifecycle-transition-failure');
assert.equal(report.researchFinding, false);
assert.equal(report.b12Closed, false);
assert.equal(report.attemptedRunId, 'mode-r-application-lifecycle-v1');
assert.equal(report.stage, 'prepare-lifecycle-transition');
assert.equal(report.controllerExitCode, 1);
assert.equal(report.turnsRecorded, 1);
assert.equal(report.restoreAttempted, false);
assert.equal(report.offlineVerifierAttempted, false);
assert.equal(report.gatePassed, false);
assert.equal(command('git', ['cat-file', '-t', report.executionCommit]), 'commit');
const sourcePackage = JSON.parse(command('git', [
  'show', `${report.executionCommit}:package.json`,
]));
assert.equal(sourcePackage.version, '0.1.278');

if (process.argv.includes('--live-evidence')) {
  for (const artifact of [report.rawReceipt, report.rawLogs, report.retainedDatabase]) {
    assert.equal(readFileSync(artifact.path).byteLength, artifact.bytes);
    assert.equal(sha256(artifact.path), artifact.sha256.slice(7));
  }
  const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, report.executionCommit);
  assert.equal(raw.runId, report.attemptedRunId);
  assert.equal(raw.passed, false);
  assert.equal(raw.failure.startsWith('prepare controller failed'), true);
  assert.equal(raw.prepare, null);
  assert.equal(raw.recovery, null);
  assert.equal(raw.offlineVerification, null);
  assert.equal(raw.summary.unexpectedRunningAfterTeardown, 0);
}

console.log('selected application lifecycle v1 failure reconciles; B12 remains open');
