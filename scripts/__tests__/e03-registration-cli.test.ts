import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories: string[] = [];
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function fixture() {
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const directory = mkdtempSync(join(root, 'evidence/test-e03-registration-cli-'));
  directories.push(directory);
  const receiptPath = join(directory, 'synthetic-e02-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({
    experimentId: 'E02', passed: true, researchFinding: false, externalSpend: 0,
    publicChainTransaction: false, registrationHash: `sha256:${'a'.repeat(64)}`,
  }));
  const topologyPath = join(directory, 'synthetic-topology-audit.json');
  const topology = {
    schemaVersion: 1, experimentId: 'E03', classification: 'original-prototype-development-audit',
    profile: 'prototype-v2', passed: true, auditExitStatus: 0,
    conditionsAudited: 6, roleContainerCount: 0, nurseryContainerCount: 6,
    sharedProcessCheck: true,
    pairedScenarioCheck: true, typescriptVerifierPassed: true, rustAuditorPassed: true,
    originalSlots: ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle']
      .map((condition, index) => ({
        condition, signedOriginalDataReconciled: true,
        nurseryContainerId: index.toString(16).padStart(12, '0'), nurseryProcessId: 1,
        roleProcessIds: { 'baby-a': 1, 'baby-b': 1 },
      })),
    researchFinding: false, externalSpend: 0, publicChainTransaction: false,
  };
  writeFileSync(topologyPath, JSON.stringify(topology));
  const policyBytes = readFileSync(join(root, 'protocols/seed-and-resource-allocation.v1.json'));
  const allocationPath = join(directory, 'synthetic-pilot-allocation.json');
  writeFileSync(allocationPath, JSON.stringify({
    schemaVersion: 1, experimentId: 'E03', classification: 'prospective-local-stage-allocation',
    stage: 'blinded-pilot', plannedRuns: 120,
    reservedCpuHours: 1, reservedWorkingStorageGiB: 1, maximumResidentGiB: 1,
    priorCpuHoursCharged: 22, priorRetainedStorageGiB: 1,
    externalSpend: 0, measurementSourceSha256: sha256(readFileSync(topologyPath)),
    policySourceSha256: sha256(policyBytes), decision: 'ready',
  }));
  return { directory, receiptPath, topologyPath, allocationPath };
}

function run(receiptPath: string, directory: string, topologyPath: string,
  allocationPath: string, resourcePath?: string) {
  return spawnSync(process.execPath, [
    join(root, 'scripts/build-e03-registration.mjs'), '--stage', 'pilot',
    '--primary-seeds', '20', '--e02-receipt', relative(root, receiptPath),
    '--out', join(directory, 'draft.json'),
    '--topology-audit', relative(root, topologyPath),
    '--stage-resource-allocation', relative(root, allocationPath),
    ...(resourcePath ? ['--resource-allocation', relative(root, resourcePath)] : []),
  ], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('E03 draft CLI resource policy binding', () => {
  it('accepts the actual zero-spend local-ceiling shape for a synthetic pilot fixture', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const result = run(receiptPath, directory, topologyPath, allocationPath);
    expect(result.status, result.stderr).toBe(0);
    const packet = JSON.parse(readFileSync(join(directory, 'draft.json'), 'utf8'));
    expect(packet.artifact.parameters.stage).toBe('blinded-pilot');
    expect(packet.runs).toHaveLength(120);
    expect(packet.runs[0].config.turnResponseBudgetMs).toBe(2_000);
    expect(packet.runs[0].config.maxTurnsPerRun).toBe(1);
    expect(packet.runs[0].config.checkpointEventInterval).toBe(1_024);
    expect(packet.artifact.parameters.executionBinding.prototypeTopology.mode).toBe('prototype');
    expect(packet.artifact.parameters.executionBinding.stageResourceAllocation.plannedRuns).toBe(120);
    expect(packet.claimBoundary).toContain('Draft Prototype-Mode E03 infrastructure qualification only');
  });

  it('rejects a resource policy that permits external spending', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const resourcePath = join(directory, 'invalid-resource-policy.json');
    const resource = JSON.parse(readFileSync(join(root,
      'protocols/seed-and-resource-allocation.v1.json'), 'utf8'));
    resource.localCeiling.externalSpend = 1;
    writeFileSync(resourcePath, JSON.stringify(resource));
    const result = run(receiptPath, directory, topologyPath, allocationPath, resourcePath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('zero-spend resource allocation policy');
  });

  it('rejects an incomplete six-condition topology audit', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
    topology.conditionsAudited = 5;
    writeFileSync(topologyPath, JSON.stringify(topology));
    const result = run(receiptPath, directory, topologyPath, allocationPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('complete original Prototype-Mode topology audit');
  });

  it('rejects paired-scenario claims not derived from signed originals', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
    topology.originalSlots[0].signedOriginalDataReconciled = false;
    writeFileSync(topologyPath, JSON.stringify(topology));
    const result = run(receiptPath, directory, topologyPath, allocationPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('complete original Prototype-Mode topology audit');
  });

  it('rejects reused Nursery identity disguised as six Prototype-Mode slots', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const topology = JSON.parse(readFileSync(topologyPath, 'utf8'));
    topology.originalSlots[1].nurseryContainerId = topology.originalSlots[0].nurseryContainerId;
    writeFileSync(topologyPath, JSON.stringify(topology));
    const result = run(receiptPath, directory, topologyPath, allocationPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('complete original Prototype-Mode topology audit');
  });

  it('rejects an allocation that exceeds the local resource ceiling', () => {
    const { directory, receiptPath, topologyPath, allocationPath } = fixture();
    const allocation = JSON.parse(readFileSync(allocationPath, 'utf8'));
    allocation.reservedCpuHours = 51;
    writeFileSync(allocationPath, JSON.stringify(allocation));
    const result = run(receiptPath, directory, topologyPath, allocationPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('measured prospective stage allocation');
  });
});
