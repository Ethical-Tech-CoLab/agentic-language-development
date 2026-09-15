/**
 * Canonical E03 pre-registration compiler (SPEC §15.1; RESEARCH.md
 * Appendix D). It compiles the study matrix before any run-specific outcome
 * exists and binds every primary/reserve RunConfig to the same artifact hash.
 */
import { canonicalJson, hashCanonical } from '@ald/hashing';
import {
  HASH_DOMAINS,
  PreRegistrationArtifactSchema,
  RunConfigSchema,
  type PreRegistrationArtifact,
  type RunConfig,
} from '@ald/types';

import {
  E03_COMMUNICATION_CONDITIONS,
  buildE03SeedManifest,
  selectE03PrimarySeeds,
  type E03RegistrationStage,
  type E03SeedManifest,
} from './e03-design.js';
import { AnalysisError } from './errors.js';

export const E03_REGISTRATION_COMPILER_VERSION = 3;
export const E03_REGISTRATION_CLAIM_BOUNDARY =
  'Draft Prototype-Mode E03 infrastructure qualification only: an immutable ' +
  'repository registration, matching pre-run simulated commitment, qualified ' +
  'dependencies, and sufficient authorized resources are still required before ' +
  'collection. This topology does not establish Research-Grade signer/writer isolation.';

const E03_CANDIDATE_PRIMARY_SEEDS = new Set([25, 75, 155, 300]);
const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/u;

const VOLATILE_PARAMETER_KEYS = new Set([
  'runId',
  'randomSeed',
  'preRegistrationHash',
  'communicationCondition',
]);

export interface CompileE03RegistrationInput {
  readonly baseConfig: RunConfig;
  readonly stage: E03RegistrationStage;
  readonly hypothesis: string;
  readonly analysisPlan: string;
  readonly primarySeeds: number;
  readonly executionBinding: E03ExecutionBinding;
  readonly sampleSizeDecision?: E03SampleSizeDecision;
}

export interface E03ExecutionBinding {
  readonly version: 1;
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly rootBuildInputs: {
    readonly packageJsonSha256: string;
    readonly lockfileSha256: string;
    readonly sourceTreeSha256: string;
    readonly buildCommand: 'pnpm build';
  };
  readonly topology: {
    readonly mode: 'prototype';
    readonly learnerContainersPerSlot: 2;
    readonly nurseryContainersPerSlot: 1;
    readonly maximumParallelSlots: 1;
    readonly adapterTransport: 'container-tcp';
    readonly adapterTiming: 'normalized';
    readonly adapterDeadlineMs: 2_000;
    readonly learnerTrack: 'no-learning';
  };
  readonly signing: {
    readonly provider: 'controller-ephemeral-per-run';
    readonly exactRunAuthorization: false;
    readonly learnerAccess: false;
  };
  readonly dependency: {
    readonly experimentId: 'E02';
    readonly disposition: 'software-qualified';
    readonly receiptPath: string;
    readonly receiptSha256: string;
    readonly registrationHash: string;
  };
  readonly prototypeTopology: {
    readonly path: string;
    readonly sha256: string;
    readonly auditExitStatus: 0;
    readonly conditionsAudited: 6;
    readonly mode: 'prototype';
  };
  readonly resourceAllocation: {
    readonly path: string;
    readonly sha256: string;
    readonly externalSpend: 0;
    readonly publicChainTransaction: false;
  };
  readonly stageResourceAllocation: {
    readonly path: string;
    readonly sha256: string;
    readonly stage: E03RegistrationStage;
    readonly plannedRuns: number;
    readonly reservedCpuHours: number;
    readonly reservedWorkingStorageGiB: number;
    readonly maximumResidentGiB: number;
    readonly priorCpuHoursCharged: number;
    readonly priorRetainedStorageGiB: number;
    readonly externalSpend: 0;
  };
  readonly evidencePolicy: {
    readonly anchorClass: 'simulated';
    readonly publicTimestamp: false;
    readonly originalEvidenceImmutable: true;
    readonly pilotResearchFinding: false;
  };
}

