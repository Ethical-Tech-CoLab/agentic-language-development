import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receiptPath =
  'reports/research/mode-r-uncertain-write-development-v6-qualification-receipt.json';
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const unchanged = (left, right) => assert.deepEqual(left, right);

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'selected-mode-r-uncertain-write-development-qualification');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.passed, true);
assert.equal(receipt.publicChainTransaction, false);
assert.equal(receipt.externalSpendingUsd, 0);
assert.equal(receipt.terminal.injectControllerExitCode, 0);
assert.equal(receipt.terminal.recoveryControllerExitCode, 0);
assert.equal(receipt.terminal.injectControllerOomKilled, false);
assert.equal(receipt.terminal.recoveryControllerOomKilled, false);
assert.equal(receipt.terminal.unexpectedRunningAfterTeardown, 0);
assert.equal(receipt.injection.remoteUnconfirmedErrorName, 'Error');
assert.equal(receipt.injection.quarantineErrorName, 'EvidenceWriteUncertainError');
assert.equal(receipt.injection.operationalQuarantine, 'evidence-write-uncertain');
unchanged(receipt.injection.initialCounts, {
  turns: 0, channel: 0, babyALedger: 0, babyBLedger: 0,
});
unchanged(receipt.injection.postCommitCounts, {
  turns: 0, channel: 1, babyALedger: 2, babyBLedger: 0,
});
assert.equal(receipt.injection.secondAttemptAddedEvidence, false);
assert.equal(receipt.injection.journalIntentCount, 1);
assert.equal(receipt.injection.journalConfirmationCount, 0);
assert.equal(receipt.recovery.recoveryErrorName, 'IncompleteTurnEvidenceError');
assert.equal(receipt.recovery.stepErrorName, 'IncompleteTurnEvidenceError');
assert.equal(receipt.recovery.operationalQuarantine, 'incomplete-turn-evidence');
unchanged(receipt.recovery.countsBeforeRecovery, receipt.injection.postCommitCounts);
assert.equal(receipt.recovery.recoveryAddedEvidence, false);
assert.equal(receipt.recovery.stepAddedEvidence, false);
for (const stage of ['inject', 'recovery']) {
  const verification = receipt.verification[stage];
  assert.equal(verification.typescriptExitCode, 0);
  assert.equal(verification.rustIntegrityPass, true);
  assert.equal(verification.rustEventCount, 4);
  assert.equal(verification.rustCheckpointCount, 1);
  assert.equal(verification.rustIssueCount, 0);
}
assert.equal(receipt.verification.resourceSnapshotCount, 2);
assert.equal(git('show', '-s', '--format=%T', receipt.executionCommit),
  receipt.executionTree);
assert.equal(JSON.parse(git('show', `${receipt.executionCommit}:package.json`)).version,
  receipt.executionVersion);
assert.equal(readFileSync(receipt.protocol.path).byteLength, receipt.protocol.bytes);
assert.equal(sha256(receipt.protocol.path), receipt.protocol.sha256.slice(7));

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(receipt.rawReceipt.path).byteLength, receipt.rawReceipt.bytes);
  assert.equal(sha256(receipt.rawReceipt.path), receipt.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(receipt.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, receipt.executionCommit);
  assert.equal(raw.passed, true);
  assert.equal(raw.failure, null);
  assert.equal(raw.injectTerminal.exitCode, receipt.terminal.injectControllerExitCode);
  assert.equal(raw.recoveryTerminal.exitCode, receipt.terminal.recoveryControllerExitCode);
  assert.equal(raw.injectTerminal.oomKilled, receipt.terminal.injectControllerOomKilled);
  assert.equal(raw.recoveryTerminal.oomKilled,
    receipt.terminal.recoveryControllerOomKilled);
  assert.equal(raw.unexpectedRunningAfterTeardown,
    receipt.terminal.unexpectedRunningAfterTeardown);
  assert.equal(raw.inject.firstError.name, receipt.injection.remoteUnconfirmedErrorName);
  assert.equal(raw.inject.secondError.name, receipt.injection.quarantineErrorName);
  assert.equal(raw.inject.operationalQuarantine, receipt.injection.operationalQuarantine);
  unchanged(raw.inject.before, receipt.injection.initialCounts);
  unchanged(raw.inject.afterFirst, receipt.injection.postCommitCounts);
  unchanged(raw.inject.afterSecond, receipt.injection.postCommitCounts);
  assert.equal(raw.journal.intentCount, receipt.injection.journalIntentCount);
  assert.equal(raw.journal.confirmationCount, receipt.injection.journalConfirmationCount);
  assert.equal(raw.recovery.recoveryError.name, receipt.recovery.recoveryErrorName);
  assert.equal(raw.recovery.stepError.name, receipt.recovery.stepErrorName);
  assert.equal(raw.recovery.operationalQuarantine, receipt.recovery.operationalQuarantine);
  unchanged(raw.recovery.before, receipt.recovery.countsBeforeRecovery);
  unchanged(raw.recovery.afterRecovery, receipt.recovery.countsBeforeRecovery);
  unchanged(raw.recovery.afterStep, receipt.recovery.countsBeforeRecovery);
  for (const stage of ['inject', 'recovery']) {
    assert.equal(raw.verification[stage].typescript.exitCode, 0);
    assert.equal(raw.verification[stage].rust.integrityPass, true);
    assert.equal(raw.verification[stage].rust.eventCount, 4);
    assert.equal(raw.verification[stage].rust.checkpointCount, 1);
    assert.equal(raw.verification[stage].rust.issues.length, 0);
  }
  assert.equal(raw.resourceSnapshots.length, receipt.verification.resourceSnapshotCount);
}

console.log('selected uncertain-write v6 qualification valid; B12 remains open');
