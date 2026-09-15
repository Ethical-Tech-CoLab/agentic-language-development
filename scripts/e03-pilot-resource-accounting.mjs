import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roles = ['baby-a', 'baby-b'];

export function reconcileE03PilotAttemptResources(root, attemptedRunIds, validSlots, hostUsage) {
  assert.equal(new Set(attemptedRunIds).size, attemptedRunIds.length);
  const verified = new Map(validSlots.map((slot) => [slot.runId, slot]));
  assert.equal(verified.size, validSlots.length);
  assert.ok(validSlots.every((slot) => attemptedRunIds.includes(slot.runId)));
  let cpuUsageMicroseconds = hostUsage.userCPUTime + hostUsage.systemCPUTime;
  const missingComponents = [];
  const unreadableRecords = [];
  const readIfPresent = (path) => {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      unreadableRecords.push({ path, diagnostic: `${error.name}: ${error.message}` });
      return null;
    }
  };
  const attempted = attemptedRunIds.map((runId) => {
    const slot = verified.get(runId);
    const operationalPath = join(root, runId, 'slot.json');
    const learnerPath = join(root, runId, 'learner-resources.json');
    const nursery = slot?.nurseryResourceUsage ?? readIfPresent(operationalPath)?.nurseryResourceUsage;
    const learner = slot?.learnerContainerResourceUsage ?? readIfPresent(learnerPath)?.resources;
    const measured = {};
    for (const [component, source] of [['nursery', nursery],
      ...roles.map((role) => [role, learner?.[role]])]) {
      const usec = source?.cpuUsageMicroseconds;
      if (Number.isSafeInteger(usec) && usec > 0) {
        cpuUsageMicroseconds += usec;
        measured[component] = usec;
      } else {
        missingComponents.push(`${runId}:${component}`);
      }
    }
    return { runId, verified: slot !== undefined, measuredCpuUsageMicroseconds: measured };
  });
  return {
    attempted, missingComponents, unreadableRecords,
    completeMeasurement: missingComponents.length === 0,
    measuredCpuHoursLowerBound: cpuUsageMicroseconds / 3_600_000_000,
  };
}