export interface E03SampleSizeDecision {
  readonly version: 1;
  readonly classification: 'outcome-blind-pilot-sample-size-selection';
  readonly pilotRegistrationHash: string;
  readonly pilotReceiptPath: string;
  readonly pilotReceiptSha256: string;
  readonly pilotReductionPath: string;
  readonly pilotReductionSha256: string;
  readonly powerReceiptPath: string;
  readonly powerReceiptSha256: string;
  readonly largestLatentPilotSd: number;
  readonly selectedPrimarySeeds: number;
  readonly monteCarloRepetitions: 30_000;
  readonly monteCarloLower95: number;
  readonly decisionRule: 'e03-bounded-complete-numeric-rule-v1';
}

export interface E03RegisteredRun {
  readonly slot: number;
  readonly use: 'primary' | 'reserve';
  readonly condition: (typeof E03_COMMUNICATION_CONDITIONS)[number];
  readonly config: RunConfig;
}

export interface CompiledE03Registration {
  readonly version: typeof E03_REGISTRATION_COMPILER_VERSION;
  readonly claimBoundary: typeof E03_REGISTRATION_CLAIM_BOUNDARY;
  readonly artifact: PreRegistrationArtifact;
  readonly canonicalArtifact: string;
  readonly preRegistrationHash: string;
  readonly seedManifest: E03SeedManifest;
  readonly runs: E03RegisteredRun[];
}

function assertE03Base(config: RunConfig): void {
  const problems: string[] = [];
  if (config.experimentId !== 'E03') problems.push('experimentId must be E03');
  if (config.deploymentMode !== 'prototype') {
    problems.push('E03 infrastructure qualification must use Prototype Mode until isolated signer/writer boundaries qualify');
  }
  if (config.registrationClass !== 'qualification') {
    problems.push('registrationClass must be qualification');
  }
  if (config.learningSignal !== 'none') problems.push('learningSignal must be none');
  if (config.babyA.track !== 'no-learning' || config.babyB.track !== 'no-learning') {
    problems.push('both learner tracks must be no-learning');
  }
  if (
    config.babyA.trainingIsolation !== 'independent' ||
    config.babyB.trainingIsolation !== 'independent'
  ) {
    problems.push('both learners must use independent training isolation');
  }
  if (config.evaluationTurns !== 200) problems.push('evaluationTurns must be 200');
  if (config.turnResponseBudgetMs !== 2_000) {
    problems.push('turnResponseBudgetMs must match the 2,000 ms normalized adapter deadline');
  }
  if (config.maxTurnsPerRun !== 1) problems.push('maxTurnsPerRun must be 1');
  if (config.checkpointEventInterval !== 1_024) {
    problems.push('checkpointEventInterval must be 1,024');
  }
  if (config.seedBindings !== undefined) {
    problems.push('base template must not contain realized seedBindings');
  }
  if (problems.length > 0) {
    throw new AnalysisError('domain', `invalid E03 registration base: ${problems.join('; ')}`);
  }
}

function assertSampleSizeDecision(
  input: CompileE03RegistrationInput,
): void {
  if (input.stage !== 'blinded-pilot' && input.stage !== 'full-qualification') {
    throw new AnalysisError('domain', 'E03 registration stage is invalid');
  }
  if (input.stage === 'blinded-pilot') {
    if (input.primarySeeds !== 20) {
      throw new AnalysisError('domain', 'E03 blinded pilot requires exactly 20 primary slots');
    }
    if (input.sampleSizeDecision !== undefined) {
      throw new AnalysisError('domain', 'E03 blinded pilot must not consume a sample-size decision');
    }
    return;
  }
  const decision = input.sampleSizeDecision;
  if (decision === undefined) {
    throw new AnalysisError('domain', 'E03 full qualification requires a pilot sample-size decision');
  }
  if (
    decision.version !== 1 ||
    decision.classification !== 'outcome-blind-pilot-sample-size-selection' ||
    decision.decisionRule !== 'e03-bounded-complete-numeric-rule-v1' ||
    decision.monteCarloRepetitions !== 30_000 ||
    decision.monteCarloLower95 < 0.9 ||
    !Number.isFinite(decision.largestLatentPilotSd) ||
    decision.largestLatentPilotSd < 0 ||
    decision.largestLatentPilotSd > 0.2 ||
    decision.selectedPrimarySeeds !== input.primarySeeds ||
    !E03_CANDIDATE_PRIMARY_SEEDS.has(input.primarySeeds) ||
    selectE03PrimarySeeds(decision.largestLatentPilotSd) !==
      decision.selectedPrimarySeeds ||
    !safeEvidencePath(decision.pilotReceiptPath) ||
    !safeEvidencePath(decision.pilotReductionPath) ||
    !safeEvidencePath(decision.powerReceiptPath) ||
    !SHA256_PATTERN.test(decision.pilotRegistrationHash) ||
    !SHA256_PATTERN.test(decision.pilotReceiptSha256) ||
    !SHA256_PATTERN.test(decision.pilotReductionSha256) ||
    !SHA256_PATTERN.test(decision.powerReceiptSha256)
  ) {
    throw new AnalysisError('domain', 'E03 sample-size decision does not satisfy the frozen rule');
  }
}

