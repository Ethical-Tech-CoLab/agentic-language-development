import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { version: { type: 'string', default: '1' } } });
assert.match(values.version, /^[1-9]\d*$/u, 'version must be a positive integer');
const version = values.version;
const root = `evidence/lv01/paired-development-v${version}`;
const receiptPath = `${root}/paired-case-receipt.json`;
assert.ok(existsSync(receiptPath), `missing retained paired-case receipt: ${receiptPath}`);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const branchOrder = ['normal', 'blocked', 'dropped', 'shuffled', 'delayed', 'substituted', 'counterfactual'];

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'lv01-seven-branch-development-fixture');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(receipt.branches.length, branchOrder.length);
assert.deepEqual(receipt.branches.map((entry) => entry.branch), branchOrder);
assert.equal(new Set(receipt.branches.map((entry) => entry.runId)).size, branchOrder.length,
  'paired receipt reuses a branch run identity');
const [first] = receipt.branches;
assert.ok(first, 'paired receipt has no branch evidence');
for (const branch of receipt.branches) {
  assert.equal(branch.scenarioHash, first.scenarioHash, 'scenario state differs across paired branches');
  assert.equal(branch.receiverDrawCommitment, first.receiverDrawCommitment, 'receiver draw differs across paired branches');
  assert.equal(branch.preStateCommitment, first.preStateCommitment, 'pre-state differs across paired branches');
  assert.equal(branch.actionRecordedAfterPrediction, true, 'action chronology is not retained');
  assert.equal(branch.restoredBeforeAction, true, 'pre-action restore is not retained');
  assert.match(branch.predictionCommitment, /^sha256:[0-9a-f]{64}$/u);
  const output = `${root}/${branch.runId}/output`;
  const turnRows = readFileSync(`${output}/bundle/turn-records.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  const interventionRows = readFileSync(`${output}/bundle/intervention-log.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(turnRows.length, 1, `branch ${branch.branch} has an unexpected turn count`);
  assert.equal(turnRows[0].scenarioStateHash, branch.scenarioHash, `branch ${branch.branch} scenario hash differs from its bundle`);
  const prediction = interventionRows.find((entry) => entry.reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed');
  assert.ok(prediction, `branch ${branch.branch} has no pre-action prediction event`);
  assert.equal(prediction.details.commitment, branch.predictionCommitment, `branch ${branch.branch} prediction commitment differs from its bundle`);
  assert.deepEqual(prediction.details.preStateCommitment, branch.preStateCommitment, `branch ${branch.branch} pre-state commitment differs from its bundle`);
}
assert.equal(receipt.preStateCommitment, first.preStateCommitment);
assert.match(receipt.caseCommitment, /^sha256:[0-9a-f]{64}$/u);
console.log(`LV01 paired development v${version} receipt valid: seven one-turn branches; no research finding`);
