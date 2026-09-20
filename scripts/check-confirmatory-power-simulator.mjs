import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const specification = read('protocols/confirmatory-power-simulator.v1.json');
const source = readFileSync('packages/analysis/src/confirmatory-power-simulation.ts', 'utf8');

assert.equal(specification.schemaVersion, 1);
assert.equal(specification.classification, 'prospective-confirmatory-power-simulator-specification');
assert.equal(specification.researchFinding, false);
assert.equal(specification.scientificDisposition, 'not-tested');
assert.equal(specification.pilotDataInspected, false);
assert.equal(specification.independentHumanReview, false);
assert.equal(specification.externalSpend, 0);
for (const input of specification.sourcePolicies) assert.equal(sha256(input.path), input.sha256,
  `${input.path}: simulator source policy changed`);
assert.equal(specification.analysisVersion, 'confirmatory-power-simulation/v1');
assert.equal(specification.pilotAnalysisVersion, 'confirmatory-pilot-summary/v2');
assert.deepEqual(specification.candidatePrimarySeeds, [25,50,75,100,125,150,200,300]);
assert.equal(specification.repetitionsPerCandidate, 30000);
assert.equal(specification.componentScientificAlpha, 0.05 / 9);
assert.equal(specification.continuousWorkingModel.distribution, 'normal');
assert.match(specification.continuousWorkingModel.dispersion, /upper SD/u);
assert.match(specification.binaryWorkingModel.test, /exact binomial/u);
assert.equal(specification.diagnosticDependenceModel, 'independent-component-streams-diagnostic-only');
assert.match(specification.selectionAuthority, /fourteen component success counts/u);
assert.match(specification.selectionAuthority, /cannot authorize a smaller/u);
assert.match(specification.distributionalLimitation, /not evidence/u);
assert.match(specification.failureRule, /blocks simulation admission/u);
assert.match(specification.qualificationRule, /synthetic fixtures/u);
for (const required of [
  "CONFIRMATORY_COMPONENT_TEST_ALPHA = 0.05 / 9",
  "CONFIRMATORY_MONTE_CARLO_REPETITIONS",
  "independent-component-streams-diagnostic-only",
  "studentTQuantile",
  "binomialTest",
  "root.derive(`${primarySeeds}/${memberId}/${componentId}`)",
]) assert.ok(source.includes(required), `simulator implementation missing ${required}`);
console.log('Prospective deterministic confirmatory power simulator is bound; no pilot or power result exists');
