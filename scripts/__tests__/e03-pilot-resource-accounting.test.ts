import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileE03PilotAttemptResources } from '../e03-pilot-resource-accounting.mjs';

const directories: string[] = [];
const host = { userCPUTime: 500_000, systemCPUTime: 500_000 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ald-e03-pilot-resources-'));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('failed E03 pilot resource charges', () => {
  it('charges a failed attempted slot when its shared Nursery cgroup was retained', () => {
    const root = fixture();
    const runId = 'e03-pilot-disabled-s001';
    mkdirSync(join(root, runId));
    writeFileSync(join(root, runId, 'slot.json'), JSON.stringify({
      nurseryResourceUsage: { cpuUsageMicroseconds: 2_000_000 },
    }));
    const result = reconcileE03PilotAttemptResources(root, [runId], [], host);
    expect(result.completeMeasurement).toBe(true);
    expect(result.measuredCpuHoursLowerBound).toBeCloseTo(3_000_000 / 3_600_000_000);
    expect(result.attempted[0]?.verified).toBe(false);
  });

  it('makes remaining capacity unresolved when failed Nursery usage is absent', () => {
    const root = fixture();
    const runId = 'e03-pilot-disabled-s001';
    const result = reconcileE03PilotAttemptResources(root, [runId], [], host);
    expect(result.completeMeasurement).toBe(false);
    expect(result.missingComponents).toEqual([`${runId}:nursery`]);
    expect(result.measuredCpuHoursLowerBound).toBeGreaterThan(0);
  });

  it('does not double-charge an audited valid slot', () => {
    const root = fixture();
    const runId = 'e03-pilot-disabled-s001';
    const result = reconcileE03PilotAttemptResources(root, [runId], [{
      runId, nurseryResourceUsage: { cpuUsageMicroseconds: 2_000_000 },
    }], host);
    expect(result.completeMeasurement).toBe(true);
    expect(result.measuredCpuHoursLowerBound).toBeCloseTo(3_000_000 / 3_600_000_000);
    expect(result.attempted[0]?.verified).toBe(true);
  });

  it('retains a malformed failed resource record as unresolved accounting', () => {
    const root = fixture();
    const runId = 'e03-pilot-disabled-s001';
    mkdirSync(join(root, runId));
    writeFileSync(join(root, runId, 'slot.json'), '{incomplete');
    const result = reconcileE03PilotAttemptResources(root, [runId], [], host);
    expect(result.completeMeasurement).toBe(false);
    expect(result.unreadableRecords[0]?.path).toContain('slot.json');
    expect(result.missingComponents).toContain(`${runId}:nursery`);
  });
});
