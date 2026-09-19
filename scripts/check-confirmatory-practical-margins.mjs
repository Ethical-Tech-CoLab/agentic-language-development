import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const policy = read('protocols/confirmatory-practical-margins.v1.json');
const cards = read('protocols/research-protocol-cards.v1.json');

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.classification, 'prospective-confirmatory-practical-margin-policy');
assert.equal(policy.status, 'frozen-before-confirmatory-family-pilots');
assert.equal(policy.researchFinding, false);
assert.equal(policy.scientificDisposition, 'not-tested');
assert.equal(policy.pilotDataInspected, false);
assert.equal(policy.independentHumanReview, false);
assert.equal(policy.externalSpend, 0);
for (const source of policy.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: practical-margin source changed`);
assert.deepEqual(policy.members.map((member) => member.id), cards.confirmatoryFamily.members);
assert.deepEqual(policy.members.map((member) => member.experiment),
  ['E11','E16','E15','E16','E13','E20','E20','E30','E32']);
for (const member of policy.members) {
  assert.ok(Object.values(member.margin).every((value) => Number.isFinite(value)));
  assert.ok(member.rationale.length >= 50);
}
assert.deepEqual(policy.h5StableConventionRule, {
  analysisVersion: 'stable-convention/v1', windowSize: 100, stepSize: 25,
  requiredConsecutiveWindows: 3, minimumFormConsistency: 0.8,
  minimumRepeatedUseShare: 0.8, minimumMeanCausalListening: 0.05,
});
assert.deepEqual(policy.h8RegisteredSpaces.privateStateIds,
  ['candidate-0','candidate-1','candidate-2','candidate-3']);
assert.deepEqual(policy.h8RegisteredSpaces.actionIds,
  ['candidate-0','candidate-1','candidate-2','candidate-3','no-agreement']);
assert.equal(policy.members.find((member) => member.id === 'H6b')
  .margin.excessConditionalMutualInformationUpperBelowBits, 0.02);
assert.match(policy.amendmentRule, /observed pilot values cannot justify a change/u);
console.log('Confirmatory practical margins frozen outcome-blind for 9 family members; no pilot or power result');
