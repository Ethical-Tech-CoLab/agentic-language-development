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
// v1 has no execution profile or direction amendment; v2 requires all five.
const profile = version === '2' ? read('protocols/lv01-prototype-execution-profile.v2.json') : null;
const amendment = version === '2' ? read('protocols/lv01-direction-amendment.v2.json') : null;

const envelope = version === '1' ? [design, analysis, policy] : [design, analysis, policy, profile, amendment];
for (const value of envelope) {
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
  assert.equal(profile.status, 'draft-not-registered-not-executed');
  assert.equal(amendment.status, 'draft-not-registered-not-executed');
  assert.equal(design.classification, 'prospective-ledger-value-study-design');
  assert.equal(design.designVersion, 'lv01-study-design/v2');
  assert.equal(analysis.analysisVersion, 'lv01-analysis/v2');
  assert.equal(profile.classification, 'prototype-execution-profile');
  assert.equal(profile.profileVersion, 'lv01-prototype-execution-profile/v2');
  assert.equal(amendment.classification, 'prospective-study-direction-amendment');
  assert.equal(amendment.amendmentVersion, 'lv01-direction-amendment/v2');
  // Strict contracts: any added, removed, or renamed top-level field fails.
  // Protocol corrections must update these lists deliberately in the same
  // change (plus the manuscript digests that pin the same bytes).
  assert.deepEqual(Object.keys(design).sort(), ['channel', 'chronology', 'claimBoundary', 'classification', 'designVersion', 'evaluation', 'execution', 'externalSpend', 'independentHumanReview', 'learner', 'observationSchemas', 'pilotDataInspected', 'publicChainTransaction', 'question', 'researchFinding', 'runConfig', 'schemaVersion', 'scientificDisposition', 'scopeBoundary', 'sourcePolicies', 'status', 'studyId', 'supersedes', 'task']);
  assert.deepEqual(Object.keys(analysis).sort(), ['analysisVersion', 'claimBoundary', 'classification', 'externalSpend', 'family', 'interpretation', 'invalidity', 'marginLineage', 'nativePredictor', 'ordinaryRecordWindow', 'pilotDataInspected', 'predictionTarget', 'predictors', 'researchFinding', 'schemaVersion', 'scientificDisposition', 'score', 'sourcePolicies', 'status', 'studyId', 'supersedes', 'targetBoundary']);
  assert.deepEqual(Object.keys(policy).sort(), ['claimBoundary', 'classification', 'derivation', 'externalSpend', 'policyVersion', 'power', 'researchFinding', 'resources', 'root', 'schemaVersion', 'scientificDisposition', 'sourcePolicies', 'stages', 'status', 'studyId', 'supersedes']);
  assert.deepEqual(Object.keys(profile).sort(), ['actionDraw', 'audit', 'batchEvaluation', 'claimBoundary', 'classification', 'conditions', 'consumerCheck', 'externalSpend', 'preActionCommitment', 'profileVersion', 'records', 'researchFinding', 'retention', 'runtime', 'schemaVersion', 'scientificDisposition', 'sourcePolicies', 'status', 'studyId']);
  assert.deepEqual(Object.keys(amendment).sort(), ['amendedPaths', 'amendmentScope', 'amendmentVersion', 'claimBoundary', 'claimLimits', 'classification', 'directionStatements', 'externalSpend', 'independentHumanReview', 'nineteenCardFamily', 'pilotDataInspected', 'preservedV1', 'researchFinding', 'schemaVersion', 'scientificDisposition', 'status', 'studyId']);
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
  // The profile has source policies but no v1 predecessor to supersede.
  for (const source of profile.sourcePolicies) {
    assert.equal(sha256(source.path), source.sha256, `${source.path}: source policy changed`);
  }
  assert.match(
    raw('protocols/lv01-prototype-execution-profile.v2.json'),
    /^(?!.*(TBD|TODO|FIXME|placeholder|lorem))/ius,
    'v2 design files must not contain placeholders',
  );
  // The amendment pins v1 bytes and the portfolio instead of superseding.
  assert.deepEqual(amendment.amendedPaths, [
    'protocols/lv01-study-design.v2.json',
    'protocols/lv01-analysis-plan.v2.json',
    'protocols/lv01-seed-resource-policy.v2.json',
    'protocols/lv01-prototype-execution-profile.v2.json',
    'protocols/lv01-direction-amendment.v2.json',
  ]);
  assert.match(amendment.amendmentScope, /Only the five v2 files/u);
  assert.equal(amendment.preservedV1.length, 3);
  for (const entry of amendment.preservedV1) {
    assert.equal(sha256(entry.path), entry.sha256, `${entry.path}: v1 bytes changed`);
  }
  assert.equal(amendment.nineteenCardFamily.path, 'protocols/research-protocol-cards.v1.json');
  assert.equal(sha256(amendment.nineteenCardFamily.path), amendment.nineteenCardFamily.sha256, 'portfolio bytes changed');
  assert.equal(amendment.nineteenCardFamily.cardCount, 19);
  assert.equal(cards.cards.length, 19);
  assert.match(amendment.directionStatements.behavioralCohortDidNot, /did not run/u);
  assert.match(
    raw('protocols/lv01-direction-amendment.v2.json'),
    /^(?!.*(TBD|TODO|FIXME|placeholder|lorem))/ius,
    'v2 design files must not contain placeholders',
  );
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
  assert.equal(profile.runtime.deploymentMode, 'prototype');
  assert.equal(profile.runtime.topology, 'prototype-disposable-worker');
  assert.deepEqual(profile.runtime.separation, [
    'separate agent state',
    'separate weights',
    'separate optimizers',
    'separate memories',
    'separate PRNG domains',
    'separate ledger handles',
  ]);
  // Role-table correction (R03-B F1): the blanket ban below binds receiver
  // rows; the sender's private referent cue is granted per-role in
  // runtime.roleInputs and study-design observationSchemas. The pins, the
  // protocol bytes, and the manuscript digests change together; do not edit
  // one without the others.
  assert.deepEqual(profile.runtime.forbiddenInputs, [
    'peer references',
    'peer weights or hidden state',
    'true scenario target',
    'scenario seed',
    'action draw or action PRNG values',
    'wall clock',
    'auditor results',
    'test labels',
    'test outcomes',
  ]);
  assert.ok(profile.runtime.roleInputs.sender.allowed.includes('private referent cue (own target flag)'));
  assert.equal(profile.runtime.roleInputs.sender.forbidden.includes('true scenario target'), false);
  assert.deepEqual(profile.runtime.roleInputs.receiver.forbidden, profile.runtime.forbiddenInputs);
  assert.ok(design.observationSchemas.senderAllowed.includes('private referent cue (own target flag)'));
  assert.match(design.observationSchemas.roleReading, /receiver rows/);
  assert.ok(profile.retention.snapshots.includes('every 64 training episodes'));
  assert.ok(profile.preActionCommitment.payload.includes('full probability vectors for native, ordinary-record and replay predictors'));
  assert.match(profile.preActionCommitment.persistence, /Hashing the inputs alone is insufficient/u);
  assert.match(profile.actionDraw.verification, /Never substitute a hash of roles/u);
  assert.deepEqual(profile.conditions.branches, design.evaluation.branches);
  assert.match(profile.conditions.interventionBoundary, /Identical-token coincidences are preserved/u);
  assert.deepEqual(profile.batchEvaluation.forbidden, [
    'copying the full parent evidence per test action',
    'booting a service topology per test action',
    'omitting restoration or chronology evidence',
  ]);
  assert.deepEqual(profile.audit.forbidden, [
    'reusing collector-created true flags as the auditor\'s evidence',
    'collector-supplied pass flags for chronology, restoration or sampling',
  ]);
  assert.match(profile.records.releaseSchedule, /^none/u);
  assert.deepEqual(Object.keys(policy.stages).sort(), ['confirmatory', 'development', 'pilot', 'qualification', 'replication']);
  // Seed-label correction (R03-B vocabulary): derivation stage labels match
  // the stage blocks and Lv01StageSchema (confirmatory/replication). The
  // pin, the protocol bytes, and the manuscript digests change together.
  assert.deepEqual(policy.derivation.partValues.stages, ['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
  assert.ok(policy.derivation.partValues.purposes.includes('intervention-shuffle'));
  assert.match(policy.derivation.algorithm, /NUL/u);
  // Per-role stream registration (R03-B F2): hex||role separation is the
  // registered form; pins, bytes, and manuscript digests change together.
  assert.match(policy.derivation.roleStreamSeparation, /hex followed by role/);
  assert.match(policy.derivation.roleStreamSeparation, /injective/);
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
console.log(`LV01 design v${version} contracts valid: ${version === '2' ? 'strict five-file design/analysis/policy/profile/amendment' : 'frozen design/analysis/resource policy'}; no registration or execution`);
