/* eslint-disable @typescript-eslint/no-explicit-any -- malformed status fixtures intentionally cross the JSON boundary */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const source = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const syntheticSha = (value: unknown) => `sha256:${createHash('sha256')
  .update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}`;

function fixture(mutate: (campaign: any, receipts: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-campaign-readiness-'));
  temporaryDirectories.push(directory);
  const campaign = source('protocols/campaign-readiness-review.v1.json');
  const receipts = Object.fromEntries(['e00', 'e01', 'e02', 'e02v3', 'fullAudit'].map((id) => [id, source(
    id === 'e00' ? 'reports/research/e00-integrity-qualification-receipt.json'
      : id === 'e01' ? 'reports/research/e01-isolation-qualification-receipt.json'
        : id === 'e02' ? 'reports/research/e02-v2-qualification-receipt.json'
          : id === 'e02v3' ? 'reports/research/e02-v3-qualification-receipt.json'
            : 'reports/research/e02-v3-full-audit-receipt.json',
  )]));
  mutate(campaign, receipts);
  const values: Record<string, unknown> = {
    'protocols/campaign-readiness-review.v1.json': campaign,
    'protocols/research-protocol-cards.v1.json': source('protocols/research-protocol-cards.v1.json'),
    'protocols/seed-and-resource-allocation.v1.json': source('protocols/seed-and-resource-allocation.v1.json'),
    'docs/experiment-readiness-gates.json': source('docs/experiment-readiness-gates.json'),
    'reports/research/e00-integrity-qualification-receipt.json': receipts.e00,
    'reports/research/e01-isolation-qualification-receipt.json': receipts.e01,
    'reports/research/e02-qualification-receipt.json': source('reports/research/e02-qualification-receipt.json'),
    'reports/research/e02-v2-qualification-receipt.json': receipts.e02,
    'reports/research/e02-v1-failure-evidence.json': source('reports/research/e02-v1-failure-evidence.json'),
    'reports/research/e02-v2-failure-evidence.json': source('reports/research/e02-v2-failure-evidence.json'),
    'protocols/e02-registration.v2.json': source('protocols/e02-registration.v2.json'),
    'protocols/e02-registration-binding.v2.json': source('protocols/e02-registration-binding.v2.json'),
    'protocols/e02-registration.v3.json': source('protocols/e02-registration.v3.json'),
    'protocols/e02-registration-binding.v3.json': source('protocols/e02-registration-binding.v3.json'),
    'reports/research/e02-v3-execution-gate-receipt.json': source('reports/research/e02-v3-execution-gate-receipt.json'),
    'reports/research/e02-v3-execution-start.json': source('reports/research/e02-v3-execution-start.json'),
    'reports/research/e02-v3-qualification-receipt.json': receipts.e02v3,
    'reports/research/e02-v3-full-audit-receipt.json': receipts.fullAudit,
  };
  if (receipts.e03) values['reports/research/e03-pilot-v1-status-receipt.json'] = receipts.e03;
  if (receipts.e03Packet) values['protocols/e03-pilot-registration.v1.json'] = receipts.e03Packet;
  if (receipts.e03Binding) values['protocols/e03-pilot-registration-binding.v1.json'] = receipts.e03Binding;
  if (receipts.e03Topology) values['reports/research/e03-prototype-topology-audit-receipt.json'] = receipts.e03Topology;
  if (receipts.e03Allocation) values['protocols/e03-pilot-resource-allocation.v1.json'] = receipts.e03Allocation;
  for (const [path, value] of Object.entries(values)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    join(root, 'scripts/check-campaign-readiness.ts'),
  ], { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('stage-specific campaign progress', () => {
  it('accepts the current evidence-backed progress record', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects an apparently complete pilot without prospective registration', () => {
    const result = run(fixture((campaign, receipts) => {
      const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
      e03.executionReadiness = { stage: 'pilot', decision: 'complete', reasonCodes: [] };
      e03.attempt = { version: 'v1', status: 'completed', planned: 120, attempted: 120, completed: 120 };
      e03.evidence = [{ kind: 'terminal-receipt', path: 'reports/research/e03-pilot-v1-status-receipt.json', statusAuthority: true }];
      receipts.e03 = { experimentId: 'E03', passed: true, failure: null,
        plannedSlots: 120, attemptedSlots: 120, completedSlots: 120,
        slots: Array.from({ length: 120 }, (_, index) => ({ slot: index + 1 })) };
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot progression lacks packet');
  });

  it('can mark the pilot stage ready while broader research blockers remain open', () => {
    const directory = fixture((campaign, receipts) => {
      const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
      e03.executionReadiness = { stage: 'pilot', decision: 'ready', reasonCodes: [] };
      e03.evidence = [
        { kind: 'prospective-registration-packet', path: 'protocols/e03-pilot-registration.v1.json', statusAuthority: false },
        { kind: 'simulated-registration-binding', path: 'protocols/e03-pilot-registration-binding.v1.json', statusAuthority: false },
        { kind: 'development-topology-audit', path: 'reports/research/e03-prototype-topology-audit-receipt.json', statusAuthority: false },
        { kind: 'prospective-stage-allocation', path: 'protocols/e03-pilot-resource-allocation.v1.json', statusAuthority: false },
      ];
      receipts.e03Topology = {
        experimentId: 'E03', profile: 'prototype-v2', classification: 'original-prototype-development-audit',
        conditionsAudited: 6, roleContainerCount: 12, auditExitStatus: 0,
        passed: true, researchFinding: false,
      };
      receipts.e03Allocation = {
        experimentId: 'E03', stage: 'blinded-pilot',
        classification: 'prospective-local-stage-allocation', decision: 'ready',
        plannedRuns: 120, reserveSlots: 0, externalSpend: 0,
        measurementSourceSha256: syntheticSha(receipts.e03Topology),
        policySourceSha256: syntheticSha(source('protocols/seed-and-resource-allocation.v1.json')),
        priorCpuHoursCharged: 22, reservedCpuHours: 1,
        priorRetainedStorageGiB: 1, reservedWorkingStorageGiB: 1,
      };
      receipts.e03Packet = {
        preRegistrationHash: `sha256:${'a'.repeat(64)}`,
        artifact: { parameters: {
          stage: 'blinded-pilot', seedManifest: { entries: Array(20).fill({}), reserveSeeds: 0 },
          executionBinding: {
            prototypeTopology: { sha256: syntheticSha(receipts.e03Topology) },
            stageResourceAllocation: { sha256: syntheticSha(receipts.e03Allocation) },
          },
        } },
        runs: Array(120).fill({}),
      };
      receipts.e03Binding = {
        preRegistrationHash: receipts.e03Packet.preRegistrationHash,
        repositoryRegistration: { path: 'protocols/e03-pilot-registration.v1.json' },
        preRunAnchor: { anchorClass: 'simulated', status: 'confirmed' },
      };
    });
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 ready');
    const allocationPath = join(directory, 'protocols/e03-pilot-resource-allocation.v1.json');
    const allocation = JSON.parse(readFileSync(allocationPath, 'utf8'));
    allocation.reservedCpuHours = 51;
    writeFileSync(allocationPath, `${JSON.stringify(allocation, null, 2)}\n`);
    const contradicted = run(directory);
    expect(contradicted.status).not.toBe(0);
    expect(contradicted.stderr).toContain('E03 pilot progression contradicts');
  });

  it('rejects closing B16 without completed E02 qualification', () => {
    const result = run(fixture((campaign) => {
      const e02 = campaign.experiments.find((entry: any) => entry.id === 'E02');
      e02.executionReadiness = { stage: 'qualification', decision: 'blocked', reasonCodes: ['E02-topology'] };
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('B16 disposition contradicts the terminal E02 qualification gate');
  });

  it.each([
    ['wrong terminal hash', (receipts: any) => { receipts.fullAudit.terminalReceiptSha256 = 'sha256:wrong'; }],
    ['missing probe recomputation', (receipts: any) => { receipts.fullAudit.probeReportsRecomputed = 59; }],
  ])('rejects B16 closure with %s', (_label, mutate) => {
    const result = run(fixture((_campaign, receipts) => mutate(receipts)));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('B16 closure contradicts the complete audited E02 software qualification');
  });

  it('rejects a missing terminal disposition instead of inferring a running attempt', () => {
    const result = run(fixture((campaign, receipts) => {
      const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
      e03.executionReadiness = { stage: 'pilot', decision: 'blocked', reasonCodes: ['B11'] };
      e03.attempt = { version: 'v1', status: 'failed', planned: 120, attempted: 1, completed: 0 };
      e03.evidence = [{ kind: 'terminal-receipt', path: 'reports/research/e03-pilot-v1-status-receipt.json', statusAuthority: true }];
      receipts.e03 = { experimentId: 'E03', passed: false, failure: null, slots: [] };
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 progress contradicts its status-authority receipt');
  });

  it('rejects a stale running account when the registered terminal receipt exists', () => {
    const result = run(fixture((campaign) => {
      const e02 = campaign.experiments.find((entry: any) => entry.id === 'E02');
      e02.executionReadiness = { stage: 'qualification', decision: 'ready', reasonCodes: [] };
      e02.attempt = { version: 'v3', status: 'running', planned: 5, attempted: 1, completed: 0 };
      e02.evidence.find((entry: any) => entry.path === 'reports/research/e02-v3-execution-start.json').statusAuthority = true;
      e02.evidence.find((entry: any) => entry.path === 'reports/research/e02-v3-qualification-receipt.json').statusAuthority = false;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 terminal receipt exists but is not the status authority');
  });

  it('rejects a terminal receipt bound to another registration', () => {
    const result = run(fixture((_campaign, receipts) => {
      receipts.e02v3.registrationHash = 'sha256:wrong';
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 terminal receipt contradicts its prospective registration');
  });

  it('rejects attempted/completed counts that disagree with the receipt', () => {
    const result = run(fixture((campaign) => {
      const e01 = campaign.experiments.find((entry: any) => entry.id === 'E01');
      e01.attempt.completed = 4;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E01 progress contradicts its status-authority receipt');
  });
});
