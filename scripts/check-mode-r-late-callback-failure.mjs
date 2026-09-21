import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = 'reports/research/mode-r-late-callback-development-v1-failure.json';
const report = JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (target) => createHash('sha256').update(readFileSync(target)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

assert.equal(report.schemaVersion, 1);
assert.equal(report.classification, 'selected-mode-r-late-callback-development-failure');
assert.equal(report.researchFinding, false);
assert.equal(report.b12Closed, false);
assert.equal(report.passed, false);
assert.equal(report.rawReceiptPassedFlag, true);
assert.equal(report.observed.recordedBudgetMs, 30_000);
assert.equal(report.observed.actualAdapterDeadlineMs, 1_000);
assert.equal(report.observed.adapterQuarantined, true);
assert.equal(report.observed.lateWindowAddedEvidence, false);
assert.equal(report.observed.refusedActionsAddedEvidence, false);
assert.equal(report.observed.typescriptVerifierExitCode, 0);
assert.equal(report.observed.rustIntegrityPass, true);
assert.equal(report.terminal.unexpectedRunningAfterTeardown, 0);
assert.equal(git('show', '-s', '--format=%T', report.executionCommit), report.executionTree);
assert.equal(JSON.parse(git('show', `${report.executionCommit}:package.json`)).version,
  report.executionVersion);
assert.equal(readFileSync(report.protocol.path).byteLength, report.protocol.bytes);
assert.equal(sha256(report.protocol.path), report.protocol.sha256.slice(7));

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(report.rawReceipt.path).byteLength, report.rawReceipt.bytes);
  assert.equal(sha256(report.rawReceipt.path), report.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(report.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, report.executionCommit);
  assert.equal(raw.passed, report.rawReceiptPassedFlag);
  assert.equal(raw.result.deadlineEvents[0].details.budgetMs,
    report.observed.recordedBudgetMs);
  assert.deepEqual(raw.result.afterTimeout, raw.result.afterLateWindow);
  assert.deepEqual(raw.result.afterLateWindow, raw.result.afterRefusals);
  assert.equal(raw.verification.typescript.exitCode, 0);
  assert.equal(raw.verification.rust.integrityPass, true);
}

console.log('selected late-callback v1 failure reconciles; B12 remains open');
