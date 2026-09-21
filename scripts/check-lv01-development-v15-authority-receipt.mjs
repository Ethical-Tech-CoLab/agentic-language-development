import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receiptPath = 'reports/research/lv01-development-v15-authority-receipt.json';
const evidenceRoot = 'evidence/lv01/development-v15/lv01-development-v15-p0001';
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'lv01-development-topology-authority-receipt');
assert.equal(receipt.status, 'completed-bounded-development-observation');
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(receipt.attempt.runId, 'lv01-development-v15-p0001');
assert.equal(receipt.attempt.allocation, 'protocols/lv01-development-resource-allocation.v15.json');
assert.equal(receipt.observed.state, 'sealed');
assert.equal(receipt.observed.trainingTurns, 64);
assert.equal(receipt.observed.evaluationTurns, 24);
assert.equal(receipt.observed.checkpointCount, 12);
assert.equal(receipt.observed.offlineVerifierExitCode, 0);
assert.equal(receipt.observed.serviceCount, 17);
assert.equal(receipt.observed.deniedPrivateModelAccessProbes, 4);
assert.ok(receipt.observed.resourceSamples >= receipt.observed.nonEmptyResourceSamples);
assert.ok(receipt.observed.nonEmptyResourceSamples > 0);

for (const file of receipt.attempt.retainedFiles) {
  assert.equal(sha256(`${evidenceRoot}/${file.path}`), file.sha256, `${file.path} hash changed`);
}

console.log('LV01 v15 bounded topology authority receipt verified against retained local evidence');
