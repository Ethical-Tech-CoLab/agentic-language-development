import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const packet = JSON.parse(readFileSync('protocols/lv01-development-resource-allocation.v1.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const seed = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

assert.equal(packet.schemaVersion, 1);
assert.equal(packet.studyId, 'LV01');
assert.equal(packet.classification, 'prospective-development-only-allocation');
assert.equal(packet.status, 'design-locked-not-executed');
assert.equal(packet.researchFinding, false);
assert.equal(packet.scientificDisposition, 'not-tested');
assert.equal(packet.externalSpend, 0);
assert.equal(packet.publicChainTransaction, false);
assert.equal(git('rev-parse', `${packet.sourceFreeze.commit}^{tree}`), packet.sourceFreeze.tree);
assert.equal(JSON.parse(git('show', `${packet.sourceFreeze.commit}:package.json`)).version, packet.sourceFreeze.version);
for (const artifact of packet.sourceFreeze.artifacts) {
  const bytes = execFileSync('git', ['show', `${packet.sourceFreeze.commit}:${artifact.path}`]);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.sha256);
}
assert.equal(packet.allocation.maximumParallelDyads, 1);
assert.deepEqual(packet.allocation.smallFixture, {
  runId: 'lv01-development-v1-p0001', iteration: 1, trainingCases: 64,
  validationFitCases: 24, validationSelectionCases: 24, withinSupportTestCases: 24,
  cpuHoursCap: 0.25, additionalStorageGiBCap: 1, maximumResidentGiB: 6,
});
assert.deepEqual(packet.allocation.fullCalibration.runIds, [
  'lv01-development-v1-p0002', 'lv01-development-v1-p0003', 'lv01-development-v1-p0004',
  'lv01-development-v1-p0005', 'lv01-development-v1-p0006',
]);
for (const slot of packet.seedDerivation.slots) {
  const prefix = ['ald-ledger-value-v1', 'LV01', 'development', 'v1', 'primary', slot.index];
  assert.equal(slot.scenario, seed(...prefix, 'scenario'));
  assert.equal(slot.babyA, seed(...prefix, 'learner/baby-a'));
  assert.equal(slot.babyB, seed(...prefix, 'learner/baby-b'));
  assert.equal(slot.gateway, seed(...prefix, 'gateway'));
  assert.equal(slot.analysis, seed(...prefix, 'analysis'));
}
console.log('LV01 development allocation valid: six fresh zero-spend identities; no execution or research result');
