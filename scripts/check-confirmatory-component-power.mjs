import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const amendment = read('protocols/confirmatory-component-power-amendment.v1.json');

assert.equal(amendment.schemaVersion, 1);
assert.equal(amendment.classification, 'prospective-confirmatory-component-power-amendment');
assert.equal(amendment.researchFinding, false);
assert.equal(amendment.scientificDisposition, 'not-tested');
assert.equal(amendment.pilotDataInspected, false);
assert.equal(amendment.independentHumanReview, false);
assert.equal(amendment.externalSpend, 0);
for (const source of amendment.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: component-power source changed`);
assert.equal(amendment.members, 9);
assert.equal(amendment.components, 14);
assert.equal(amendment.familyConfidence, 0.95);
assert.ok(Math.abs(amendment.componentOneSidedAlpha - 0.05 / amendment.components) <= 1e-15);
assert.ok(Math.abs(amendment.componentWilsonEquivalentTwoSidedConfidence -
  (1 - 2 * amendment.componentOneSidedAlpha)) <= 1e-15);
assert.match(amendment.memberLowerBound, /sum over its components/u);
assert.match(amendment.familyLowerBound, /all fourteen components/u);
assert.match(amendment.diagnosticAuthority, /diagnostics only/u);
assert.match(amendment.failureRule, /blocks selection/u);
console.log('Confirmatory power selection is dependence-robust over all 14 components; no pilot or power result exists');
