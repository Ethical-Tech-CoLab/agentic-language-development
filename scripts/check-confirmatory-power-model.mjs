import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const model = read('protocols/confirmatory-power-model-amendment.v1.json');
const margins = read('protocols/confirmatory-practical-margins.v1.json');
const allocation = read('protocols/seed-and-resource-allocation.v1.json');

assert.equal(model.schemaVersion, 1);
assert.equal(model.classification, 'prospective-confirmatory-power-model-amendment');
assert.equal(model.researchFinding, false);
assert.equal(model.scientificDisposition, 'not-tested');
assert.equal(model.pilotDataInspected, false);
assert.equal(model.independentHumanReview, false);
assert.equal(model.externalSpend, 0);
for (const source of model.sourcePolicies) assert.equal(sha256(source.path), source.sha256,
  `${source.path}: power-model source changed`);
assert.equal(model.familywiseAlpha, 0.05);
assert.equal(model.members, 9);
assert.equal(model.components, 14);
assert.equal(model.componentScreeningAlpha, model.familywiseAlpha / model.members);
assert.deepEqual(model.candidatePrimarySeeds, allocation.sampleSizeRule.candidatePrimarySeeds);
assert.equal(model.monteCarloRepetitionsPerCandidate, allocation.sampleSizeRule.monteCarloRepetitions);
assert.deepEqual(model.designAlternatives.map((entry) => entry.id), margins.members.map((entry) => entry.id));
assert.match(model.selectionAuthority, /dependence-robust family lower bound/u);
assert.match(model.selectionAuthority, /reserve-adequacy probability at least 0.95/u);
assert.match(model.jointSimulationRole, /cannot select a smaller N/u);
assert.match(model.reserveRule, /one-sided 95% upper invalid-run probability/u);
assert.match(model.failureRule, /Margins cannot be widened/u);
assert.equal(model.designAlternatives.find((entry) => entry.id === 'H6b').nullBoundary, 0.02);
assert.equal(model.designAlternatives.find((entry) => entry.id === 'H6b').components['excess-cmi-bits'], 0);
console.log('Dependence-robust confirmatory power model frozen; no pilot, simulation, or selected N exists');
