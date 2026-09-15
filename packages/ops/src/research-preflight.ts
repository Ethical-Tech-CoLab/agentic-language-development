/**
 * Registered research preflight (SPEC §5.2, §10.4, §13.4, §15.1).
 * This checks immutable inputs and their recorded binding before collection;
 * it does not query a chain or decide that a study is scientifically valid.
 * Simulated commitments are accepted only when their class matches RunConfig.
 */
import { canonicalJson, hashCanonical } from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  PreRegistrationArtifactSchema,
  PreRegistrationBindingSchema,
  RunConfigSchema,
  type PreRegistrationArtifact,
  type PreRegistrationBinding,
  type RunConfig,
} from '@ald/types';

export const RESEARCH_PREFLIGHT_VERSION = 1;
export const RESEARCH_PREFLIGHT_CLAIM_BOUNDARY =
  'Configuration-and-binding preflight only: this report does not verify a ' +
  'public chain, governance approval, experiment outcomes, or scientific validity; ' +
  'a simulated commitment proves only deterministic local binding.';

export type ResearchPreflightCheckId =
  | 'run-config-valid'
  | 'deployment-mode-eligible'
  | 'independent-training'
  | 'non-placeholder-input-hashes'
  | 'registered-seed-count'
  | 'registered-seed-bindings'
  | 'registered-run-configuration'
  | 'repository-clean'
  | 'protocol-commit-immutable'
  | 'artifact-valid'
  | 'artifact-hash-matches'
  | 'artifact-protocol-matches'
  | 'registration-class-matches'
  | 'binding-valid'
  | 'registration-complete'
  | 'binding-hash-matches'
  | 'pre-run-anchor-confirmed'
  | 'pre-run-anchor-network'
  | 'pre-run-anchor-payload';

export interface ResearchPreflightCheck {
  readonly id: ResearchPreflightCheckId;
  readonly pass: boolean;
  readonly message: string;
}

export interface ResearchPreflightInput {
  readonly config: RunConfig;
  readonly artifact: PreRegistrationArtifact;
  readonly preRegistrationHash: string;
  readonly binding?: PreRegistrationBinding;
  readonly repository: {
    readonly headCommit: string;
    readonly clean: boolean;
    readonly protocolCommitIsAncestor: boolean;
    readonly registrationRecordMatches: boolean;
  };
}

