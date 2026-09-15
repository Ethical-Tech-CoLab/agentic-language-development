import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const path = 'protocols/e03-prototype-mode-amendment.v2.json';
const amendment = JSON.parse(readFileSync(path, 'utf8'));
const predecessorBytes = readFileSync(amendment.supersedes.path);
const predecessor = JSON.parse(predecessorBytes.toString('utf8'));
const digest = `sha256:${createHash('sha256').update(predecessorBytes).digest('hex')}`;
const specification = readFileSync('SPECIFICATION.md', 'utf8');
const runtime = readFileSync('packages/orchestrator/src/nursery-runtime.ts', 'utf8');

assert.equal(amendment.schemaVersion, 2);
assert.equal(amendment.experimentId, 'E03');
assert.equal(amendment.classification, 'prospective-infrastructure-topology-correction');
assert.equal(amendment.registrationStage, 'before-blinded-pilot');
assert.equal(amendment.researchFinding, false);
assert.equal(amendment.supersedes.path, 'protocols/e03-prototype-mode-amendment.v1.json');
assert.equal(amendment.supersedes.sha256, digest);
assert.equal(predecessor.decision.deploymentMode, 'prototype');
assert.equal(predecessor.decision.physicalLearnerTransport, 'two-isolated-container-tcp-adapters');
assert.match(specification, /Mode P runs all twins and services as isolated logical DTSF state within a single\s+runtime process/u);
assert.match(runtime, /prototype mode requires in-process learner adapters/u);
assert.equal(amendment.decision.deploymentMode, 'prototype');
assert.equal(amendment.decision.physicalLearnerTransport,
  'two-in-process-no-learning-adapters-one-nursery-process');
assert.equal(amendment.decision.externalLearnerContainersPerSlot, 0);
assert.equal(amendment.decision.nurseryContainersPerSlot, 1);
assert.equal(amendment.decision.turnResponseBudgetMs, 2_000);
assert.equal(amendment.decision.researchGradeIsolationClaim, false);
for (const field of ['conditions', 'pilotSlotsPerCondition', 'pilotReserves',
  'episodesPerSlot', 'checkpointEventInterval', 'chanceEquivalenceBounds',
  'oracleAdequacyAndSeparationRules', 'externalSpend', 'publicChainTransaction']) {
  assert.deepEqual(amendment.unchangedDesign[field], predecessor.unchangedDesign[field],
    `${field} changed outside the topology correction`);
}
assert.match(amendment.status, /no v2 development or pilot seed has been used/u);
assert.match(amendment.claimBoundary, /no research outcome/u);
console.log('Prospective E03 Prototype-Mode topology correction aligned; no v2 or pilot result');
