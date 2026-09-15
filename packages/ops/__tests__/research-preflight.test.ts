import { describe, expect, it } from 'vitest';

import { compileE03Registration } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS, type PreRegistrationBinding } from '@ald/types';

import {
  evaluateResearchPreflight,
  formatResearchPreflight,
} from '../src/research-preflight.js';

const COMMIT = '1'.repeat(40);
const hashed = (label: string) => hashCanonical(HASH_DOMAINS.scenarioBundle, label);

function registration() {
  const baseConfig = buildRunConfig({
    runId: 'e03-preflight',
    experimentId: 'E03',
    randomSeed: 'unrealized',
    deploymentMode: 'prototype',
    registrationClass: 'qualification',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    turnResponseBudgetMs: 2_000,
    maxTurnsPerRun: 1,
    evaluationTurns: 200,
    evaluationSeeds: 20,
    checkpointEventInterval: 1_024,
    scenarioBundleHash: hashed('scenario'),
    promptBundleHash: hashed('prompt'),
    protocolGitCommit: COMMIT,
    preRegistrationHash: hashed('draft'),
  });
  return compileE03Registration({
    baseConfig,
    stage: 'blinded-pilot',
    hypothesis: 'Registered E03 pilot question.',
    analysisPlan: 'Pilot outcomes feed only the frozen sample-size rule.',
    primarySeeds: 20,
    executionBinding: {
      version: 1,
      sourceFiles: [{ path: 'packages/orchestrator/src/index.ts', sha256: hashed('source') }],
      rootBuildInputs: {
        packageJsonSha256: hashed('package-json'),
        lockfileSha256: hashed('lockfile'),
        sourceTreeSha256: hashed('source-tree'),
        buildCommand: 'pnpm build',
      },
      topology: {
        mode: 'prototype', learnerContainersPerSlot: 2,
        nurseryContainersPerSlot: 1, maximumParallelSlots: 1,
        adapterTransport: 'container-tcp', adapterTiming: 'normalized',
        adapterDeadlineMs: 2_000, learnerTrack: 'no-learning',
      },
      signing: { provider: 'controller-ephemeral-per-run', exactRunAuthorization: false, learnerAccess: false },
      dependency: {
        experimentId: 'E02', disposition: 'software-qualified',
        receiptPath: 'reports/research/e02-v3-qualification-receipt.json',
        receiptSha256: hashed('e02-receipt'), registrationHash: hashed('e02-registration'),
      },
      prototypeTopology: {
        path: 'reports/research/e03-prototype-topology-audit-receipt.json',
        sha256: hashed('topology-audit'), auditExitStatus: 0,
        conditionsAudited: 6, mode: 'prototype',
      },
      resourceAllocation: {
        path: 'protocols/seed-and-resource-allocation.v1.json',
        sha256: hashed('resources'), externalSpend: 0, publicChainTransaction: false,
      },
      stageResourceAllocation: {
        path: 'protocols/e03-pilot-resource-allocation.v1.json',
        sha256: hashed('pilot-allocation'), stage: 'blinded-pilot', plannedRuns: 120,
        reservedCpuHours: 1, reservedWorkingStorageGiB: 1,
        maximumResidentGiB: 1, externalSpend: 0,
      },
      evidencePolicy: {
        anchorClass: 'simulated', publicTimestamp: false,
        originalEvidenceImmutable: true, pilotResearchFinding: false,
      },
    },
  });
}

function passingInput() {
  const compiled = registration();
  const binding: PreRegistrationBinding = {
    registrationClass: 'qualification',
    registrationAuthority: 'external',
    preRegistrationHash: compiled.preRegistrationHash,
    externalRegistrationUrl: 'https://osf.io/example',
    externalRegistrationId: 'osf:e03-v1',
    registeredAt: '2026-09-09T00:00:00.000Z',
    preRunAnchor: {
      anchorClass: 'simulated',
      network: 'base-sepolia',
      chainId: 84532,
      transactionHash: `0x${'2'.repeat(64)}`,
      inputData: `0x${compiled.preRegistrationHash.slice(7)}`,
      blockNumber: 123,
      status: 'confirmed',
    },
    label: 'qualification pilot: externally registered before run start',
  };
  return {
    config: compiled.runs[0]!.config,
    artifact: compiled.artifact,
    preRegistrationHash: compiled.preRegistrationHash,
    binding,
    repository: {
      headCommit: COMMIT,
      clean: true,
      protocolCommitIsAncestor: true,
      registrationRecordMatches: true,
    },
  };
}

