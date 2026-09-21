import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const paths = [1, 2, 3, 4, 5].map((version) =>
  `reports/research/mode-r-uncertain-write-development-v${String(version)}-failure.json`);
const sha256 = (target) => createHash('sha256').update(readFileSync(target)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

for (const [index, path] of paths.entries()) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.classification, 'selected-mode-r-uncertain-write-development-failure');
  assert.equal(report.researchFinding, false);
  assert.equal(report.b12Closed, false);
  assert.equal(report.passed, false);
  const expectedExitCodes = [1, 0, null, 0, 0];
  const expectedOomValues = [false, false, null, false, false];
  assert.equal(report.terminal.controllerExitCode, expectedExitCodes[index]);
  assert.equal(report.terminal.controllerOomKilled, expectedOomValues[index]);
  assert.equal(report.terminal.unexpectedRunningAfterTeardown, 0);
  assert.equal(git('show', '-s', '--format=%T', report.executionCommit), report.executionTree);
  assert.equal(JSON.parse(git('show', `${report.executionCommit}:package.json`)).version,
    report.executionVersion);
  assert.equal(readFileSync(report.protocol.path).byteLength, report.protocol.bytes);
  assert.equal(sha256(report.protocol.path), report.protocol.sha256.slice(7));
  if (index === 1) {
    assert.equal(report.observedInjection.operationalQuarantine,
      'evidence-write-uncertain');
    assert.equal(report.observedInjection.secondAttemptAddedEvidence, false);
    assert.equal(report.observedInjection.journalIntentCount, 1);
    assert.equal(report.observedInjection.journalConfirmationCount, 0);
    assert.equal(report.observedInjection.typescriptPrefixExitCode, 0);
    assert.equal(report.observedInjection.rustPrefixIntegrityPass, true);
  }
  if (index === 4) {
    assert.equal(report.terminal.recoveryControllerExitCode, 0);
    assert.equal(report.observedRecovery.errorName, 'IncompleteTurnEvidenceError');
    assert.equal(report.observedRecovery.operationalQuarantine,
      'incomplete-turn-evidence');
    assert.equal(report.verification.injectTypeScriptExitCode, 0);
    assert.equal(report.verification.injectRustIntegrityPass, true);
    assert.equal(report.verification.recoveryTypeScriptExitCode, 0);
    assert.equal(report.verification.recoveryRustIntegrityPass, true);
  }

  if (process.argv.includes('--live-evidence')) {
    assert.equal(readFileSync(report.rawReceipt.path).byteLength, report.rawReceipt.bytes);
    assert.equal(sha256(report.rawReceipt.path), report.rawReceipt.sha256.slice(7));
    const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
    assert.equal(raw.executionCommit, report.executionCommit);
    assert.equal(raw.passed, false);
    assert.equal(raw.injectTerminal?.exitCode ?? null, expectedExitCodes[index]);
    assert.equal(raw.injectTerminal?.oomKilled ?? null, expectedOomValues[index]);
    assert.equal(raw.unexpectedRunningAfterTeardown, 0);
    if (index === 1) {
      assert.equal(raw.inject.operationalQuarantine,
        report.observedInjection.operationalQuarantine);
      assert.deepEqual(raw.journal, {
        intentCount: report.observedInjection.journalIntentCount,
        confirmationCount: report.observedInjection.journalConfirmationCount,
      });
    }
    if (index === 4) {
      assert.equal(raw.recovery.recoveryError.name, report.observedRecovery.errorName);
      assert.equal(raw.recovery.operationalQuarantine,
        report.observedRecovery.operationalQuarantine);
      assert.equal(raw.verification.inject.typescript.exitCode, 0);
      assert.equal(raw.verification.inject.rust.integrityPass, true);
      assert.equal(raw.verification.recovery.typescript.exitCode, 0);
      assert.equal(raw.verification.recovery.rust.integrityPass, true);
    }
  }
}

console.log('selected uncertain-write v1-v5 failures reconcile; B12 remains open');
