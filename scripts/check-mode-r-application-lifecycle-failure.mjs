import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const reports = [1, 2, 3].map((version) => JSON.parse(readFileSync(
  `reports/research/mode-r-application-lifecycle-development-v${version}-failure.json`,
  'utf8',
)));
const [v1, v2, v3] = reports;
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

for (const report of reports) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.researchFinding, false);
  assert.equal(report.b12Closed, false);
  assert.equal(report.turnsRecorded, 1);
  assert.equal(report.offlineVerifierAttempted, false);
  assert.equal(report.gatePassed, false);
  assert.equal(command('git', ['cat-file', '-t', report.executionCommit]), 'commit');
}
assert.equal(v1.classification,
  'selected-mode-r-application-lifecycle-transition-failure');
assert.equal(v1.attemptedRunId, 'mode-r-application-lifecycle-v1');
assert.equal(v1.stage, 'prepare-lifecycle-transition');
assert.equal(v1.controllerExitCode, 1);
assert.equal(v1.restoreAttempted, false);
assert.equal(v2.classification,
  'selected-mode-r-application-lifecycle-recovery-startup-failure');
assert.equal(v2.attemptedRunId, 'mode-r-application-lifecycle-v2');
assert.equal(v2.stage, 'recovery-adapter-initialization');
assert.equal(v2.firstControllerExitCode, 0);
assert.equal(v2.recoveryControllerExitCode, 1);
assert.equal(v2.pauseCompleted, true);
assert.equal(v2.restoreCompleted, false);
assert.equal(v3.classification,
  'selected-mode-r-application-lifecycle-stale-socket-failure');
assert.equal(v3.attemptedRunId, 'mode-r-application-lifecycle-v3');
assert.equal(v3.stage, 'replacement-gateway-readiness');
assert.equal(v3.firstControllerExitCode, 0);
assert.equal(v3.pauseCompleted, true);
assert.equal(v3.replacementGatewayReady, false);
assert.equal(v3.recoveryControllerStarted, false);

for (const [report, expectedVersion] of [
  [v1, '0.1.278'], [v2, '0.1.279'], [v3, '0.1.280'],
]) {
  const sourcePackage = JSON.parse(command('git', [
    'show', `${report.executionCommit}:package.json`,
  ]));
  assert.equal(sourcePackage.version, expectedVersion);
}

if (process.argv.includes('--live-evidence')) {
  for (const report of reports) {
    const artifacts = [report.rawReceipt, report.rawLogs, report.retainedDatabase];
    if (report.prepareResult !== undefined) artifacts.push(report.prepareResult);
    for (const artifact of artifacts) {
      assert.equal(readFileSync(artifact.path).byteLength, artifact.bytes);
      assert.equal(sha256(artifact.path), artifact.sha256.slice(7));
    }
    const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
    assert.equal(raw.executionCommit, report.executionCommit);
    assert.equal(raw.runId, report.attemptedRunId);
    assert.equal(raw.passed, false);
    assert.equal(raw.recovery, null);
    assert.equal(raw.offlineVerification, null);
    assert.equal(raw.summary.unexpectedRunningAfterTeardown, 0);
  }
  const rawV1 = JSON.parse(readFileSync(v1.rawReceipt.path, 'utf8'));
  assert.equal(rawV1.failure.startsWith('prepare controller failed'), true);
  assert.equal(rawV1.prepare, null);
  const rawV2 = JSON.parse(readFileSync(v2.rawReceipt.path, 'utf8'));
  assert.equal(rawV2.failure.startsWith('recovery controller failed'), true);
  assert.equal(rawV2.prepare.pausedState, 'paused');
  assert.equal(rawV2.prepare.pausedTurn, 1);
  assert.equal(rawV2.summary.recreatedServiceIdentityChanges, 6);
  const rawV3 = JSON.parse(readFileSync(v3.rawReceipt.path, 'utf8'));
  assert.equal(rawV3.failure, 'gateway did not report ready within 60000 ms');
  assert.equal(rawV3.prepare.pausedState, 'paused');
  assert.equal(rawV3.summary.recreatedServiceIdentityChanges, 0);
}

console.log('selected application lifecycle v1-v3 failures reconcile; B12 remains open');
