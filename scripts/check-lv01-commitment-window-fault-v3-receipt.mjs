import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { exitIfQuarantined } from './quarantine.mjs';

const report = JSON.parse(readFileSync('reports/research/lv01-commitment-window-fault-v3-receipt.json', 'utf8'));
exitIfQuarantined('lv01-commitment-window-fault-v3',
  existsSync(report.rawReceiptPath));
const raw = JSON.parse(readFileSync(report.rawReceiptPath, 'utf8'));
const hash = `sha256:${createHash('sha256').update(readFileSync(report.rawReceiptPath)).digest('hex')}`;
assert.equal(report.status, 'completed-bounded-development-observation');
assert.equal(report.researchFinding, false);
assert.equal(report.rawReceiptSha256, hash);
assert.equal(raw.passed, true);
assert.equal(raw.failure, null);
assert.equal(raw.stopped.exitCode, report.observed.faultControllerExitCode);
assert.equal(raw.stopped.oomKilled, false);
assert.equal(raw.recovery.recoveryError.name, 'IncompleteTurnEvidenceError');
assert.equal(raw.recovery.evidenceCounts.turns, 0);
assert.equal(raw.recovery.evidenceCounts.channel, 1);
assert.equal(raw.recovery.evidenceCounts.intervention, 2);
assert.equal(raw.remainingContainers, 0);
console.log('LV01 commitment-window v3 receipt verified against retained local evidence');
