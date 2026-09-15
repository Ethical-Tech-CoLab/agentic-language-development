import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';

import { compileE03Registration } from '../src/e03-registration.js';

const hash = (label: string) => hashCanonical(HASH_DOMAINS.scenarioBundle, label);

function baseConfig(primarySeeds = 3) {
  return buildRunConfig({
    runId: 'e03-registration-template',
    experimentId: 'E03',
    randomSeed: 'unrealized-seed',
    deploymentMode: 'prototype',
    registrationClass: 'qualification',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    turnResponseBudgetMs: 2_000,
    maxTurnsPerRun: 1,
    evaluationTurns: 200,
    evaluationSeeds: primarySeeds,
    checkpointEventInterval: 1_024,
    scenarioBundleHash: hash('scenario'),
    promptBundleHash: hash('prompt'),
    protocolGitCommit: '1'.repeat(40),
    preRegistrationHash: hash('uncompiled-placeholder'),
  });
}

const input = {
  baseConfig: baseConfig(20),
  stage: 'blinded-pilot',
  hypothesis: 'Estimate E03 variance without testing the qualification claim.',
  analysisPlan: 'Use pilot outcomes only for the frozen sample-size rule.',
  primarySeeds: 20,
  executionBinding: {
    version: 1,
    sourceFiles: [{ path: 'packages/orchestrator/src/index.ts', sha256: hash('source') }],
    rootBuildInputs: {
      packageJsonSha256: hash('package-json'),
      lockfileSha256: hash('lockfile'),
      sourceTreeSha256: hash('source-tree'),
      buildCommand: 'pnpm build',
    },
    topology: {
      mode: 'prototype',
      learnerContainersPerSlot: 0,
      nurseryContainersPerSlot: 1,
      sharedNurseryProcess: true,
      maximumParallelSlots: 1,
      adapterTransport: 'in-process',
      adapterTiming: 'immediate',
      turnResponseBudgetMs: 2_000,
      learnerTrack: 'no-learning',
    },
    signing: {
      provider: 'controller-ephemeral-per-run',
      exactRunAuthorization: false,
      learnerAccess: false,
    },
    dependency: {
      experimentId: 'E02',
      disposition: 'software-qualified',
      receiptPath: 'reports/research/e02-v3-qualification-receipt.json',
      receiptSha256: hash('e02-receipt'),
      registrationHash: hash('e02-registration'),
    },
    prototypeTopology: {
      path: 'reports/research/e03-prototype-topology-audit-receipt.json',
      sha256: hash('topology-audit'), auditExitStatus: 0,
      conditionsAudited: 6, mode: 'prototype',
    },
    resourceAllocation: {
      path: 'protocols/seed-and-resource-allocation.v1.json',
      sha256: hash('resources'),
      externalSpend: 0,
      publicChainTransaction: false,
    },
    stageResourceAllocation: {
      path: 'protocols/e03-pilot-resource-allocation.v1.json',
      sha256: hash('pilot-allocation'), stage: 'blinded-pilot', plannedRuns: 120,
      reservedCpuHours: 1, reservedWorkingStorageGiB: 1,
      maximumResidentGiB: 1, priorCpuHoursCharged: 22,
      priorRetainedStorageGiB: 1, externalSpend: 0,
    },
    evidencePolicy: {
      anchorClass: 'simulated',
      publicTimestamp: false,
      originalEvidenceImmutable: true,
      pilotResearchFinding: false,
    },
  },
} as const;

const sampleSizeDecision = {
  version: 1,
  classification: 'outcome-blind-pilot-sample-size-selection',
  pilotRegistrationHash: hash('pilot-registration'),
  pilotReceiptPath: 'evidence/pilots/e03-v1/pilot-receipt.json',
  pilotReceiptSha256: hash('pilot-receipt'),
  pilotReductionPath: 'evidence/pilots/e03-v1/pilot-reduction.json',
  pilotReductionSha256: hash('pilot-reduction'),
  powerReceiptPath: 'evidence/pilots/e03-v1/power-receipt.json',
  powerReceiptSha256: hash('power-receipt'),
  largestLatentPilotSd: 0.05,
  selectedPrimarySeeds: 25,
  monteCarloRepetitions: 30_000,
  monteCarloLower95: 0.91,
  decisionRule: 'e03-bounded-complete-numeric-rule-v1',
} as const;