function assertExecutionBinding(binding: E03ExecutionBinding, stage: E03RegistrationStage,
  plannedRuns: number): void {
  const sourcePaths = new Set(binding.sourceFiles.map((source) => source.path));
  if (
    binding.version !== 1 ||
    binding.sourceFiles.length === 0 ||
    sourcePaths.size !== binding.sourceFiles.length ||
    binding.sourceFiles.some(
      (source) =>
        !safeRepositoryPath(source.path) || !SHA256_PATTERN.test(source.sha256),
    ) ||
    !SHA256_PATTERN.test(binding.rootBuildInputs.packageJsonSha256) ||
    !SHA256_PATTERN.test(binding.rootBuildInputs.lockfileSha256) ||
    !SHA256_PATTERN.test(binding.rootBuildInputs.sourceTreeSha256) ||
    binding.rootBuildInputs.buildCommand !== 'pnpm build' ||
    binding.topology.mode !== 'prototype' ||
    binding.topology.learnerContainersPerSlot !== 2 ||
    binding.topology.nurseryContainersPerSlot !== 1 ||
    binding.topology.maximumParallelSlots !== 1 ||
    binding.topology.adapterTransport !== 'container-tcp' ||
    binding.topology.adapterTiming !== 'normalized' ||
    binding.topology.adapterDeadlineMs !== 2_000 ||
    binding.topology.learnerTrack !== 'no-learning' ||
    binding.signing.provider !== 'controller-ephemeral-per-run' ||
    binding.signing.exactRunAuthorization !== false ||
    binding.signing.learnerAccess !== false ||
    binding.dependency.experimentId !== 'E02' ||
    binding.dependency.disposition !== 'software-qualified' ||
    !safeRepositoryPath(binding.dependency.receiptPath) ||
    !SHA256_PATTERN.test(binding.dependency.receiptSha256) ||
    !SHA256_PATTERN.test(binding.dependency.registrationHash) ||
    !safeRepositoryPath(binding.prototypeTopology.path) ||
    !SHA256_PATTERN.test(binding.prototypeTopology.sha256) ||
    binding.prototypeTopology.auditExitStatus !== 0 ||
    binding.prototypeTopology.conditionsAudited !== 6 ||
    binding.prototypeTopology.mode !== 'prototype' ||
    !safeRepositoryPath(binding.resourceAllocation.path) ||
    !SHA256_PATTERN.test(binding.resourceAllocation.sha256) ||
    binding.resourceAllocation.externalSpend !== 0 ||
    binding.resourceAllocation.publicChainTransaction !== false ||
    !safeRepositoryPath(binding.stageResourceAllocation.path) ||
    !SHA256_PATTERN.test(binding.stageResourceAllocation.sha256) ||
    binding.stageResourceAllocation.stage !== stage ||
    binding.stageResourceAllocation.plannedRuns !== plannedRuns ||
    !(binding.stageResourceAllocation.reservedCpuHours > 0) ||
    !(binding.stageResourceAllocation.reservedWorkingStorageGiB > 0) ||
    !(binding.stageResourceAllocation.maximumResidentGiB > 0) ||
    !(binding.stageResourceAllocation.priorCpuHoursCharged >= 0) ||
    !(binding.stageResourceAllocation.priorRetainedStorageGiB >= 0) ||
    binding.stageResourceAllocation.externalSpend !== 0 ||
    binding.evidencePolicy.anchorClass !== 'simulated' ||
    binding.evidencePolicy.publicTimestamp !== false ||
    binding.evidencePolicy.originalEvidenceImmutable !== true ||
    binding.evidencePolicy.pilotResearchFinding !== false
  ) {
    throw new AnalysisError('domain', 'E03 execution binding is incomplete or invalid');
  }
}

