import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync(
  'reports/research/mode-r-application-development-v6-qualification-receipt.json',
  'utf8',
));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'selected-mode-r-application-development-qualification');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.passed, true);
assert.equal(receipt.publicChainTransaction, false);
assert.equal(receipt.externalSpendingUsd, 0);
assert.equal(receipt.runId, 'mode-r-application-v6');
assert.equal(command('git', ['show', '-s', '--format=%T', receipt.executionCommit]),
  receipt.executionTree);
const sourcePackage = JSON.parse(command('git', [
  'show', `${receipt.executionCommit}:package.json`,
]));
assert.equal(sourcePackage.version, receipt.executionVersion);
assert.equal(sha256(receipt.protocol.path), receipt.protocol.sha256.slice(7));
assert.equal(readFileSync(receipt.protocol.path).byteLength, receipt.protocol.bytes);
assert.deepEqual(receipt.execution.turns, [0, 1]);
assert.equal(receipt.execution.auditEntryCount, 1);
assert.equal(receipt.execution.controllerExitCode, 0);
assert.equal(receipt.execution.offlineVerifierExitCode, 0);
assert.equal(receipt.application.serviceCount, 17);
assert.equal(receipt.application.distinctContainerIdCount, 17);
assert.equal(receipt.application.distinctHostPidCountAtPostRunSnapshot, 13);
assert.equal(receipt.application.expectedSuccessfulExitedServiceCount, 4);
assert.equal(receipt.application.networkMismatchCount, 0);
assert.equal(receipt.application.mountMismatchCount, 0);
assert.equal(receipt.application.serviceStateMismatchCount, 0);
assert.equal(receipt.application.unexpectedRunningAfterTeardown, 0);
assert.equal(receipt.independentRustAudit.integrityPass, true);
assert.equal(receipt.independentRustAudit.anchored, false);
assert.equal(receipt.independentRustAudit.eventCount, 16);
assert.equal(receipt.independentRustAudit.checkpointCount, 4);
assert.equal(receipt.independentRustAudit.issueCount, 0);

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(receipt.rawReceipt.path).byteLength, receipt.rawReceipt.bytes);
  assert.equal(sha256(receipt.rawReceipt.path), receipt.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(receipt.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, receipt.executionCommit);
  assert.equal(raw.runId, receipt.runId);
  assert.equal(raw.passed, true);
  assert.deepEqual(raw.controller.turns, receipt.execution.turns);
  assert.equal(raw.controller.auditEntryCount, receipt.execution.auditEntryCount);
  assert.equal(raw.offlineVerification.exitCode, 0);
  assert.equal(raw.offlineVerification.bundleManifestHash,
    receipt.execution.bundleManifestHash);
}

console.log('selected application development receipt valid; raw evidence replay is separate; B12 remains open');
