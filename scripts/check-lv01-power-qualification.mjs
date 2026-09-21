import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const receipt = JSON.parse(readFileSync('reports/research/lv01-power-qualification.v1.json', 'utf8'));
assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.classification, 'synthetic-lv01-power-selector-software-qualification');
assert.equal(receipt.passed, true);
assert.equal(receipt.researchFinding, false);
assert.equal(receipt.registeredExecution, false);
assert.equal(receipt.scientificDisposition, 'not-tested');
assert.equal(receipt.syntheticFixturesOnly, true);
assert.equal(receipt.eligiblePilotUsed, false);
assert.equal(receipt.selectedDyads, null);
assert.equal(receipt.reserveDyads, null);
assert.equal(receipt.resourceAuthorization, false);
assert.equal(receipt.externalSpend, 0);
assert.deepEqual(receipt.qualification.candidateDyads, [75, 100, 125, 150, 200, 300]);
assert.equal(receipt.qualification.components.length, 6);
assert.equal(receipt.qualification.repetitions, 30000);
assert.equal(receipt.qualification.comparisons, 36);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', `${receipt.execution.commit}^{tree}`), receipt.execution.tree);
assert.equal(JSON.parse(git('show', `${receipt.execution.commit}:package.json`)).version, receipt.execution.version);
for (const artifact of receipt.sourceArtifacts) {
  const bytes = execFileSync('git', ['show', `${receipt.execution.commit}:${artifact.path}`]);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(sha256, artifact.sha256, `${artifact.path} changed from its qualification source`);
}
console.log('LV01 power qualification receipt valid: synthetic numerical reference only');