describe('registered research preflight', () => {
  it('passes only when every immutable input and registration binding agrees', () => {
    const report = evaluateResearchPreflight(passingInput());
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((item) => item.pass)).toBe(true);
    expect(formatResearchPreflight(report)).toContain('Research preflight: READY');
  });

  it('allows Prototype Mode only for E03 infrastructure qualification', () => {
    const input = passingInput();
    expect(input.config.deploymentMode).toBe('prototype');
    expect(evaluateResearchPreflight(input).ready).toBe(true);
    const mislabeled = evaluateResearchPreflight({
      ...input, config: { ...input.config, experimentId: 'E10' },
    });
    expect(mislabeled.blockers).toContain('deployment-mode-eligible');
  });

  it('reports every missing registration prerequisite instead of stopping at the first', () => {
    const input = passingInput();
    const report = evaluateResearchPreflight({ ...input, binding: undefined });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'binding-valid',
        'registration-complete',
        'binding-hash-matches',
        'pre-run-anchor-confirmed',
        'pre-run-anchor-network',
        'pre-run-anchor-payload',
      ]),
    );
    expect(formatResearchPreflight(report)).toContain('Research preflight: BLOCKED');
  });

  it.each([
    ['repository-clean', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      repository: { ...input.repository, clean: false },
    })],
    ['protocol-commit-immutable', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      repository: { ...input.repository, protocolCommitIsAncestor: false },
    })],
    ['artifact-hash-matches', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      preRegistrationHash: hashed('other'),
    })],
    ['registered-seed-bindings', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      config: { ...input.config, seedBindings: undefined },
    })],
    ['registered-run-configuration', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      config: {
        ...input.config,
        seedBindings: {
          ...input.config.seedBindings!,
          analysis: hashed('unregistered-analysis-seed').slice(7),
        },
      },
    })],
    ['registered-run-configuration', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      config: { ...input.config, maxSymbolsPerMessage: 3 },
    })],
    ['registration-class-matches', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      binding: { ...input.binding, registrationClass: 'confirmatory' as const },
    })],
    ['pre-run-anchor-payload', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      binding: {
        ...input.binding,
        preRunAnchor: { ...input.binding.preRunAnchor!, inputData: `0x${'4'.repeat(64)}` },
      },
    })],
    ['pre-run-anchor-network', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      binding: {
        ...input.binding,
        preRunAnchor: { ...input.binding.preRunAnchor!, anchorClass: 'public-chain' as const },
      },
    })],
  ] as const)('fails the %s check independently', (id, mutate) => {
    expect(evaluateResearchPreflight(mutate(passingInput())).blockers).toContain(id);
  });

  it('accepts a matching ancestral repository-native registration', () => {
    const input = passingInput();
    const report = evaluateResearchPreflight({
      ...input,
      binding: {
        registrationClass: 'qualification',
        registrationAuthority: 'repository-native',
        preRegistrationHash: input.preRegistrationHash,
        repositoryRegistration: {
          commit: COMMIT,
          path: 'protocols/e03-registration.v1.json',
          artifactSha256: input.preRegistrationHash,
          committedAt: '2026-09-09T00:00:00.000Z',
        },
        preRunAnchor: input.binding.preRunAnchor,
        label: 'qualification pilot: repository-registered before run start',
      },
    });
    expect(report.ready).toBe(true);
  });

  it('rejects a repository registration whose historical record does not match', () => {
    const input = passingInput();
    const report = evaluateResearchPreflight({
      ...input,
      binding: {
        registrationClass: 'qualification',
        registrationAuthority: 'repository-native',
        preRegistrationHash: input.preRegistrationHash,
        repositoryRegistration: {
          commit: COMMIT,
          path: 'protocols/e03-registration.v1.json',
          artifactSha256: input.preRegistrationHash,
          committedAt: '2026-09-09T00:00:00.000Z',
        },
        preRunAnchor: input.binding.preRunAnchor,
        label: 'qualification pilot: repository-registered before run start',
      },
      repository: { ...input.repository, registrationRecordMatches: false },
    });
    expect(report.blockers).toContain('registration-complete');
  });
});
