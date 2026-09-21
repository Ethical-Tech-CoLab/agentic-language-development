#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const portablePath = 'reports/research/mode-r-baby-model-development-qualification-receipt.json';
const receipt = JSON.parse(readFileSync(portablePath, 'utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification,
  'portable-mode-r-baby-model-process-development-qualification');
assert.equal(receipt.passed, true);
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.registeredStudyExecution, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(receipt.b12Closed, false);
assert.equal(receipt.externalSpendUsd, 0);
assert.equal(git('rev-parse', `${receipt.execution.commit}^{tree}`), receipt.execution.tree);
assert.equal(JSON.parse(git('show', `${receipt.execution.commit}:package.json`)).version,
  receipt.execution.version);
assert.equal(receipt.execution.cleanBefore, true);
assert.equal(receipt.execution.cleanAfterRuntime, true);
assert.equal(JSON.parse(git('show', `${receipt.preExecutionLaunch.commit}:package.json`)).version,
  receipt.preExecutionLaunch.version);
assert.deepEqual(receipt.preExecutionLaunch, {
  commit: 'f9ab1d451cbed29423cdce86717d5a28e508e120',
  version: '0.1.258',
  errorCode: 'ERR_MODULE_NOT_FOUND',
  executeEntered: false,
  evidenceRootCreated: false,
  qualificationAttempt: false,
});
assert.equal(receipt.sourceArtifacts.length, 14);
for (const expected of receipt.sourceArtifacts) {
  const bytes = execFileSync('git', ['show', `${receipt.execution.commit}:${expected.path}`]);
  assert.equal(bytes.length, expected.bytes, `${expected.path} byte count`);
  assert.equal(sha256(bytes), expected.sha256, `${expected.path} sha256`);
}
assert.deepEqual(receipt.protocol, receipt.sourceArtifacts[0]);
assert.equal(sha256(readFileSync(receipt.protocol.path)), receipt.protocol.sha256);
assert.deepEqual(receipt.observations, {
  babyProcessCount: 2,
  modelAdapterProcessCount: 2,
  modelChildrenPerBaby: [1, 1],
  outerNormalizedDeadlineAuthorityCount: 2,
  conformanceEpisodes: 1,
  proposals: 2,
  ledgerDrafts: { 'baby-a': 2, 'baby-b': 3 },
  policyHashObservations: { 'baby-a': 1, 'baby-b': 1 },
  liveProcessesAfterDispose: 0,
  resourceSnapshot: {
    unit: 'KiB',
    processCount: 5,
    totalResidentKiB: 471380,
    qualification: 'single-live-snapshot-not-peak-or-selected-resource-envelope',
  },
});
assert.deepEqual(receipt.softwareGate, {
  testFiles: 215,
  tests: 2228,
  rustTests: 5,
  secretScanFiles: 960,
  knownHighVulnerabilities: 0,
});
assert.match(receipt.claimBoundary, /does not qualify the selected container topology/u);

const { values } = parseArgs({
  options: { 'live-evidence': { type: 'boolean', default: false } },
});
if (values['live-evidence']) {
  const bytes = readFileSync(receipt.sourceReceipt.path);
  assert.equal(bytes.length, receipt.sourceReceipt.bytes);
  assert.equal(sha256(bytes), receipt.sourceReceipt.sha256);
  const raw = JSON.parse(bytes);
  assert.equal(raw.execution.commit, receipt.execution.commit);
  assert.equal(raw.execution.tree, receipt.execution.tree);
  assert.equal(raw.execution.version, receipt.execution.version);
  assert.equal(raw.passed, true);
  assert.equal(raw.observations.babyProcessIds.length,
    receipt.observations.babyProcessCount);
  assert.equal(raw.observations.modelAdapterProcessIds.length,
    receipt.observations.modelAdapterProcessCount);
  assert.deepEqual(raw.observations.liveAfterDispose, []);
  execFileSync(process.execPath,
    ['scripts/run-mode-r-baby-model-qualification.mjs', '--audit'],
    { stdio: 'pipe' });
}

console.log(
  `Mode R Baby/model development qualification valid ` +
  `(${values['live-evidence'] ? 'portable + live evidence' : 'portable tracked evidence'}); ` +
  'selected application topology and B12 remain open',
);
