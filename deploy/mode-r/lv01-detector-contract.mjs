import assert from 'node:assert/strict';

import { RECURRENT_ARCHITECTURE } from '@ald/learners';

export const LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE = 2_016;
export const LV01_DETECTOR_STAGES = ['before-restore', 'after-restore'];

export function validateLv01DetectorConfig(config) {
  assert.equal(config.experimentId, 'LV01');
  assert.equal(config.deploymentMode, 'research-grade');
  assert.equal(config.babyA.track, 'scratch-rl');
  assert.equal(config.babyB.track, 'scratch-rl');
  assert.equal(config.babyA.modelRef, RECURRENT_ARCHITECTURE);
  assert.equal(config.babyB.modelRef, RECURRENT_ARCHITECTURE);
  assert.equal(config.maxTurnsPerRun, LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE);
  assert.equal(config.evaluationTurns, 0);
  assert.equal(config.turnResponseBudgetMs, 1_000);
  assert.ok(config.ledgerValuePlan !== undefined);
}

export function validateLv01DetectorObservation(result) {
  assert.equal(result.classification, 'lv01-selected-detector-observation-stage');
  assert.equal(result.researchFinding, false);
  assert.equal(result.learnerArchitecture, RECURRENT_ARCHITECTURE);
  assert.equal(result.failure, undefined);
  assert.equal(result.state, 'sealed');
  assert.equal(result.turnCount, LV01_DETECTOR_ROWS_PER_ROLE_PER_STAGE);
  assert.equal(result.captured.length, result.turnCount * 2);
  assert.ok(result.captured.every((entry) => entry.delivered));
}
