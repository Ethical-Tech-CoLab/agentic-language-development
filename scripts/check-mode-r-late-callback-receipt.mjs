import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path =
  'reports/research/mode-r-late-callback-development-v2-qualification-receipt.json';
const receipt = JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (target) => createHash('sha256').update(readFileSync(target)).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'selected-mode-r-late-callback-development-qualification');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.passed, true);
assert.equal(receipt.observation.terminalState, 'paused');
assert.equal(receipt.observation.channelReasonCode, 'timeout');
assert.equal(receipt.observation.logicalSender, 'baby-a');
assert.equal(receipt.observation.deadlineMethod, 'act');
assert.equal(receipt.observation.enforcedAndRecordedBudgetMs, 1_000);
assert.equal(receipt.observation.injectedDelayMs, 1_500);
assert.equal(receipt.observation.postDeadlineObservationMs, 2_500);
assert.equal(receipt.observation.adapterQuarantined, true);
assert.equal(receipt.observation.quarantineFailed, false);
assert.equal(receipt.observation.lateWindowAddedEvidence, false);
assert.equal(receipt.observation.refusedActionsAddedEvidence, false);
assert.equal(receipt.verification.typescriptExitCode, 0);
assert.equal(receipt.verification.rustIntegrityPass, true);
assert.equal(receipt.verification.rustIssueCount, 0);
assert.equal(receipt.terminal.unexpectedRunningAfterTeardown, 0);
assert.equal(git('show', '-s', '--format=%T', receipt.executionCommit), receipt.executionTree);
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
  assert.equal(raw.controllerTerminal.exitCode, receipt.terminal.controllerExitCode);
  assert.equal(raw.controllerTerminal.oomKilled, receipt.terminal.controllerOomKilled);
  assert.equal(raw.result.step.state, receipt.observation.terminalState);
  assert.equal(raw.result.step.channelReasonCode, receipt.observation.channelReasonCode);
  assert.equal(raw.result.deadlineEvents.length, 1);
  assert.equal(raw.result.deadlineEvents[0].details.budgetMs,
    receipt.observation.enforcedAndRecordedBudgetMs);
  assert.equal(raw.result.deadlineEvents[0].details.adapterQuarantined, true);
  assert.deepEqual(raw.result.afterTimeout, raw.result.afterLateWindow);
  assert.deepEqual(raw.result.afterLateWindow, raw.result.afterRefusals);
  assert.equal(raw.result.resumeError.name, receipt.observation.resumeErrorName);
  assert.equal(raw.result.stepError.name, receipt.observation.stepErrorName);
  assert.equal(raw.verification.typescript.exitCode, 0);
  assert.equal(raw.verification.rust.integrityPass, true);
  assert.equal(raw.verification.rust.eventCount, receipt.verification.rustEventCount);
  assert.equal(raw.verification.rust.checkpointCount,
    receipt.verification.rustCheckpointCount);
  assert.equal(raw.verification.rust.issues.length, receipt.verification.rustIssueCount);
  assert.equal(raw.resourceSnapshots.length, receipt.verification.resourceSnapshotCount);
}

console.log('selected late-callback v2 qualification valid; B12 remains open');
