import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { RecurrentCommunicationModel } from '@ald/learners';

const receipt = JSON.parse(readFileSync('reports/research/lv01-development-v16-restoration-receipt.json', 'utf8'));
const root = 'evidence/lv01/development-v16/lv01-development-v16-p0001/output/bundle/policies';
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'lv01-development-recurrent-restoration-receipt');
assert.equal(receipt.status, 'completed-bounded-development-observation');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.scientificDisposition, 'not-tested');

for (const role of ['baby-a', 'baby-b']) {
  const path = `${root}/${role}-latest.json`;
  assert.equal(sha256(path), receipt.attempt.policyFiles[role], `${role} policy hash changed`);
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  const restore = () => {
    const model = new RecurrentCommunicationModel(`lv01-v16-${role}-independent-restore`, policy.model.options);
    model.restore(policy.model);
    return model;
  };
  const left = restore().receiver(receipt.probe.turn, receipt.probe.symbolIndices,
    receipt.probe.candidateTypeCodes, receipt.probe.temperature, receipt.probe.advance);
  const right = restore().receiver(receipt.probe.turn, receipt.probe.symbolIndices,
    receipt.probe.candidateTypeCodes, receipt.probe.temperature, receipt.probe.advance);
  const observed = receipt.observed[role];
  assert.equal(left.value, observed.value);
  assert.deepEqual(left.distributions[0], observed.distribution);
  const difference = Math.max(Math.abs(left.value - right.value),
    ...left.distributions[0].map((value, index) => Math.abs(value - right.distributions[0][index])));
  assert.ok(difference <= receipt.probe.maximumAbsoluteDifference, `${role} restore drift exceeds bound`);
  assert.equal(difference, observed.maxAbsoluteDifference);
}

console.log('LV01 v16 bounded recurrent restoration receipt verified against retained local evidence');
