/* eslint-disable @typescript-eslint/no-explicit-any -- malformed status fixtures intentionally cross the JSON boundary */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const controllers: ChildProcess[] = [];
const source = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const syntheticSha = (value: unknown) => `sha256:${createHash('sha256')
  .update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}`;

function fixture(mutate: (campaign: any, receipts: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-campaign-readiness-'));
  temporaryDirectories.push(directory);
  const campaign = source('protocols/campaign-readiness-review.v1.json');
  const receipts = Object.fromEntries(['e00', 'e01', 'e02', 'e02v3', 'fullAudit', 'e03CurrentTopology', 'e03CurrentAllocation'].map((id) => [id, source(
    id === 'e00' ? 'reports/research/e00-integrity-qualification-receipt.json'
      : id === 'e01' ? 'reports/research/e01-isolation-qualification-receipt.json'
        : id === 'e02' ? 'reports/research/e02-v2-qualification-receipt.json'
          : id === 'e02v3' ? 'reports/research/e02-v3-qualification-receipt.json'
            : id === 'fullAudit' ? 'reports/research/e02-v3-full-audit-receipt.json'
              : id === 'e03CurrentTopology' ? 'reports/research/e03-prototype-topology-audit-receipt.json'
                : 'protocols/e03-pilot-resource-allocation.v1.json',
  )]));
  mutate(campaign, receipts);
  const e03Evidence = campaign.experiments.find((entry: any) => entry.id === 'E03')?.evidence;
  const packetPath = e03Evidence?.find((entry: any) =>
    entry.kind === 'prospective-registration-packet')?.path ?? 'protocols/e03-pilot-registration.v1.json';
  const bindingPath = e03Evidence?.find((entry: any) =>
    entry.kind === 'simulated-registration-binding')?.path ??
    'protocols/e03-pilot-registration-binding.v1.json';
  if (e03Evidence?.some((entry: any) => entry.kind === 'prospective-registration-packet') &&
      !receipts.e03Packet) {
    receipts.e03Packet = source(packetPath);
  }
  if (e03Evidence?.some((entry: any) => entry.kind === 'simulated-registration-binding') &&
      !receipts.e03Binding) {
    receipts.e03Binding = source(bindingPath);
  }
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
    'reports/research/e03-prototype-topology-audit-receipt.json': receipts.e03CurrentTopology,
    'protocols/e03-pilot-resource-allocation.v1.json': receipts.e03CurrentAllocation,
  };
  if (receipts.e03) values['reports/research/e03-pilot-v1-status-receipt.json'] = receipts.e03;
  if (receipts.e03Packet) values[packetPath] = receipts.e03Packet;
  if (receipts.e03Binding) values[bindingPath] = receipts.e03Binding;
  if (receipts.e03Topology) values['reports/research/e03-prototype-topology-audit-receipt.json'] = receipts.e03Topology;
  if (receipts.e03Allocation) values['protocols/e03-pilot-resource-allocation.v1.json'] = receipts.e03Allocation;
  if (receipts.e03Terminal) values['evidence/pilots/e03-blinded-v1/receipt.json'] = receipts.e03Terminal;
  const currentTerminal = e03Evidence?.find((entry: any) =>
    entry.kind === 'terminal-receipt' && entry.statusAuthority)?.path;
  if (currentTerminal?.startsWith('evidence/pilots/') && !receipts.e03Terminal) {
    values[currentTerminal] = source(currentTerminal);
  }
  const currentReduction = e03Evidence?.find((entry: any) =>
    entry.kind === 'outcome-blind-sample-size-input')?.path;
  if (currentReduction) values[currentReduction] = source(currentReduction);
  const portableSummary = e03Evidence?.find((entry: any) =>
    entry.kind === 'portable-terminal-summary')?.path;
  if (portableSummary) values[portableSummary] = source(portableSummary);
  if (portableSummary) values['evidence/pilots/e03-blinded-v3/power-selection.json'] =
    source('evidence/pilots/e03-blinded-v3/power-selection.json');
  for (const [path, value] of Object.entries(values)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path === 'protocols/seed-and-resource-allocation.v1.json' ||
      path.startsWith('evidence/pilots/e03-blinded-v3/')
      ? readFileSync(join(root, path)) : `${JSON.stringify(value, null, 2)}\n`);
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    join(root, 'scripts/check-campaign-readiness.ts'),
  ], { cwd: directory, encoding: 'utf8' });
}

function resetPilotPreparation(campaign: any) {
  const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
  e03.executionReadiness = { stage: 'pilot', decision: 'blocked', reasonCodes: ['B11'] };
  e03.attempt = { status: 'not-started', planned: null, attempted: 0, completed: 0 };
  e03.evidence = e03.evidence.filter((entry: any) =>
    ['development-topology-audit', 'prospective-stage-allocation'].includes(entry.kind));
  return e03;
}

