import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync(
  'reports/research/lv01-paired-development-v21-receipt.json', 'utf8',
));
const root = 'evidence/lv01/paired-development-v21';
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const raw = JSON.parse(readFileSync(`${root}/paired-case-receipt.json`, 'utf8'));
const packet = JSON.parse(readFileSync(
  'protocols/lv01-paired-development-allocation.v21.json', 'utf8',
));

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'lv01-seven-branch-development-fixture-receipt');
assert.equal(receipt.status, 'completed-bounded-development-observation');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(hash(`${root}/paired-case-receipt.json`), receipt.attempt.rawReceiptSha256);
assert.equal(receipt.attempt.parentRunId, raw.parentRunId);
assert.equal(receipt.attempt.parentRunId, packet.parentRunId);
assert.deepEqual(receipt.observed.branchOrder, packet.branchOrder);
assert.deepEqual(raw.branches.map((branch) => branch.branch), receipt.observed.branchOrder);
assert.equal(raw.parentCheckpointHash, receipt.observed.parentCheckpointHash);
assert.equal(raw.preStateCommitment, receipt.observed.preStateCommitment);
assert.equal(raw.caseCommitment, receipt.observed.caseCommitment);
assert.equal(raw.branches.length, receipt.observed.sealedBranchCount);
for (const branch of raw.branches) {
  assert.equal(branch.scenarioHash, receipt.observed.sharedScenarioHash);
  assert.equal(branch.receiverDrawCommitment, receipt.observed.sharedReceiverDrawCommitment);
  assert.equal(branch.preStateCommitment, receipt.observed.preStateCommitment);
  assert.equal(branch.actionRecordedAfterPrediction, true);
  assert.equal(branch.restoredBeforeAction, true);
}
console.log('LV01 v21 paired development receipt verified against retained local evidence');