function safeEvidencePath(value: string): boolean {
  return (
    value.startsWith('evidence/') &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}

function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}

function registeredParameters(
  config: RunConfig,
  stage: E03RegistrationStage,
  seedManifest: E03SeedManifest,
  executionBinding: E03ExecutionBinding,
  sampleSizeDecision: E03SampleSizeDecision | undefined,
): Record<string, unknown> {
  const template = Object.fromEntries(
    Object.entries(config).filter(([key]) => !VOLATILE_PARAMETER_KEYS.has(key)),
  );
  return {
    runConfigTemplate: template,
    stage,
    communicationConditions: E03_COMMUNICATION_CONDITIONS,
    seedManifest,
    executionBinding,
    reservePolicy: stage === 'blinded-pilot'
      ? 'zero reserves; every attempted pilot slot remains accounted for'
      : 'next unused ordered reserve slot for registered validity failures only',
    ...(sampleSizeDecision === undefined ? {} : { sampleSizeDecision }),
  };
}

export function compileE03Registration(
  input: CompileE03RegistrationInput,
): CompiledE03Registration {
  const baseConfig = RunConfigSchema.parse(input.baseConfig);
  assertE03Base(baseConfig);
  assertSampleSizeDecision(input);
  const seedManifest = buildE03SeedManifest(input.stage, input.primarySeeds);
  assertExecutionBinding(input.executionBinding, input.stage,
    seedManifest.entries.length * E03_COMMUNICATION_CONDITIONS.length);
  if (baseConfig.evaluationSeeds !== input.primarySeeds) {
    throw new AnalysisError(
      'domain',
      'baseConfig.evaluationSeeds must equal primarySeeds',
    );
  }

  const artifact = PreRegistrationArtifactSchema.parse({
    version: 1,
    experimentId: 'E03',
    protocolGitCommit: baseConfig.protocolGitCommit,
    registrationClass: 'qualification',
    hypothesis: input.hypothesis,
    parameters: registeredParameters(
      baseConfig,
      input.stage,
      seedManifest,
      input.executionBinding,
      input.sampleSizeDecision,
    ),
    seeds: seedManifest.entries.map((entry) => entry.scenarioSeed),
    analysisPlan: input.analysisPlan,
  });
  const canonicalArtifact = canonicalJson(artifact);
  const preRegistrationHash = hashCanonical(HASH_DOMAINS.preRegistration, artifact);
  const runStage = input.stage === 'blinded-pilot' ? 'pilot' : 'full';
  const runs = seedManifest.entries.flatMap((entry) =>
    E03_COMMUNICATION_CONDITIONS.map((condition): E03RegisteredRun => {
      const conditionSeeds = entry.conditionSeeds[condition];
      return {
        slot: entry.slot,
        use: entry.use,
        condition,
        config: RunConfigSchema.parse({
          ...baseConfig,
          runId: `e03-${runStage}-${condition}-s${String(entry.slot).padStart(3, '0')}`,
          randomSeed: entry.scenarioSeed,
          seedBindings: {
            version: 1,
            scenario: entry.scenarioSeed,
            ...conditionSeeds,
          },
          communicationCondition: condition,
          preRegistrationHash,
        }),
      };
    }),
  );

  return {
    version: E03_REGISTRATION_COMPILER_VERSION,
    claimBoundary: E03_REGISTRATION_CLAIM_BOUNDARY,
    artifact,
    canonicalArtifact,
    preRegistrationHash,
    seedManifest,
    runs,
  };
}
