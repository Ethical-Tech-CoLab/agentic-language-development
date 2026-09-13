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
  'Draft E03 qualification artifact only: an immutable repository registration, ' +
  'matching pre-run simulated commitment, qualified E02 dependency, and sufficient ' +
  'authorized resources are still required before collection.';

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
  readonly sampleSizeDecision?: E03SampleSizeDecision;
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
  if (config.deploymentMode !== 'research-grade') {
    problems.push('deploymentMode must be research-grade');
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

function safeEvidencePath(value: string): boolean {
  return (
    value.startsWith('evidence/') &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}

function registeredParameters(
  config: RunConfig,
  stage: E03RegistrationStage,
  seedManifest: E03SeedManifest,
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
