/**
 * Confirmatory research preflight (SPEC §5.2, §10.4, §13.4, §15.1).
 * This checks immutable inputs and their recorded binding before collection;
 * it does not query a chain or decide that a study is scientifically valid.
 * Simulated commitments are accepted only when their class matches RunConfig.
 */
import { hashCanonical } from '@ald/hashing';
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
  | 'research-grade-mode'
  | 'independent-training'
  | 'non-placeholder-input-hashes'
  | 'registered-seed-count'
  | 'repository-clean'
  | 'protocol-commit-immutable'
  | 'artifact-valid'
  | 'artifact-hash-matches'
  | 'artifact-protocol-matches'
  | 'confirmatory-class'
  | 'binding-valid'
  | 'external-registration-complete'
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

  const checks: ResearchPreflightCheck[] = [
    check(
      'run-config-valid',
      parsedConfig.success,
      'RunConfig satisfies its schema.',
      'RunConfig is invalid.',
    ),
    check(
      'research-grade-mode',
      parsedConfig.success && config.deploymentMode === 'research-grade',
      'Research-Grade Mode is selected.',
      'Confirmatory collection requires Research-Grade Mode.',
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
      'repository-clean',
      input.repository.clean,
      'The execution repository is clean.',
      'The execution repository has uncommitted changes.',
    ),
    check(
      'protocol-commit-immutable',
      parsedConfig.success &&
        COMMIT_PATTERN.test(config.protocolGitCommit) &&
        config.protocolGitCommit === input.repository.headCommit,
      'RunConfig identifies the exact immutable execution commit.',
      'RunConfig.protocolGitCommit must equal the current 40-hex Git HEAD.',
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
      'confirmatory-class',
      parsedConfig.success &&
        parsedArtifact.success &&
        config.registrationClass === 'confirmatory' &&
        artifact.registrationClass === 'confirmatory',
      'Artifact and RunConfig are both labeled confirmatory.',
      'Artifact and RunConfig must both be labeled confirmatory.',
    ),
    check(
      'binding-valid',
      parsedBinding?.success === true,
      'External registration binding satisfies its schema.',
      'A valid external registration binding is required.',
    ),
    check(
      'external-registration-complete',
      binding?.externalRegistrationUrl !== undefined &&
        binding.externalRegistrationId !== undefined &&
        binding.registeredAt !== undefined,
      'External registration URL, ID, and timestamp are recorded.',
      'External registration URL, ID, and timestamp are required.',
    ),
    check(
      'binding-hash-matches',
      binding?.preRegistrationHash === input.preRegistrationHash,
      'External binding carries the compiled artifact hash.',
      'External binding hash does not match the compiled artifact.',
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
