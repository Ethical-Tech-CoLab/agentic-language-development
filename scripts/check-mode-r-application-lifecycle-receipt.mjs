import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync(
  'reports/research/mode-r-application-lifecycle-development-v5-qualification-receipt.json',
  'utf8',
));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'selected-mode-r-application-lifecycle-development-qualification');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.passed, true);
assert.equal(receipt.runId, 'mode-r-application-lifecycle-v5');
assert.equal(command('git', ['show', '-s', '--format=%T', receipt.executionCommit]),
  receipt.executionTree);
const sourcePackage = JSON.parse(command('git', [
  'show', `${receipt.executionCommit}:package.json`,
]));
assert.equal(sourcePackage.version, receipt.executionVersion);
assert.equal(readFileSync(receipt.protocol.path).byteLength, receipt.protocol.bytes);
assert.equal(sha256(receipt.protocol.path), receipt.protocol.sha256.slice(7));
assert.equal(receipt.lifecycle.finalTurn, 3);
assert.equal(receipt.lifecycle.auditEntryCount, 1);
assert.equal(receipt.lifecycle.checkpointCount, 8);
assert.equal(receipt.application.recreatedServiceIdentityChanges, 6);
assert.equal(receipt.application.persistentServiceIdentityChanges, 0);
assert.equal(receipt.application.staleOwnedSocketsRemoved, 3);
assert.equal(receipt.application.networkMismatchCount, 0);
assert.equal(receipt.application.mountMismatchCount, 0);
assert.equal(receipt.application.offlineVerifierExitCode, 0);
assert.equal(receipt.application.unexpectedRunningAfterTeardown, 0);
assert.equal(receipt.bundle.independentRustAudit.integrityPass, true);
assert.equal(receipt.bundle.independentRustAudit.anchored, false);
assert.equal(receipt.bundle.independentRustAudit.eventCount, 26);
assert.equal(receipt.bundle.independentRustAudit.checkpointCount, 8);
assert.equal(receipt.bundle.independentRustAudit.issueCount, 0);

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(receipt.rawReceipt.path).byteLength, receipt.rawReceipt.bytes);
  assert.equal(sha256(receipt.rawReceipt.path), receipt.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(receipt.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, receipt.executionCommit);
  assert.equal(raw.runId, receipt.runId);
  assert.equal(raw.passed, true);
  assert.equal(raw.failure, null);
  assert.equal(raw.recovery.finalTurn, receipt.lifecycle.finalTurn);
  assert.equal(raw.recovery.auditEntryCount, receipt.lifecycle.auditEntryCount);
  assert.equal(raw.resources.length, receipt.application.resourceSnapshotCount);
  assert.equal(raw.offlineVerification.bundleManifestHash, receipt.bundle.manifestHash);
}

console.log('selected application lifecycle v5 qualification valid; B12 remains open');