function preparationFixture(mutate: (campaign: any, receipts: Record<string, any>) => void =
  () => undefined) {
  return fixture((campaign, receipts) => {
    resetPilotPreparation(campaign);
    mutate(campaign, receipts);
  });
}

function readyPilotFixture(version: 'v1' | 'v2' | 'v3' = 'v1') {
  return fixture((campaign, receipts) => {
    const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
    e03.executionReadiness = { stage: 'pilot', decision: 'ready', reasonCodes: [] };
    e03.attempt = { version, status: 'not-started', planned: 120, attempted: 0, completed: 0 };
    e03.evidence = [
      { kind: 'prospective-registration-packet', path: `protocols/e03-pilot-registration.${version}.json`, statusAuthority: false },
      { kind: 'simulated-registration-binding', path: `protocols/e03-pilot-registration-binding.${version}.json`, statusAuthority: false },
      { kind: 'development-topology-audit', path: 'reports/research/e03-prototype-topology-audit-receipt.json', statusAuthority: false },
      { kind: 'prospective-stage-allocation', path: 'protocols/e03-pilot-resource-allocation.v1.json', statusAuthority: false },
    ];
    receipts.e03Topology = {
      experimentId: 'E03', profile: 'prototype-v2', classification: 'original-prototype-development-audit',
      conditionsAudited: 6, roleContainerCount: 0, nurseryContainerCount: 6,
      sharedProcessCheck: true, auditExitStatus: 0,
      pairedScenarioCheck: true, typescriptVerifierPassed: true, rustAuditorPassed: true,
      originalSlots: Array.from({ length: 6 }, (_, index) => ({
        signedOriginalDataReconciled: true,
        nurseryContainerId: index.toString(16).padStart(12, '0'), nurseryProcessId: 1,
        roleProcessIds: { 'baby-a': 1, 'baby-b': 1 },
      })),
      passed: true, researchFinding: false,
    };
    receipts.e03Allocation = {
      experimentId: 'E03', stage: 'blinded-pilot',
      classification: 'prospective-local-stage-allocation', decision: 'ready',
      plannedRuns: 120, reserveSlots: 0, externalSpend: 0,
      measurementSourceSha256: syntheticSha(receipts.e03Topology),
      policySourceSha256: `sha256:${createHash('sha256').update(
        readFileSync(join(root, 'protocols/seed-and-resource-allocation.v1.json'))).digest('hex')}`,
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
      repositoryRegistration: { path: `protocols/e03-pilot-registration.${version}.json` },
      preRunAnchor: { anchorClass: 'simulated', status: 'confirmed' },
    };
  });
}

function blockedPilotPacketFixture(mutatePacket: (packet: any) => void = () => undefined,
  version: 'v1' | 'v2' | 'v3' = 'v1') {
  return fixture((campaign, receipts) => {
    const e03 = resetPilotPreparation(campaign);
    e03.evidence.push({ kind: 'prospective-registration-packet',
      path: `protocols/e03-pilot-registration.${version}.json`, statusAuthority: false });
    receipts.e03Packet = {
      preRegistrationHash: `sha256:${'a'.repeat(64)}`,
      artifact: { experimentId: 'E03', protocolGitCommit: 'a'.repeat(40), parameters: {
        stage: 'blinded-pilot', executionBinding: {
          prototypeTopology: { sha256: syntheticSha(receipts.e03CurrentTopology) },
          stageResourceAllocation: { sha256: syntheticSha(receipts.e03CurrentAllocation) },
        },
      } },
      runs: Array(120).fill({}),
    };
    mutatePacket(receipts.e03Packet);
  });
}

function terminalPilotFixture(status: 'completed' | 'failed' = 'completed') {
  const directory = readyPilotFixture();
  const campaignPath = join(directory, 'protocols/campaign-readiness-review.v1.json');
  const campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));
  const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
  const completed = status === 'completed' ? 120 : 2;
  const attempted = status === 'completed' ? 120 : 3;
  e03.executionReadiness = status === 'completed'
    ? { stage: 'pilot', decision: 'complete', reasonCodes: [] }
    : { stage: 'pilot', decision: 'blocked', reasonCodes: ['B11'] };
  e03.attempt = { version: 'v1', status, planned: 120, attempted, completed };
  e03.evidence.push({ kind: 'terminal-receipt',
    path: 'evidence/pilots/e03-blinded-v1/receipt.json', statusAuthority: true });
  writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
  const packetPath = join(directory, 'protocols/e03-pilot-registration.v1.json');
  const registration = JSON.parse(readFileSync(packetPath, 'utf8'));
  const terminal = {
    experimentId: 'E03', stage: 'blinded-pilot',
    registrationHash: registration.preRegistrationHash,
    packetSha256: `sha256:${createHash('sha256').update(readFileSync(packetPath)).digest('hex')}`,
    plannedRuns: 120, attemptedRuns: attempted, completedRuns: completed,
    slots: Array.from({ length: completed }, (_, index) => ({ runId: `fixture-${index + 1}` })),
    passed: status === 'completed', failure: status === 'completed' ? null : 'fixture infrastructure failure',
    researchFinding: false, scientificDisposition: 'not-tested',
    externalSpend: 0, publicChainTransaction: false,
  };
  const terminalPath = join(directory, 'evidence/pilots/e03-blinded-v1/receipt.json');
  mkdirSync(dirname(terminalPath), { recursive: true });
  writeFileSync(terminalPath, `${JSON.stringify(terminal, null, 2)}\n`);
  return { directory, terminalPath, campaignPath };
}

