import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const amendment = read('protocols/confirmatory-validity-reserve-amendment.v1.json');
const allocation = read('protocols/seed-and-resource-allocation.v1.json');

function binomialInvalidAtMost(reserves, attempts, probability) {
  if (reserves < 0) return 0;
  if (probability === 0) return 1;
  if (probability === 1) return reserves >= attempts ? 1 : 0;
  const logTerms = [];
  let logCombination = 0;
  for (let invalid = 0; invalid <= reserves; invalid += 1) {
    logTerms.push(logCombination + invalid * Math.log(probability) +
      (attempts - invalid) * Math.log1p(-probability));
    logCombination += Math.log(attempts - invalid) - Math.log(invalid + 1);
  }
  const maximum = Math.max(...logTerms);
  return Math.exp(maximum) * logTerms.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
}

assert.equal(amendment.schemaVersion, 1);
assert.equal(amendment.classification, 'prospective-confirmatory-validity-reserve-amendment');
assert.equal(amendment.researchFinding, false);
assert.equal(amendment.scientificDisposition, 'not-tested');
assert.equal(amendment.pilotDataInspected, false);
assert.equal(amendment.independentHumanReview, false);
assert.equal(amendment.externalSpend, 0);
for (const source of amendment.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: validity-reserve source changed`);
assert.deepEqual(amendment.candidatePrimarySeeds, allocation.sampleSizeRule.candidatePrimarySeeds);
assert.deepEqual(amendment.scope.experiments, ['E11','E13','E15','E16','E20','E30','E32']);
assert.equal(amendment.invalidProbabilityBound.method, 'wilson-score-one-sided-95');
assert.equal(amendment.adequacyModel.minimumProbability, 0.95);
assert.match(amendment.resourceGate, /does not authorize/u);
assert.match(amendment.failureRule, /Do not lower the 0.95 gate/u);

const probability = amendment.invalidProbabilityBound.zeroInvalidOfTwentyUpper;
assert.equal(amendment.zeroInvalidTwentySlotReference.length, amendment.candidatePrimarySeeds.length);
for (const [index, row] of amendment.zeroInvalidTwentySlotReference.entries()) {
  assert.equal(row.primarySeeds, amendment.candidatePrimarySeeds[index]);
  assert.equal(row.previousReserveSeeds, row.reserveSeeds - 1);
  const adequacy = binomialInvalidAtMost(row.reserveSeeds, row.primarySeeds + row.reserveSeeds, probability);
  const previous = binomialInvalidAtMost(row.previousReserveSeeds,
    row.primarySeeds + row.previousReserveSeeds, probability);
  assert.ok(Math.abs(adequacy - row.adequacy) <= 1e-12);
  assert.ok(Math.abs(previous - row.previousAdequacy) <= 1e-12);
  assert.ok(row.adequacy >= amendment.adequacyModel.minimumProbability);
  assert.ok(row.previousAdequacy < amendment.adequacyModel.minimumProbability);
  assert.ok(row.reserveSeeds > Math.ceil(row.primarySeeds * 0.10));
}
console.log('Prospective confirmatory validity reserves are minimal at the pilot upper bound; resources remain unauthorized');
