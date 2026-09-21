import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync('reports/research/lv01-development-v16-recurrent-receipt.json', 'utf8'));
const evidenceRoot = 'evidence/lv01/development-v16/lv01-development-v16-p0001';
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const jsonl = (path) => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'lv01-development-recurrent-path-receipt');
assert.equal(receipt.status, 'completed-bounded-development-observation');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(receipt.attempt.runId, 'lv01-development-v16-p0001');
assert.equal(receipt.observed.trainingTurns, 64);
assert.equal(receipt.observed.evaluationTurns, 24);
assert.equal(receipt.observed.offlineVerifierExitCode, 0);
assert.equal(receipt.observed.recurrentArchitecture, 'gru-actor-critic-v1');
assert.equal(receipt.observed.parameterCount, 4049);
assert.equal(receipt.observed.initialUpdateCount, 0);

for (const file of receipt.attempt.retainedFiles) {
  assert.equal(sha256(`${evidenceRoot}/${file.path}`), file.sha256, `${file.path} hash changed`);
}
for (const role of ['baby-a', 'baby-b']) {
  const initial = JSON.parse(readFileSync(`${evidenceRoot}/output/bundle/policies/${role}-policy-initial.json`, 'utf8'));
  const latest = JSON.parse(readFileSync(`${evidenceRoot}/output/bundle/policies/${role}-latest.json`, 'utf8'));
  assert.equal(initial.model.architecture, receipt.observed.recurrentArchitecture);
  assert.equal(initial.model.parameterCount, receipt.observed.parameterCount);
  assert.equal(initial.model.updateCount, receipt.observed.initialUpdateCount);
  assert.equal(latest.model.updateCount, receipt.observed.finalUpdateCountByRole[role]);
  const hashes = jsonl(`${evidenceRoot}/output/bundle/${role}-ledger.jsonl`)
    .filter((event) => event.eventType === 'policy.checkpointed')
    .map((event) => event.content.policyHash);
  assert.deepEqual(hashes, receipt.observed.evaluationPolicyHashes[role]);
  assert.equal(hashes[0], hashes[1], `${role} policy changed during evaluation`);
}

console.log('LV01 v16 bounded recurrent-path receipt verified against retained local evidence');