function runningPilotFixture() {
  const directory = readyPilotFixture();
  const controller = spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', 'run-e03-registered-pilot.mjs'],
    { stdio: 'ignore' });
  controllers.push(controller);
  expect(controller.pid).toBeTypeOf('number');
  const pid = controller.pid!;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];
  const campaignPath = join(directory, 'protocols/campaign-readiness-review.v1.json');
  const campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));
  const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
  e03.attempt = { version: 'v1', status: 'running', planned: 120, attempted: 0, completed: 0 };
  e03.evidence.push({ kind: 'execution-start',
    path: 'evidence/pilots/e03-blinded-v1/attempt.json', statusAuthority: true });
  writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
  const packetPath = join(directory, 'protocols/e03-pilot-registration.v1.json');
  const registration = JSON.parse(readFileSync(packetPath, 'utf8'));
  const attempt = {
    experimentId: 'E03', stage: 'blinded-pilot',
    classification: 'registered-original-pilot-attempt', attemptStatus: 'running',
    plannedSlots: 120, attemptedSlots: 0, completedSlots: 0, plannedRuns: 120,
    controllerPid: pid, controllerStartTicks: ticks,
    registrationHash: registration.preRegistrationHash,
    packetSha256: `sha256:${createHash('sha256').update(readFileSync(packetPath)).digest('hex')}`,
    researchFinding: false, scientificDisposition: 'not-tested',
    externalSpend: 0, publicChainTransaction: false,
  };
  const attemptPath = join(directory, 'evidence/pilots/e03-blinded-v1/attempt.json');
  mkdirSync(dirname(attemptPath), { recursive: true });
  writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
  return { directory, attemptPath, campaignPath, controller };
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    if (controller.exitCode === null && controller.signalCode === null) {
      controller.kill('SIGTERM');
      await new Promise((resolveExit) => controller.once('exit', resolveExit));
    }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('stage-specific campaign progress', () => {
  it('accepts the current evidence-backed progress record', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts the portable E03 status from a clean checkout without claiming a raw audit', () => {
    const directory = fixture();
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/receipt.json'));
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/sample-size-input.json'));
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/power-selection.json'));
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('4 completed gates');
  });

  it('rejects retained E03 raw evidence whose bytes disagree with the portable digest', () => {
    const directory = fixture();
    const path = join(directory, 'evidence/pilots/e03-blinded-v3/receipt.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 retained original terminal receipt contradicts the portable digest');
  });

  it('rejects altered retained E03 power bytes without changing the reported design row', () => {
    const directory = fixture();
    const path = join(directory, 'evidence/pilots/e03-blinded-v3/power-selection.json');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 retained power calculation contradicts its dated supplement');
  });

  it('rejects a corrupt portable E03 selected row when raw evidence is absent', () => {
    const directory = fixture();
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/receipt.json'));
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/sample-size-input.json'));
    rmSync(join(directory, 'evidence/pilots/e03-blinded-v3/power-selection.json'));
    const path = join(directory, 'reports/research/e03-v3-pilot-status-receipt.json');
    const portable = JSON.parse(readFileSync(path, 'utf8'));
    portable.selectedPrimarySeeds = 0;
    writeFileSync(path, `${JSON.stringify(portable)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 portable pilot status contradicts its packet or campaign state');
  });

  it('rejects a slot-only wall projection after measured host overhead', () => {
    const result = run(preparationFixture((_campaign, receipts) => {
      receipts.e03CurrentAllocation.projectedSequentialWallHours = 0.2;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot preparation contradicts original development receipts');
  });

  it('rejects an allocation without its measured host-overhead bound', () => {
    const result = run(preparationFixture((_campaign, receipts) => {
      delete receipts.e03CurrentAllocation.measuredMaximums.maximumPerSlotHostOverheadHours;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot preparation contradicts original development receipts');
  });

  it('rejects removal of the measured E03 preparation evidence', () => {
    const result = run(preparationFixture((campaign) => {
      const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
      e03.evidence = [];
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot preparation contradicts its retained topology/allocation gate');
  });

  it('accepts a frozen packet as blocked preparation before simulated activation', () => {
    const result = run(blockedPilotPacketFixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts a fresh v2 packet as blocked preparation before its own activation', () => {
    const result = run(blockedPilotPacketFixture(() => undefined, 'v2'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts a fresh v3 packet as blocked preparation before its own activation', () => {
    const result = run(blockedPilotPacketFixture(() => undefined, 'v3'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts the v2 pilot-ready stage with a separate packet and binding', () => {
    const result = run(readyPilotFixture('v2'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts the v3 pilot-ready stage with its own packet and binding', () => {
    const result = run(readyPilotFixture('v3'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a blocked packet with the wrong measured allocation identity', () => {
    const result = run(blockedPilotPacketFixture((packet) => {
      packet.artifact.parameters.executionBinding.stageResourceAllocation.sha256 = `sha256:${'b'.repeat(64)}`;
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 blocked pilot packet contradicts the measured prospective preparation');
  });

  it('rejects an E10+ stage that omits the open selected-topology boundary', () => {
    const result = run(fixture((campaign) => {
      const e10 = campaign.experiments.find((entry: any) => entry.id === 'E10');
      e10.executionReadiness.reasonCodes = e10.executionReadiness.reasonCodes.filter((reason: string) => reason !== 'B12');
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E10 omits the open B12 selected-topology boundary gate');
  });

  it('rejects an unproven reinterpretation of the historical topology blocker', () => {
    const result = run(fixture((campaign) => {
      campaign.topologyBoundarySupplement.priorB12Closure = 'replaced without provenance';
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('B12 topology boundary supplement is missing');
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
    expect(result.stderr).toContain('E03 completed pilot lacks its original authority or tracked portable summary');
  });

  it('can mark the pilot stage ready while broader research blockers remain open', () => {
    const directory = readyPilotFixture();
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

  it('accepts a source-bound running pilot only while its exact controller is live', async () => {
    const { directory, controller } = runningPilotFixture();
    const running = run(directory);
    expect(running.status, running.stderr).toBe(0);
    controller.kill('SIGTERM');
    await new Promise((resolveExit) => controller.once('exit', resolveExit));
    const crashed = run(directory);
    expect(crashed.status).not.toBe(0);
    expect(crashed.stderr).toContain('E03 pilot running attempt has no live controller');
  });

  it('rejects a running pilot with a controller start identity mismatch', () => {
    const { directory, attemptPath } = runningPilotFixture();
    const attempt = JSON.parse(readFileSync(attemptPath, 'utf8'));
    attempt.controllerStartTicks = '0';
    writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot running attempt has no live controller');
  });

  it('rejects a stale ready pilot status after original collection has started', () => {
    const { directory, campaignPath } = runningPilotFixture();
    const campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));
    const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
    e03.attempt = { status: 'not-started', planned: null, attempted: 0, completed: 0 };
    e03.evidence = e03.evidence.filter((item: any) => item.kind !== 'execution-start');
    writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot attempt exists but is not an evidence-backed running state');
  });

  it('accepts a complete pilot as design input without a scientific disposition', () => {
    const { directory } = terminalPilotFixture();
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('4 completed gates');
  });

  it('accepts an unsuccessful pilot with its partial attempt accounting retained', () => {
    const { directory } = terminalPilotFixture('failed');
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a terminal pilot receipt that understates attempted runs', () => {
    const { directory, terminalPath } = terminalPilotFixture();
    const terminal = JSON.parse(readFileSync(terminalPath, 'utf8'));
    terminal.attemptedRuns = 119;
    writeFileSync(terminalPath, `${JSON.stringify(terminal, null, 2)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 accounting contradicts its status-authority receipt');
  });

  it('rejects a terminal pilot receipt bound to another packet', () => {
    const { directory, terminalPath } = terminalPilotFixture();
    const terminal = JSON.parse(readFileSync(terminalPath, 'utf8'));
    terminal.registrationHash = 'sha256:wrong';
    writeFileSync(terminalPath, `${JSON.stringify(terminal, null, 2)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot terminal receipt contradicts its prospective packet');
  });

  it('rejects a stale ready status when the terminal pilot receipt is already present', () => {
    const { directory, campaignPath } = terminalPilotFixture();
    const campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));
    const e03 = campaign.experiments.find((entry: any) => entry.id === 'E03');
    e03.executionReadiness = { stage: 'pilot', decision: 'ready', reasonCodes: [] };
    e03.attempt = { status: 'not-started', planned: null, attempted: 0, completed: 0 };
    e03.evidence = e03.evidence.filter((item: any) => item.kind !== 'terminal-receipt');
    writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E03 pilot terminal receipt exists but is not the status authority');
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
