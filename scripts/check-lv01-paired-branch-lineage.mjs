import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLv01PairedCasePlan } from '@ald/orchestrator';

const root = 'evidence/lv01/recurrent-lifecycle-v4/lv01-recurrent-lifecycle-v4-p0001/output/bundle';
const config = JSON.parse(readFileSync(join(root, 'configuration/run-config.json'), 'utf8'));
const checkpointFile = readdirSync(join(root, 'checkpoints'))
  .filter((name) => /^\d{6}\.json$/u.test(name)).sort().at(-1);
assert.ok(checkpointFile, 'retained parent has no checkpoint manifest');
const checkpoint = JSON.parse(readFileSync(join(root, 'checkpoints', checkpointFile), 'utf8'));
assert.equal(config.experimentId, 'LV01');
assert.equal(config.babyA.track, 'scratch-rl');
assert.equal(config.babyB.track, 'scratch-rl');
assert.match(checkpoint.checkpointHash, /^sha256:[0-9a-f]{64}$/u);
for (const policy of ['baby-a-latest.json', 'baby-b-latest.json']) {
  assert.equal(JSON.parse(readFileSync(join(root, 'policies', policy), 'utf8')).architecture,
    'gru-actor-critic-v1');
}
const plan = createLv01PairedCasePlan({
  parent: config,
  parentCheckpointHash: checkpoint.checkpointHash,
  babyAInitialPolicyRef: 'policies/baby-a-latest.json',
  babyBInitialPolicyRef: 'policies/baby-b-latest.json',
  childRunIdPrefix: 'lv01-paired-lineage-check',
});
assert.equal(plan.branches.length, 7);
assert.ok(plan.branches.every((branch) => branch.config.parentRunId === config.runId &&
  branch.config.derivedFromCheckpointHash === checkpoint.checkpointHash));
assert.equal(new Set(plan.branches.map((branch) => branch.config.runId)).size, 7);
console.log(JSON.stringify({ schemaVersion: 1, classification: 'lv01-paired-branch-lineage-read-only-check',
  researchFinding: false, scientificDisposition: 'not-tested', parentRunId: config.runId,
  parentCheckpointHash: checkpoint.checkpointHash, preStateCommitment: plan.preStateCommitment,
  branches: plan.branches.map(({ branch, communicationCondition, predictionTreatment, config: child }) =>
    ({ branch, communicationCondition, predictionTreatment, runId: child.runId, parentRunId: child.parentRunId })),
  claimBoundary: 'This read-only check compiles branch lineage from retained recurrent parent evidence. It does not execute a child branch, predict an action, or establish a behavioral finding.',
}));
