import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = 'evidence/lv01/late-callback-v1/lv01-late-callback-v1-p0001';
const report = JSON.parse(readFileSync(
  'reports/research/lv01-late-callback-v1-failed-attempt.json',
  'utf8',
));
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

assert.equal(hash(`${root}/receipt.json`), report.attempt.rawReceiptSha256);
assert.equal(hash(`${root}/compose-logs.txt`), report.attempt.composeLogsSha256);
const raw = JSON.parse(readFileSync(`${root}/receipt.json`, 'utf8'));
assert.equal(raw.passed, false);
assert.equal(raw.result, null);
assert.equal(raw.verification, null);
assert.match(raw.failure, /controller failed/u);
assert.equal(report.attemptStatus, 'failed-before-first-turn');
assert.equal(report.researchFinding, false);
assert.equal(report.scientificDisposition, 'not-tested');
console.log('LV01 v1 late-callback failure is retained and hashes to local evidence');
