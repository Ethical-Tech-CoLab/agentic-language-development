import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--live-evidence'));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = read('reports/research/e02-resource-envelope.json');
assert.equal(report.schemaVersion, 1);
assert.equal(report.classification, 'development-resource-envelope');
assert.equal(report.researchFinding, false);
assert.equal(report.smokePassed, true);
assert.equal(report.externalSpend, 0);
assert.equal(report.rowsPerRolePerStage, 2016);
assert.equal(report.maximumParallelSlots, 1);
const smoke = report.modeRSmoke, prototype = report.prototypeFull;
assert.equal(smoke.turns, 10);
assert.equal(smoke.observations, 20);
assert.equal(smoke.leakageProbes, 0);
for (const input of [smoke, prototype]) {
  assert.match(input.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isFinite(input.wallMilliseconds) && input.wallMilliseconds > 0);
  assert.ok(Number.isSafeInteger(input.completeDirectoryBytes) && input.completeDirectoryBytes > 0);
}
const projectedHours = (smoke.wallMilliseconds * 4034 / 10 + 2 * prototype.wallMilliseconds * 2016 / 816) / 3600000;
assert.equal(Math.round(projectedHours), report.projection.expectedApproximateWallHoursPerSlot);
assert.ok(projectedHours < report.projection.plannedMaximumWallHoursPerSlot);
assert.equal(report.projection.primaryProcessCpuReservationHours, 5 * 3 + 5);
assert.equal(sha256(report.enforcedContainerLimits.composePath), report.enforcedContainerLimits.composeSha256);
if (process.argv[2] === '--live-evidence') {
  const bytes = (path) => {
    const entry = lstatSync(path);
    assert.equal(entry.isSymbolicLink(), false);
    return entry.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0) : entry.size;
  };
  for (const input of [smoke, prototype]) {
    assert.equal(sha256(input.path), input.sha256);
    assert.equal(bytes(dirname(input.path)), input.completeDirectoryBytes);
    const original = read(input.path);
    assert.equal(original.classification, 'development-only');
    assert.equal(original.passed, true);
    assert.equal(original.failure, null);
    assert.equal(original.wallMilliseconds, input.wallMilliseconds);
    assert.equal(original.captured.length, 2 * input.turns);
  }
  const original = read(smoke.path);
  assert.equal(original.mode, 'research-grade');
  assert.equal(original.profile, 'smoke');
  assert.equal(original.reports.length, 0);
  assert.equal(original.containerResourceUsage.peakBytes, smoke.nurseryCgroupPeakBytes);
  assert.equal(original.containerResourceUsage.cpuUsageMicroseconds, smoke.nurseryCgroupCpuUsageMicroseconds);
  assert.equal(original.resourceUsage.maxRSS, smoke.nodeProcessMaxRssKiB);
}
console.log(`E02 resource envelope reconciles; projected ${projectedHours.toFixed(3)} hours/slot, not a measured registered result`);
