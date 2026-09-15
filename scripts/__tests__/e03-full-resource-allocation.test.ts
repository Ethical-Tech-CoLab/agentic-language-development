/* eslint-disable @typescript-eslint/no-explicit-any -- malformed allocation fixtures test CLI rejection */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const paths = {
  pilot: 'evidence/pilots/e03-blinded-v3/receipt.json',
  decision: 'protocols/e03-sample-size-decision.v1.json',
  topology: 'reports/research/e03-prototype-topology-audit-receipt.json',
  prior: 'protocols/e03-pilot-resource-allocation.v1.json',
  policy: 'protocols/seed-and-resource-allocation.v1.json',
  campaign: 'protocols/campaign-readiness-review.v1.json',
  out: 'protocols/e03-full-resource-allocation.v1.json',
};

function fixture(mutate: (records: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-full-allocation-'));
  temporaryDirectories.push(directory);
  const write = (path: string, value: unknown) => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    return readFileSync(target);
  };
  const policy = { localCeiling: { cpuHours: 72, workingStorageGiB: 25,
    maximumResidentGiB: 6, externalSpend: 0 } };
  const pilot = {
    experimentId: 'E03', stage: 'blinded-pilot', plannedRuns: 120,
    attemptedRuns: 120, completedRuns: 120, validRuns: 120, invalidRuns: 0,
    abortedRuns: 0, passed: true, failure: null, researchFinding: false,
    scientificDisposition: 'not-tested', externalSpend: 0,
    publicChainTransaction: false, registrationHash: `sha256:${'a'.repeat(64)}`,
    measuredCpuHours: 0.1, wallMilliseconds: 552_000,
    hostResourceUsage: { userCPUTime: 30_000_000, systemCPUTime: 6_000_000,
      maxRSS: 280_000 },
    attemptedResourceAccounting: { completeMeasurement: true, missingComponents: [] },
    slots: Array.from({ length: 120 }, (_, index) => ({
      runId: `run-${index}`, passed: true, originalEvidenceBytes: 3_000_000,
      nurseryResourceUsage: { cpuUsageMicroseconds: 3_000_000,
        peakBytes: 150_000_000 }, wallMilliseconds: 2_000,
    })),
  };
  const pilotBytes = write(paths.pilot, pilot);
  const decision = {
    version: 1, classification: 'outcome-blind-pilot-sample-size-selection',
    pilotReceiptPath: paths.pilot, pilotReceiptSha256: hash(pilotBytes),
    pilotRegistrationHash: pilot.registrationHash, selectedPrimarySeeds: 25,
    monteCarloRepetitions: 30_000, monteCarloLower95: 0.95,
    invalidAsFailureSensitivity: { forcedFailuresPerCondition: 2, successes: 0 },
  };
  const decisionBytes = write(paths.decision, decision);
  const policyBytes = write(paths.policy, policy);
  const prior = { stage: 'blinded-pilot', priorCpuHoursCharged: 22.1,
    externalSpend: 0, policySourceSha256: hash(policyBytes) };
  const campaign = { e03SampleSizeDecisionSupplement: { sha256: hash(decisionBytes) } };
  const topology = { experimentId: 'E03' };
  const records = { policy, pilot, decision, prior, campaign, topology };
  mutate(records);
  for (const key of ['pilot', 'decision', 'policy', 'prior', 'campaign', 'topology'] as const) {
    write(paths[key], records[key]);
  }
  return directory;
}

function run(directory: string, audit = false) {
  return spawnSync(process.execPath,
    [join(root, 'scripts/build-e03-full-resource-allocation.mjs'),
      '--out', paths.out, ...(audit ? ['--audit'] : [])],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('measured full E03 resource allocation', () => {
  it('reserves the exact primary and reserve matrix and reproduces the allocation', () => {
    const directory = fixture();
    const written = run(directory);
    expect(written.status, written.stderr).toBe(0);
    const allocation = JSON.parse(readFileSync(join(directory, paths.out), 'utf8'));
    expect(allocation.plannedRuns).toBe(168);
    expect(allocation.primarySlotsPerCondition).toBe(25);
    expect(allocation.reserveSlotsPerCondition).toBe(3);
    expect(allocation.reservedCpuHours).toBeGreaterThan(0);
    expect(allocation.externalSpend).toBe(0);
    expect(run(directory, true).status).toBe(0);
    expect(run(directory).status).not.toBe(0);
  });

  it('rejects an incomplete pilot CPU measurement', () => {
    const result = run(fixture(({ pilot }) => {
      pilot.attemptedResourceAccounting.completeMeasurement = false;
    }));
    expect(result.status).not.toBe(0);
  });

  it('rejects insufficient authorized CPU capacity', () => {
    const result = run(fixture(({ policy, prior }) => {
      policy.localCeiling.cpuHours = 22.5;
      prior.policySourceSha256 = hash(Buffer.from(`${JSON.stringify(policy, null, 2)}\n`));
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('full E03 CPU reservation exceeds');
  });

  it('rejects a retained-evidence symlink instead of following it', () => {
    const directory = fixture();
    symlinkSync(join(directory, paths.policy), join(directory, 'evidence/foreign-link'));
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('retained evidence may not use symlinks');
  });

  it('rejects changed frozen allocation bytes', () => {
    const directory = fixture();
    expect(run(directory).status).toBe(0);
    const target = join(directory, paths.out);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n`);
    const result = run(directory, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not reproduce from retained pre-run measurements');
  });
});
