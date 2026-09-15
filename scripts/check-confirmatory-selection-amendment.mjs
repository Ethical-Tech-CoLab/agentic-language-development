import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256')
  .update(readFileSync(path)).digest('hex')}`;
const amendment = read('protocols/confirmatory-family-selection-amendment.v1.json');
const statistics = read('protocols/statistical-analysis-and-power.v1.json');
const allocation = read('protocols/seed-and-resource-allocation.v1.json');
const cards = read('protocols/research-protocol-cards.v1.json');

assert.equal(amendment.schemaVersion, 1);
assert.equal(amendment.classification, 'prospective-confirmatory-design-interpretation');
assert.equal(amendment.researchFinding, false);
assert.equal(amendment.independentHumanReview, false);
assert.equal(amendment.externalSpend, 0);
assert.equal(amendment.sourcePolicies.length, 3);
for (const source of amendment.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: amended selection source changed`);
assert.deepEqual(amendment.members, cards.confirmatoryFamily.members);
assert.equal(amendment.members.length, statistics.confirmatoryFamily.members);
assert.deepEqual(amendment.candidatePrimarySeeds,
  allocation.sampleSizeRule.candidatePrimarySeeds);
assert.equal(amendment.familywiseAlpha, allocation.sampleSizeRule.familyWiseAlpha);
assert.equal(amendment.familywiseAlpha, cards.confirmatoryFamily.familywiseAlpha);
assert.equal(amendment.monteCarloRepetitionsPerCandidate,
  allocation.sampleSizeRule.monteCarloRepetitions);
assert.equal(amendment.minimumLower95JointPower,
  allocation.sampleSizeRule.monteCarloLowerConfidenceFloor);
assert.equal(amendment.selection,
  'smallest-shared-candidate-with-complete-joint-lower-bound');
assert.match(statistics.confirmatoryFamily.selectionRule, /largest required primary-seed count/u);
assert.match(allocation.sampleSizeRule.selection, /smallest shared candidate N/u);
assert.match(amendment.resolution, /maximum of member-specific minima does not replace that joint gate/u);
console.log('Prospective nine-member family selection rule aligned; no pilot or power result');