const fullInput = {
  ...input,
  stage: 'full-qualification',
  baseConfig: baseConfig(25),
  primarySeeds: 25,
  sampleSizeDecision,
  executionBinding: {
    ...input.executionBinding,
    stageResourceAllocation: {
      ...input.executionBinding.stageResourceAllocation,
      path: 'protocols/e03-full-resource-allocation.v1.json',
      sha256: hash('full-allocation'), stage: 'full-qualification', plannedRuns: 168,
    },
  },
} as const;

describe('E03 pre-registration compiler', () => {
  it('builds one canonical artifact and binds every condition/slot to its hash', () => {
    const result = compileE03Registration(input);
    expect(PreRegistrationArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
    expect(result.preRegistrationHash).toBe(
      hashCanonical(HASH_DOMAINS.preRegistration, result.artifact),
    );
    expect(result.runs).toHaveLength(120);
    expect(new Set(result.runs.map((run) => run.config.preRegistrationHash))).toEqual(
      new Set([result.preRegistrationHash]),
    );
    expect(new Set(result.runs.map((run) => run.condition)).size).toBe(6);
    expect(result.artifact.registrationClass).toBe('qualification');
    expect(result.artifact.parameters['executionBinding']).toEqual(input.executionBinding);
    expect(result.seedManifest.reserveSeeds).toBe(0);
    const firstSlot = result.runs.filter((run) => run.slot === 1);
    expect(new Set(firstSlot.map((run) => run.config.randomSeed)).size).toBe(1);
    expect(new Set(firstSlot.flatMap((run) => {
      const seeds = run.config.seedBindings!;
      return [seeds.babyA, seeds.babyB, seeds.gateway, seeds.analysis];
    })).size).toBe(24);
  });

  it('compiles a v2 pilot with fresh registered IDs and seeds', () => {
    const original = compileE03Registration(input);
    const amended = compileE03Registration({ ...input, attemptVersion: 'v2',
      executionBinding: { ...input.executionBinding,
        registrationAmendment: {
          path: 'protocols/e03-pilot-registration-amendment.v2.json',
          sha256: hash('prospective-amendment'),
        },
      },
    });
    expect(amended.runs).toHaveLength(120);
    expect(amended.seedManifest.attemptVersion).toBe('v2');
    expect(amended.runs[0]?.config.runId).toMatch(/^e03-pilot-v2-/u);
    expect(new Set([...original.runs.map((run) => run.config.runId),
      ...amended.runs.map((run) => run.config.runId)]).size).toBe(240);
    expect(new Set([...original.seedManifest.entries.map((entry) => entry.scenarioSeed),
      ...amended.seedManifest.entries.map((entry) => entry.scenarioSeed)]).size).toBe(40);
    expect(amended.preRegistrationHash).not.toBe(original.preRegistrationHash);
  });

  it('rejects a v2 pilot that does not bind its prospective amendment', () => {
    expect(() => compileE03Registration({ ...input, attemptVersion: 'v2' }))
      .toThrow(/execution binding is incomplete/u);
  });

  it('requires a separate v3 amendment and allocation namespace', () => {
    const second = compileE03Registration({ ...input, attemptVersion: 'v2',
      executionBinding: { ...input.executionBinding,
        registrationAmendment: {
          path: 'protocols/e03-pilot-registration-amendment.v2.json',
          sha256: hash('amendment-v2'),
        },
      },
    });
    const third = compileE03Registration({ ...input, attemptVersion: 'v3',
      executionBinding: { ...input.executionBinding,
        registrationAmendment: {
          path: 'protocols/e03-pilot-registration-amendment.v3.json',
          sha256: hash('amendment-v3'),
        },
      },
    });
    expect(third.runs[0]?.config.runId).toMatch(/^e03-pilot-v3-/u);
    expect(new Set([...second.runs.map((run) => run.config.runId),
      ...third.runs.map((run) => run.config.runId)]).size).toBe(240);
    expect(new Set([...second.seedManifest.entries.map((entry) => entry.scenarioSeed),
      ...third.seedManifest.entries.map((entry) => entry.scenarioSeed)]).size).toBe(40);
    expect(third.preRegistrationHash).not.toBe(second.preRegistrationHash);
  });

  it('is byte-identical on repeat and changes hash when a registered field changes', () => {
    const first = compileE03Registration(input);
    const second = compileE03Registration(input);
    expect(second).toEqual(first);
    const changed = compileE03Registration({
      ...input,
      analysisPlan: `${input.analysisPlan} Sensitivity analysis added before registration.`,
    });
    expect(changed.preRegistrationHash).not.toBe(first.preRegistrationHash);
  });

  it('excludes realized run identity, seed, condition, and hash from the parameter template', () => {
    const result = compileE03Registration(input);
    const parameters = result.artifact.parameters;
    const template = parameters['runConfigTemplate'] as Record<string, unknown>;
    expect(template).not.toHaveProperty('runId');
    expect(template).not.toHaveProperty('randomSeed');
    expect(template).not.toHaveProperty('communicationCondition');
    expect(template).not.toHaveProperty('preRegistrationHash');
    expect(parameters['communicationConditions']).toEqual([
      'disabled',
      'constant',
      'random',
      'shuffled',
      'normal',
      'oracle',
    ]);
  });

  it('fails closed on a mislabeled isolation mode or mismatched seed-count base', () => {
    expect(() =>
      compileE03Registration({
        ...input,
        baseConfig: { ...baseConfig(), deploymentMode: 'research-grade' },
      }),
    ).toThrow(/Prototype Mode/u);
    expect(() => compileE03Registration({ ...input, baseConfig: baseConfig(19) })).toThrow(
      /must equal primarySeeds/u,
    );
    expect(() => compileE03Registration({
      ...input, baseConfig: { ...baseConfig(20), turnResponseBudgetMs: 30_000 },
    })).toThrow(/2,000 ms normalized adapter deadline/u);
    expect(() => compileE03Registration({
      ...input,
      executionBinding: {
        ...input.executionBinding,
        signing: { ...input.executionBinding.signing, learnerAccess: true },
      },
    })).toThrow(/execution binding/u);
    expect(() => compileE03Registration({
      ...input,
      executionBinding: {
        ...input.executionBinding,
        stageResourceAllocation: { ...input.executionBinding.stageResourceAllocation,
          plannedRuns: 119 },
      },
    })).toThrow(/execution binding/u);
  });

  it('requires a qualifying pilot decision before full qualification', () => {
    const full = compileE03Registration(fullInput);
    expect(full.runs).toHaveLength(168);
    expect(full.seedManifest.reserveSeeds).toBe(3);
    expect(full.artifact.parameters['sampleSizeDecision']).toEqual(sampleSizeDecision);
    expect(() => compileE03Registration({
      ...fullInput,
      sampleSizeDecision: undefined,
    })).toThrow(/requires a pilot sample-size decision/u);
    expect(() => compileE03Registration({
      ...fullInput,
      sampleSizeDecision: { ...sampleSizeDecision, monteCarloLower95: 0.89 },
    })).toThrow(/frozen rule/u);
    expect(() => compileE03Registration({
      ...fullInput,
      sampleSizeDecision: {
        ...sampleSizeDecision,
        largestLatentPilotSd: 0.1,
      },
    })).toThrow(/frozen rule/u);
    expect(() => compileE03Registration({
      ...fullInput,
      sampleSizeDecision: {
        ...sampleSizeDecision,
        pilotReceiptPath: '../unretained.json',
      },
    })).toThrow(/frozen rule/u);
  });
});
