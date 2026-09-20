import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const amendment = read('protocols/confirmatory-power-confidence-amendment.v1.json');

assert.equal(amendment.schemaVersion, 1);
assert.equal(amendment.classification, 'prospective-confirmatory-power-confidence-amendment');
assert.equal(amendment.researchFinding, false);
assert.equal(amendment.scientificDisposition, 'not-tested');
assert.equal(amendment.pilotDataInspected, false);
assert.equal(amendment.independentHumanReview, false);
assert.equal(amendment.externalSpend, 0);
for (const source of amendment.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: power-confidence source changed`);
assert.equal(amendment.familyConfidence, 0.95);
assert.equal(amendment.members, 9);
assert.ok(Math.abs(amendment.memberOneSidedAlpha - 0.05 / amendment.members) <= 1e-15);
assert.ok(Math.abs(amendment.memberWilsonEquivalentTwoSidedConfidence -
  (1 - 2 * amendment.memberOneSidedAlpha)) <= 1e-15);
assert.equal(amendment.minimumDependenceRobustFamilyLowerPower, 0.90);
assert.equal(amendment.jointDiagnosticConfidence, 0.95);
assert.equal(amendment.jointDiagnosticAuthority, false);
assert.match(amendment.rule, /simultaneous lower bounds/u);
assert.match(amendment.failureRule, /Do not revert to unadjusted member intervals/u);
console.log('Confirmatory member-power confidence is simultaneous at family 0.95; no pilot or power result exists');
