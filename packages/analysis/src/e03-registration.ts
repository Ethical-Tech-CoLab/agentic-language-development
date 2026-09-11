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
  type E03SeedManifest,
} from './e03-design.js';
import { AnalysisError } from './errors.js';

export const E03_REGISTRATION_COMPILER_VERSION = 2;
export const E03_REGISTRATION_CLAIM_BOUNDARY =
  'Draft artifact only: external registration, governance review, and a ' +
  'confirmed pre-run Base anchor are still required before confirmatory collection.';

const VOLATILE_PARAMETER_KEYS = new Set([
  'runId',
  'randomSeed',
  'preRegistrationHash',
  'communicationCondition',
]);

export interface CompileE03RegistrationInput {
  readonly baseConfig: RunConfig;
  readonly hypothesis: string;
  readonly analysisPlan: string;
  readonly primarySeeds: number;
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
  if (config.registrationClass !== 'confirmatory') {
    problems.push('registrationClass must be confirmatory');
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
  if (problems.length > 0) {
    throw new AnalysisError('domain', `invalid E03 registration base: ${problems.join('; ')}`);
  }
}

function registeredParameters(config: RunConfig): Record<string, unknown> {
  const template = Object.fromEntries(
    Object.entries(config).filter(([key]) => !VOLATILE_PARAMETER_KEYS.has(key)),
  );
  return {
    runConfigTemplate: template,
    communicationConditions: E03_COMMUNICATION_CONDITIONS,
    seedAllocation: 'shared scenario seed by slot; condition-specific gateway derivation',
    reservePolicy: 'next unused reserve slot; no unregistered replacement',
  };
}

export function compileE03Registration(
  input: CompileE03RegistrationInput,
): CompiledE03Registration {
  const baseConfig = RunConfigSchema.parse(input.baseConfig);
  assertE03Base(baseConfig);
  const seedManifest = buildE03SeedManifest(input.primarySeeds);
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
    registrationClass: 'confirmatory',
    hypothesis: input.hypothesis,
    parameters: registeredParameters(baseConfig),
    seeds: seedManifest.entries.map((entry) => entry.scenarioSeed),
    analysisPlan: input.analysisPlan,
  });
  const canonicalArtifact = canonicalJson(artifact);
  const preRegistrationHash = hashCanonical(HASH_DOMAINS.preRegistration, artifact);
  const runs = seedManifest.entries.flatMap((entry) =>
    E03_COMMUNICATION_CONDITIONS.map((condition): E03RegisteredRun => ({
      slot: entry.slot,
      use: entry.use,
      condition,
      config: RunConfigSchema.parse({
        ...baseConfig,
        runId: `e03-${condition}-s${String(entry.slot)}`,
        randomSeed: entry.scenarioSeed,
        communicationCondition: condition,
        preRegistrationHash,
      }),
    })),
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
