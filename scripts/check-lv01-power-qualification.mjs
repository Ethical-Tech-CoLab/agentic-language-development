import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { 'design-version': { type: 'string', default: '1' } },
});
assert.match(values['design-version'], /^[12]$/u, 'design version must be 1 or 2');
const designVersion = values['design-version'];
// A v1 six-component receipt never qualifies a v2 seven-component chain.
const receiptPath = `reports/research/lv01-power-qualification.v${designVersion}.json`;
assert.equal(existsSync(receiptPath), true, `missing numerical qualification receipt ${receiptPath}`);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
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
assert.equal(receipt.qualification.components.length, designVersion === '1' ? 6 : 7);
if (designVersion === '2') assert.equal(receipt.qualification.members, 4);
assert.equal(receipt.qualification.repetitions, 30000);
assert.equal(receipt.qualification.comparisons, designVersion === '1' ? 36 : 42);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', `${receipt.execution.commit}^{tree}`), receipt.execution.tree);
assert.equal(JSON.parse(git('show', `${receipt.execution.commit}:package.json`)).version, receipt.execution.version);
for (const artifact of receipt.sourceArtifacts) {
  const bytes = execFileSync('git', ['show', `${receipt.execution.commit}:${artifact.path}`]);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(sha256, artifact.sha256, `${artifact.path} changed from its qualification source`);
}
console.log(`LV01 power qualification v${designVersion} receipt valid: synthetic numerical reference only`);
