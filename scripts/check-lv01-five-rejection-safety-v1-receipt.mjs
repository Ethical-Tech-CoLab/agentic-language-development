import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { exitIfQuarantined } from './quarantine.mjs';

const report = JSON.parse(readFileSync('reports/research/lv01-five-rejection-safety-v1-receipt.json', 'utf8'));
exitIfQuarantined('lv01-five-rejection-safety-v1',
  existsSync(report.rawReceiptPath) && existsSync(report.rawResultPath));
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const raw = JSON.parse(readFileSync(report.rawReceiptPath, 'utf8'));
const result = JSON.parse(readFileSync(report.rawResultPath, 'utf8'));
assert.equal(report.status, 'completed-bounded-development-observation');
assert.equal(report.researchFinding, false);
assert.equal(hash(report.rawReceiptPath), report.rawReceiptSha256);
assert.equal(hash(report.rawResultPath), report.rawResultSha256);
assert.equal(raw.passed, true);
assert.equal(raw.failure, null);
assert.equal(raw.remainingContainers, 0);
assert.equal(result.state, 'paused');
assert.equal(result.turnCount, 5);
assert.equal(result.channelCount, 5);
assert.deepEqual(result.rejectionReasonCodes, Array(5).fill('trusted-metadata-present'));
assert.equal(result.safetyTriggerCount, 1);
assert.equal(result.safetyTrigger.consecutiveRejections, 5);
assert.equal(result.safetyTrigger.turn, 4);
console.log('LV01 five-rejection safety v1 receipt verified against retained local evidence');
