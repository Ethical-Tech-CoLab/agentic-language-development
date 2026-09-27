import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { version: { type: 'string', default: '1' } },
});
assert.match(values.version, /^[12]$/u, 'design version must be 1 or 2');
const version = values.version;

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const raw = (path) => readFileSync(path, 'utf8');
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

const design = read(`protocols/lv01-study-design.v${version}.json`);
const analysis = read(`protocols/lv01-analysis-plan.v${version}.json`);
const policy = read(`protocols/lv01-seed-resource-policy.v${version}.json`);
const cards = read('protocols/research-protocol-cards.v1.json');
const scenario = read('protocols/scenario-split-and-model-comparison.v1.json');

for (const value of [design, analysis, policy]) {
  assert.equal(value.schemaVersion, Number(version));
  assert.equal(value.studyId, 'LV01');
  assert.equal(value.researchFinding, false);
  assert.equal(value.scientificDisposition, 'not-tested');
  assert.equal(value.externalSpend, 0);
}

if (version === '1') {
  assert.equal(design.status, 'design-frozen-not-registered-not-executed');
  assert.equal(analysis.status, 'analysis-frozen-not-registered-not-executed');
  assert.equal(policy.status, 'outcome-blind-no-stage-allocation');
} else {
  assert.equal(design.status, 'draft-not-registered-not-executed');
  assert.equal(analysis.status, 'draft-not-registered-not-executed');
  assert.equal(policy.status, 'draft-outcome-blind-no-stage-allocation');
  assert.equal(design.classification, 'prospective-ledger-value-study-design');
  assert.equal(design.designVersion, 'lv01-study-design/v2');
  assert.equal(analysis.analysisVersion, 'lv01-analysis/v2');
  // v2 supersedes v1 byte-for-byte; any v1 drift breaks the v2 lineage.
  for (const value of [design, analysis, policy]) {
    assert.ok(value.supersedes?.path?.endsWith('.v1.json'), 'v2 file must supersede its v1 file');
    assert.equal(sha256(value.supersedes.path), value.supersedes.sha256, `${value.supersedes.path}: v1 bytes changed`);
    for (const source of value.sourcePolicies ?? []) {
      assert.equal(sha256(source.path), source.sha256, `${source.path}: source policy changed`);
    }
    assert.match(
      raw(`protocols/${value === design ? 'lv01-study-design' : value === analysis ? 'lv01-analysis-plan' : 'lv01-seed-resource-policy'}.v2.json`),
      /^(?!.*(TBD|TODO|FIXME|placeholder|lorem))/ius,
      'v2 design files must not contain placeholders',
    );
  }
}
assert.deepEqual(design.task.eligibleTypeCodes, scenario.scenario.trainAndValidationTargetTypeCodes);
assert.deepEqual(design.task.untouchedTypeCodes, scenario.scenario.heldOutTestTargetTypeCodes);
assert.equal(design.task.partitions.training.cases, 3000);
assert.equal(design.task.partitions.validationFit.cases, 240);
assert.equal(design.task.partitions.validationSelection.cases, 240);
assert.equal(design.task.partitions.withinSupportTest.cases, 240);
assert.equal(design.evaluation.receiverDecisionsPerDyad, 5160);
assert.equal(design.evaluation.testReceiverDecisionsPerDyad, 1680);
assert.deepEqual(design.evaluation.branches, [
  'normal', 'disabled', 'constant', 'random', 'shuffled', 'ledger-consistent', 'ledger-shuffled',
]);
assert.equal(design.learner.parameterCountPerAgent, 4049);
assert.equal(design.learner.inputSize, 50);
assert.equal(design.learner.hiddenSize, 16);
assert.equal(design.channel.inventorySize, 32);
assert.equal(design.execution.maximumParallelDyads, 1);
assert.equal(design.execution.anchorClass, 'simulated');
if (version === '1') {
  assert.equal(design.execution.turnResponseBudgetMs, 1000);
  assert.equal(design.execution.deploymentMode, 'research-grade');
  for (const source of design.sourcePolicies) {
    assert.equal(sha256(source.path), source.sha256, `${source.path}: source policy changed`);
  }
} else {
  assert.equal(design.execution.deploymentMode, 'prototype');
}
assert.equal(cards.cards.some((card) => card.id === 'LV01'), false, 'LV01 cannot rewrite the original portfolio');
assert.equal(analysis.family.familywiseAlpha, 0.05);
assert.equal(analysis.predictors.find((predictor) => predictor.id === 'exact-policy-replay').selectionEligible, false);
assert.equal(analysis.predictors.find((predictor) => predictor.id === 'outcome-reading-oracle').selectionEligible, false);
assert.equal(analysis.predictors.find((predictor) => predictor.id === 'ordinary-record-softmax').coefficientCount, 565);
if (version === '1') {
  assert.deepEqual(analysis.family.members, ['LV-P', 'LV-C', 'LV-L']);
  assert.equal(analysis.family.components.length, 6);
} else {
  assert.deepEqual(analysis.family.members, ['LV-U', 'LV-P', 'LV-C', 'LV-L']);
  assert.equal(analysis.family.components.length, 7);
  assert.match(analysis.family.intervals, /0\.05\/7/u);
}
assert.equal(analysis.family.components.find((component) => component.id === 'fidelity').nullBoundary, -0.02);
assert.equal(analysis.family.components.find((component) => component.id === 'fidelity').alternative, -0.01);
if (version === '2') {
  assert.equal(analysis.family.components.find((component) => component.id === 'incremental').nullBoundary, 0.02);
  assert.equal(analysis.family.components.find((component) => component.id === 'incremental').alternative, 0.04);
  assert.equal(policy.power.pilotComponents, 7);
  assert.equal(policy.power.pilotMembers, 4);
  assert.equal(policy.power.screeningAlpha, 0.0125);
}
assert.equal(policy.root, version === '1' ? 'ald-ledger-value-v1' : 'ald-ledger-value-v2');
assert.deepEqual(policy.stages.confirmatory.candidatePrimaryDyads, [75, 100, 125, 150, 200, 300]);
assert.equal(policy.stages.pilot.primaryDyads, 20);
assert.equal(policy.stages.pilot.reserves, 0);
assert.equal(policy.power.monteCarloRepetitions, 30000);
assert.equal(policy.power.minimumFamilyLowerPower, 0.9);
assert.equal(policy.resources.ceiling.cpuHours, 72);
assert.equal(policy.resources.ceiling.workingStorageGiB, 25);
assert.equal(policy.resources.ceiling.maximumResidentGiB, 6);
assert.equal(policy.resources.ceiling.externalSpend, 0);
console.log(`LV01 design v${version} contracts valid: frozen design/analysis/resource policy; no registration or execution`);