export interface ResearchPreflightReport {
  readonly version: typeof RESEARCH_PREFLIGHT_VERSION;
  readonly claimBoundary: typeof RESEARCH_PREFLIGHT_CLAIM_BOUNDARY;
  readonly experimentId: string;
  readonly ready: boolean;
  readonly checks: ResearchPreflightCheck[];
  readonly blockers: ResearchPreflightCheckId[];
}

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const CHAIN_IDS = { 'base-sepolia': 84532, 'base-mainnet': 8453 } as const;
const REALIZED_RUN_FIELDS = new Set([
  'runId',
  'randomSeed',
  'seedBindings',
  'preRegistrationHash',
  'communicationCondition',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify that the realized run is one of the exact matrix entries committed
 * inside the registration artifact. Merely carrying five syntactically valid
 * seeds is insufficient: their stage, slot, condition, and stable RunConfig
 * fields must all match the registered template.
 */
function registeredRunConfigurationMatches(
  config: RunConfig,
  artifact: PreRegistrationArtifact,
): boolean {
  const template = artifact.parameters['runConfigTemplate'];
  const manifest = artifact.parameters['seedManifest'];
  const registeredConditions = artifact.parameters['communicationConditions'];
  if (
    !isRecord(template) ||
    !isRecord(manifest) ||
    !Array.isArray(manifest['entries']) ||
    !Array.isArray(registeredConditions) ||
    config.seedBindings === undefined ||
    !registeredConditions.includes(config.communicationCondition) ||
    !artifact.seeds.includes(config.randomSeed)
  ) {
    return false;
  }

  const actualTemplate = Object.fromEntries(
    Object.entries(config).filter(([key]) => !REALIZED_RUN_FIELDS.has(key)),
  );
  if (canonicalJson(actualTemplate) !== canonicalJson(template)) {
    return false;
  }

  const entry = manifest['entries'].find((candidate) =>
    isRecord(candidate) && candidate['scenarioSeed'] === config.randomSeed,
  );
  if (!isRecord(entry) || !isRecord(entry['conditionSeeds'])) {
    return false;
  }
  const conditionSeeds = entry['conditionSeeds'][config.communicationCondition];
  if (!isRecord(conditionSeeds)) {
    return false;
  }
  return canonicalJson(config.seedBindings) === canonicalJson({
    version: 1,
    scenario: entry['scenarioSeed'],
    babyA: conditionSeeds['babyA'],
    babyB: conditionSeeds['babyB'],
    gateway: conditionSeeds['gateway'],
    analysis: conditionSeeds['analysis'],
  });
}

function check(
  id: ResearchPreflightCheckId,
  pass: boolean,
  passing: string,
  failing: string,
): ResearchPreflightCheck {
  return { id, pass, message: pass ? passing : failing };
}

export function evaluateResearchPreflight(
  input: ResearchPreflightInput,
): ResearchPreflightReport {
  const parsedConfig = RunConfigSchema.safeParse(input.config);
  const config = parsedConfig.success ? parsedConfig.data : input.config;
  const parsedArtifact = PreRegistrationArtifactSchema.safeParse(input.artifact);
  const artifact = parsedArtifact.success ? parsedArtifact.data : input.artifact;
  const parsedBinding =
    input.binding === undefined
      ? undefined
      : PreRegistrationBindingSchema.safeParse(input.binding);
  const binding = parsedBinding?.success === true ? parsedBinding.data : undefined;
  const computedArtifactHash = parsedArtifact.success
    ? hashCanonical(HASH_DOMAINS.preRegistration, artifact)
    : undefined;
  const inputData = `0x${input.preRegistrationHash.replace(/^sha256:/u, '')}`;
  const independent =
    parsedConfig.success &&
    config.babyA.trainingIsolation === 'independent' &&
    config.babyB.trainingIsolation === 'independent';
  const hashesComplete =
    parsedConfig.success &&
    [config.scenarioBundleHash, config.promptBundleHash, config.preRegistrationHash].every(
      (value) => value !== GENESIS_HASH,
    );
  const seedCount = parsedArtifact.success ? new Set(artifact.seeds).size : 0;
  const runConfigurationRegistered =
    parsedConfig.success &&
    parsedArtifact.success &&
    registeredRunConfigurationMatches(config, artifact);

  const checks: ResearchPreflightCheck[] = [
    check(
      'run-config-valid',
      parsedConfig.success,
      'RunConfig satisfies its schema.',
      'RunConfig is invalid.',
    ),
    check(
      'deployment-mode-eligible',
      parsedConfig.success && (config.deploymentMode === 'research-grade' ||
        (config.experimentId === 'E03' && config.registrationClass === 'qualification' &&
          config.deploymentMode === 'prototype')),
      'Deployment mode is eligible for this registered stage.',
      'Research collection requires Research-Grade Mode; E03 infrastructure qualification may use Prototype Mode without an isolation claim.',
    ),
    check(
      'independent-training',
      independent,
      'Both learners declare independent training isolation.',
      'Both learners must declare independent training isolation.',
    ),
    check(
      'non-placeholder-input-hashes',
      hashesComplete,
      'Scenario, prompt, and pre-registration hashes are non-placeholder.',
      'Scenario, prompt, and pre-registration hashes must be non-placeholder.',
    ),
    check(
      'registered-seed-count',
      parsedConfig.success && parsedArtifact.success && seedCount >= config.evaluationSeeds,
      'The artifact contains at least the declared number of unique seeds.',
      'The artifact does not contain the declared number of unique seeds.',
    ),
    check(
      'registered-seed-bindings',
      parsedConfig.success && config.seedBindings !== undefined,
      'Scenario, per-role learner, Gateway, and analysis seeds are explicitly bound.',
      'Registered research collection requires explicit component seed bindings.',
    ),
    check(
      'registered-run-configuration',
      runConfigurationRegistered,
      'The realized condition, seed bindings, and stable RunConfig match the registered matrix.',
      'The realized run must match one exact registered matrix entry.',
    ),
    check(
      'repository-clean',
      input.repository.clean,
      'The execution repository is clean.',
      'The execution repository has uncommitted changes.',
    ),
    check(
      'protocol-commit-immutable',
      parsedConfig.success &&
        COMMIT_PATTERN.test(config.protocolGitCommit) &&
        input.repository.protocolCommitIsAncestor,
      'RunConfig identifies an immutable protocol commit ancestral to execution.',
      'RunConfig.protocolGitCommit must be a 40-hex ancestor of the current Git HEAD.',
    ),
    check(
      'artifact-valid',
      parsedArtifact.success,
      'Pre-registration artifact satisfies its schema.',
      'Pre-registration artifact is invalid.',
    ),
    check(
      'artifact-hash-matches',
      computedArtifactHash === input.preRegistrationHash &&
        parsedConfig.success &&
        config.preRegistrationHash === input.preRegistrationHash,
      'Artifact, compiler output, and RunConfig carry the same hash.',
      'Artifact, compiler output, and RunConfig hashes do not match.',
    ),
    check(
      'artifact-protocol-matches',
      parsedArtifact.success &&
        parsedConfig.success &&
        artifact.protocolGitCommit === config.protocolGitCommit,
      'Artifact and RunConfig identify the same protocol commit.',
      'Artifact and RunConfig protocol commits do not match.',
    ),
    check(
      'registration-class-matches',
      parsedConfig.success &&
        parsedArtifact.success &&
        config.registrationClass !== undefined &&
        config.registrationClass === artifact.registrationClass &&
        binding?.registrationClass === artifact.registrationClass,
      'Artifact, RunConfig, and binding carry the same explicit registration class.',
      'Artifact, RunConfig, and binding must carry the same explicit registration class.',
    ),
    check(
      'binding-valid',
      parsedBinding?.success === true,
      'Registration binding satisfies its schema.',
      'A valid registration binding is required.',
    ),
    check(
      'registration-complete',
      binding?.registrationAuthority === 'repository-native'
        ? binding.repositoryRegistration !== undefined &&
          binding.repositoryRegistration.artifactSha256 === input.preRegistrationHash &&
          input.repository.registrationRecordMatches
        : binding?.externalRegistrationUrl !== undefined &&
          binding.externalRegistrationId !== undefined &&
          binding.registeredAt !== undefined,
      'A complete ancestral repository-native or external registration is recorded.',
      'A complete ancestral repository-native or external registration is required.',
    ),
    check(
      'binding-hash-matches',
      binding?.preRegistrationHash === input.preRegistrationHash,
      'Registration binding carries the compiled artifact hash.',
      'Registration binding hash does not match the compiled artifact.',
    ),
    check(
      'pre-run-anchor-confirmed',
      binding?.preRunAnchor?.status === 'confirmed' &&
        binding.preRunAnchor.blockNumber !== null,
      'Pre-run commitment is confirmed with a block number.',
      'A confirmed pre-run commitment with a block number is required.',
    ),
    check(
      'pre-run-anchor-network',
      parsedConfig.success &&
        binding?.preRunAnchor?.anchorClass === config.anchorClass &&
        binding?.preRunAnchor?.network === config.anchorNetwork &&
        binding.preRunAnchor.chainId === CHAIN_IDS[config.anchorNetwork],
      'Pre-run anchor class, network, and chain ID match RunConfig.',
      'Pre-run anchor class, network, or chain ID does not match RunConfig.',
    ),
    check(
      'pre-run-anchor-payload',
      binding?.preRunAnchor?.inputData.toLowerCase() === inputData.toLowerCase(),
      'Pre-run commitment payload is exactly the artifact hash.',
      'Pre-run commitment payload must be exactly the artifact hash.',
    ),
  ];
  const blockers = checks.filter((item) => !item.pass).map((item) => item.id);
  return {
    version: RESEARCH_PREFLIGHT_VERSION,
    claimBoundary: RESEARCH_PREFLIGHT_CLAIM_BOUNDARY,
    experimentId: config.experimentId,
    ready: blockers.length === 0,
    checks,
    blockers,
  };
}

export function formatResearchPreflight(report: ResearchPreflightReport): string {
  const lines = [
    `Research preflight: ${report.ready ? 'READY' : 'BLOCKED'}`,
    `Experiment: ${report.experimentId}`,
    report.claimBoundary,
    '',
  ];
  for (const item of report.checks) {
    lines.push(`${item.pass ? 'PASS' : 'BLOCK'} ${item.id}: ${item.message}`);
  }
  return `${lines.join('\n')}\n`;
}
