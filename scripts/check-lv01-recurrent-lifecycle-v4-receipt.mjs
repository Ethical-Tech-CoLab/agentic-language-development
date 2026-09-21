import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = 'evidence/lv01/recurrent-lifecycle-v4/lv01-recurrent-lifecycle-v4-p0001';
const receipt = JSON.parse(readFileSync('reports/research/lv01-recurrent-lifecycle-v4-receipt.json', 'utf8'));
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
assert.equal(hash(`${root}/receipt.json`), receipt.attempt.rawReceiptSha256);
const raw = JSON.parse(readFileSync(`${root}/receipt.json`, 'utf8'));
assert.equal(raw.passed, true);
assert.equal(raw.offlineVerification.exitCode, 0);
assert.equal(raw.summary.recreatedServiceIdentityChanges, 6);
for (const role of ['baby-a', 'baby-b']) {
  assert.equal(raw.policies[role].architecture, receipt.observed.recurrentArchitecture);
  assert.equal(raw.policies[role].finalUpdateCount, receipt.observed.finalUpdateCountByRole[role]);
  assert.equal(hash(`${root}/output/bundle/policies/${role}-policy-initial.json`), receipt.policyFiles[role].initial);
  assert.equal(hash(`${root}/output/bundle/policies/${role}-latest.json`), receipt.policyFiles[role].latest);
}
console.log('LV01 v4 recurrent selected-lifecycle receipt verified against retained local evidence');
