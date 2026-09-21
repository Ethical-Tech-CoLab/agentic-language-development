import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync(
  'reports/research/mode-r-application-fault-development-v3-qualification-receipt.json',
  'utf8',
));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' }).trim();

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'selected-mode-r-application-fault-development-qualification');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.passed, true);
assert.equal(receipt.v3Summary.caseCount, 2);
assert.equal(receipt.v3Summary.passedCaseCount, 2);
assert.equal(receipt.v3Summary.failedCaseCount, 0);
assert.equal(receipt.v3Summary.resourceSnapshotCount, 4);
assert.equal(receipt.v3Summary.unexpectedRunningAfterTeardown, 0);
assert.equal(receipt.v3Cases.length, 2);
for (const entry of receipt.v3Cases) {
  assert.equal(entry.targetExitCode, 137);
  assert.equal(entry.targetOomKilled, false);
  assert.equal(entry.controllerExitCode, 0);
  assert.equal(entry.prefixVerification.typescriptExitCode, 0);
  assert.equal(entry.prefixVerification.rustIntegrityPass, true);
  assert.equal(entry.prefixVerification.rustIssueCount, 0);
  assert.equal(entry.postFaultVerification.typescriptExitCode, 0);
  assert.equal(entry.postFaultVerification.rustIntegrityPass, true);
  assert.equal(entry.postFaultVerification.rustIssueCount, 0);
}
assert.equal(receipt.v3Cases[0].disposition, 'committed-adapter-failure');
assert.equal(receipt.v3Cases[0].stateAfterFault, 'paused');
assert.equal(receipt.v3Cases[0].turnRecordCount, 2);
assert.equal(receipt.v3Cases[0].channelEventCount, 1);
assert.equal(receipt.v3Cases[1].disposition, 'sealing-blocked');
assert.equal(receipt.v3Cases[1].experimentDisposition, 'aborted');
assert.equal(receipt.v3Cases[1].anchorReceiptCount, 0);
assert.equal(receipt.v3Cases[1].anchorUnavailableDeviationCount, 1);
assert.equal(receipt.cumulativeProspectiveCaseCoverage.caseCount, 6);
assert.equal(new Set(receipt.cumulativeProspectiveCaseCoverage.cases).size, 6);
assert.equal(command('git', ['show', '-s', '--format=%T', receipt.executionCommit]),
  receipt.executionTree);
const sourcePackage = JSON.parse(command('git', [
  'show', `${receipt.executionCommit}:package.json`,
]));
assert.equal(sourcePackage.version, receipt.executionVersion);
assert.equal(readFileSync(receipt.protocol.path).byteLength, receipt.protocol.bytes);
assert.equal(sha256(receipt.protocol.path), receipt.protocol.sha256.slice(7));

if (process.argv.includes('--live-evidence')) {
  assert.equal(readFileSync(receipt.rawReceipt.path).byteLength, receipt.rawReceipt.bytes);
  assert.equal(sha256(receipt.rawReceipt.path), receipt.rawReceipt.sha256.slice(7));
  const raw = JSON.parse(readFileSync(receipt.rawReceipt.path, 'utf8'));
  assert.equal(raw.executionCommit, receipt.executionCommit);
  assert.equal(raw.passed, true);
  assert.deepEqual(raw.summary, receipt.v3Summary);
  for (const expected of receipt.v3Cases) {
    const entry = raw.cases.find((candidate) => candidate.id === expected.id);
    assert.ok(entry, `${expected.id} is absent from raw receipt`);
    assert.equal(entry.passed, true);
    assert.equal(entry.faultResult.postFaultDisposition, expected.disposition);
    assert.equal(entry.faultResult.stateAfterFault, expected.stateAfterFault);
    assert.equal(entry.typescriptVerification.exitCode, 0);
    assert.equal(entry.rustVerification.integrityPass, true);
    assert.equal(entry.postFaultTypeScriptVerification.exitCode, 0);
    assert.equal(entry.postFaultRustVerification.integrityPass, true);
  }
}

console.log('selected application fault v3 qualification valid; B12 remains open');
