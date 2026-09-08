/**
 * Run configuration construction and validation (SPECIFICATION.md §11.1
 * Run Configuration, §9.1/§9.2 carrier bounds, §10.4 training isolation,
 * §13.4 Base Sepolia/mainnet anchoring policy, §15.3 evaluation seeds, §18
 * Experiment Variable Registry; BACKLOG ALD-023).
 *
 * `RunConfigSchema` in `@ald/types` owns field presence, ranges, the
 * track/learning-signal matrix, the oracle/E03 restriction, and the
 * all-or-none lineage rule. This module wraps it, adds the cross-field rules
 * §11.1 and §9 state in prose but the schema does not encode, and produces the
 * canonical `configurationHash` every downstream component references
 * (`HASH_DOMAINS.runConfig`).
 */
import { hashCanonical } from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  RunConfigSchema,
  type LearnerTrackId,
  type RunConfig,
} from '@ald/types';

export interface RunConfigError {
  /** Dotted path of the offending field, or `(root)` for whole-config rules. */
  path: string;
  message: string;
}

export type RunConfigValidation =
  | {
      ok: true;
      config: RunConfig;
      configurationHash: string;
      /** Non-blocking methodology flags (§10.4, §15.3). */
      warnings: string[];
    }
  | { ok: false; errors: RunConfigError[]; warnings: string[] };

/** Thrown by {@link buildRunConfig} and derived-run construction. */
export class RunConfigValidationError extends Error {
  readonly errors: readonly RunConfigError[];

  constructor(errors: readonly RunConfigError[]) {
    super(
      `invalid run configuration: ${errors
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
    this.name = 'RunConfigValidationError';
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * SPEC §18 defaults for every field whose default does not depend on another
 * field. Carrier-scoped bounds, the learning signal, `symmetricTracks`, and
 * `finalityPolicy` are derived in {@link buildRunConfig} instead, because §18
 * states them conditionally.
 */
export const RUN_CONFIG_DEFAULTS = {
  version: 1,
  deploymentMode: 'prototype',
  track: 'scratch-rl',
  modelRef: 'tabular-reinforce-v1',
  trainingIsolation: 'independent',
  symmetricTracks: true,
  learningSignal: 'extrinsic-task',
  communicationCondition: 'normal',
  interactionMode: 'cooperative-signaling',
  carrierMode: 'fixed-token',
  symbolInventorySize: 32,
  maxSymbolsPerMessage: 4,
  maxStrokes: 8,
  affectMode: 'none',
  affectWindowSchedule: 'post-outcome',
  observationEncoding: 'opaque-numeric',
  roleReversalPeriod: 1,
  turnResponseBudgetMs: 30_000,
  maxTurnsPerRun: 200,
  maxConsecutiveRejections: 5,
  ledgerLagTurns: 0,
  curriculumMode: 'fixed-schedule',
  cipherThreatModel: 'post-run-disclosure',
  interventionSuiteThreshold: 0.7,
  evaluationSeeds: 5,
  checkpointEventInterval: 64,
  checkpointTimeIntervalMs: 300_000,
  anchorNetwork: 'base-sepolia',
  finalityPolicy: '1-confirmation',
  prototypeRetentionDays: 30,
  protocolGitCommit: 'unknown',
  placeholderHash: GENESIS_HASH,
} as const satisfies Record<string, string | number | boolean>;

/** §15.3: publication-facing claims (E10 onward) need 10 seeds per condition. */
const PUBLICATION_EXPERIMENT_INDEX = 10;
const PUBLICATION_EVALUATION_SEEDS = 10;
const QUALIFICATION_EVALUATION_SEEDS = 5;

/** §9.1: the absolute Gateway ceiling, regardless of configuration. */
const MAX_SYMBOLS_PER_MESSAGE_CEILING = 16;

/**
 * §9.1, §9.2: carriers with a declared, bounded symbol/glyph inventory — the
 * `fixed-token` baseline (default inventory 32, default 4 per message) and
 * its `fixed-glyph` alternate, whose §9.2 default bound is stated the same
 * way ("32 glyphs, 4 per message"). The other alternate carriers
 * (`generative-bitmap`, `generative-canvas`, `generative-tone`) each have
 * their own fixed physical bound instead (§9.2) and do not take these
 * fields.
 */
const SYMBOL_INVENTORY_CARRIERS = [
  'fixed-token',
  'fixed-glyph',
] as const satisfies readonly RunConfig['carrierMode'][];

function hasSymbolInventory(carrierMode: RunConfig['carrierMode']): boolean {
  return (
    SYMBOL_INVENTORY_CARRIERS as readonly RunConfig['carrierMode'][]
  ).includes(carrierMode);
}

/**
 * §18: mainnet anchoring must wait for the `safe` block tag rather than the
 * Sepolia development default of one confirmation (SPECIFICATION.md §13.4;
 * LEDGER-INTEGRITY-DESIGN.md §10). Carrying `1-confirmation` over onto
 * mainnet would report a checkpoint anchored-final a single block deep.
 */
const MAINNET_FINALITY_POLICY = 'safe-tag';

/** §11.1: learning signals a `hybrid` track may declare. */
const HYBRID_LEARNING_SIGNALS = [
  'extrinsic-task',
  'intrinsic-social-influence',
  'intrinsic-curiosity',
  'intrinsic-prediction-progress',
  'intrinsic-giddiness',
  'self-supervised',
] as const satisfies readonly RunConfig['learningSignal'][];

const LEARNER_FIELDS = ['babyA', 'babyB'] as const;

function experimentIndex(experimentId: string): number {
  return Number.parseInt(experimentId.slice(1), 10);
}

/**
 * §11.1 and §9 rules the zod schema cannot express, keyed by the field a
 * researcher has to change to fix them.
 */
function collectCrossFieldErrors(config: RunConfig): RunConfigError[] {
  const errors: RunConfigError[] = [];

  // §11.1, §9.2: `symbolInventorySize` and `maxSymbolsPerMessage` belong to
  // the two carriers with a declared symbol/glyph inventory (`fixed-token`
  // and `fixed-glyph`); the other alternate carriers give their own fixed
  // bound instead.
  if (!hasSymbolInventory(config.carrierMode)) {
    if (config.symbolInventorySize !== undefined) {
      errors.push({
        path: 'symbolInventorySize',
        message: `symbolInventorySize applies only to carrierMode "fixed-token" or "fixed-glyph", not "${config.carrierMode}"`,
      });
    }
    if (config.maxSymbolsPerMessage !== undefined) {
      errors.push({
        path: 'maxSymbolsPerMessage',
        message: `maxSymbolsPerMessage applies only to carrierMode "fixed-token" or "fixed-glyph", not "${config.carrierMode}"`,
      });
    }
  }

  // §11.1: `maxStrokes` is generative-canvas only.
  if (
    config.carrierMode !== 'generative-canvas' &&
    config.maxStrokes !== undefined
  ) {
    errors.push({
      path: 'maxStrokes',
      message: `maxStrokes applies only to carrierMode "generative-canvas", not "${config.carrierMode}"`,
    });
  }

  // §9.1: absolute ceiling, restated here so a config assembled without the
  // schema's range check still cannot exceed it.
  if (
    config.maxSymbolsPerMessage !== undefined &&
    config.maxSymbolsPerMessage > MAX_SYMBOLS_PER_MESSAGE_CEILING
  ) {
    errors.push({
      path: 'maxSymbolsPerMessage',
      message: `maxSymbolsPerMessage must not exceed the Gateway ceiling of ${MAX_SYMBOLS_PER_MESSAGE_CEILING}`,
    });
  }

  // §18: `symmetricTracks` is a declaration about the two tracks, so it must
  // agree with them.
  const tracksMatch = config.babyA.track === config.babyB.track;
  if (config.symmetricTracks !== tracksMatch) {
    errors.push({
      path: 'symmetricTracks',
      message: tracksMatch
        ? `symmetricTracks must be true when both Babies use track "${config.babyA.track}"`
        : `symmetricTracks must be false when babyA uses "${config.babyA.track}" and babyB uses "${config.babyB.track}"`,
    });
  }

  // §11.1: "hybrid must declare whether it uses an RL-compatible or
  // self-supervised signal" — `none` declares neither.
  for (const field of LEARNER_FIELDS) {
    const learner = config[field];
    if (
      learner.track === 'hybrid' &&
      !(
        HYBRID_LEARNING_SIGNALS as readonly RunConfig['learningSignal'][]
      ).includes(config.learningSignal)
    ) {
      errors.push({
        path: `${field}.track`,
        message:
          'hybrid must declare an RL-compatible or self-supervised learning signal, not "none"',
      });
    }
  }

  return errors;
}

/** §10.4, §13.4, and §15.3 flags: allowed, but never silently. */
function collectWarnings(config: RunConfig): string[] {
  const warnings: string[] = [];

  // §13.4: mainnet must wait for the `safe` block tag (or an equivalent
  // provider-specific finality/confirmation-depth policy) before a
  // checkpoint is reported anchored-final. This is a warning, not a
  // rejection, because §13.4 permits a provider-specific equivalent string
  // this module cannot enumerate — but the known Sepolia default carried
  // over onto mainnet is always wrong, so it is always flagged.
  if (
    config.anchorNetwork === 'base-mainnet' &&
    config.finalityPolicy === RUN_CONFIG_DEFAULTS.finalityPolicy
  ) {
    warnings.push(
      `finalityPolicy is "${config.finalityPolicy}" on anchorNetwork "base-mainnet": SPEC ` +
        '§13.4 requires waiting for the "safe" block tag (or an equivalent finality policy) ' +
        'before a mainnet checkpoint is reported anchored-final',
    );
  }

  for (const field of LEARNER_FIELDS) {
    if (config[field].trainingIsolation === 'centralized') {
      warnings.push(
        `${field}.trainingIsolation is "centralized": SPEC §10.4 requires this run to be ` +
          'reported as a weaker-isolation condition and never as the default',
      );
    }
  }

  if (config.evaluationSeeds < QUALIFICATION_EVALUATION_SEEDS) {
    warnings.push(
      `evaluationSeeds is ${config.evaluationSeeds}: SPEC §15.3 expects at least ` +
        `${QUALIFICATION_EVALUATION_SEEDS} seeds per condition for a qualification claim`,
    );
  } else if (
    experimentIndex(config.experimentId) >= PUBLICATION_EXPERIMENT_INDEX &&
    config.evaluationSeeds < PUBLICATION_EVALUATION_SEEDS
  ) {
    warnings.push(
      `evaluationSeeds is ${config.evaluationSeeds} for ${config.experimentId}: SPEC §15.3 ` +
        `requires ${PUBLICATION_EVALUATION_SEEDS} seeds per condition for publication-facing ` +
        'claims (E10 onward)',
    );
  }

  return warnings;
}

/** Canonical `configurationHash` / `runConfigRef` for a validated config. */
export function hashRunConfig(config: RunConfig): string {
  return hashCanonical(HASH_DOMAINS.runConfig, config);
}

/**
 * ALD-023: validate an untrusted run configuration before a run may be
 * created. Schema failures are reported with the zod issue path; cross-field
 * failures with the field a researcher must change.
 */
export function validateRunConfig(input: unknown): RunConfigValidation {
  const parsed = RunConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const config = parsed.data;
  const errors = collectCrossFieldErrors(config);
  const warnings = collectWarnings(config);
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    config,
    configurationHash: hashRunConfig(config),
    warnings,
  };
}

/** Same as {@link validateRunConfig} but throws {@link RunConfigValidationError}. */
export function assertValidRunConfig(input: unknown): {
  config: RunConfig;
  configurationHash: string;
  warnings: string[];
} {
  const result = validateRunConfig(input);
  if (!result.ok) {
    throw new RunConfigValidationError(result.errors);
  }
  return {
    config: result.config,
    configurationHash: result.configurationHash,
    warnings: result.warnings,
  };
}

/**
 * Overrides accepted by {@link buildRunConfig}. Identical to
 * `Partial<RunConfig>` except that the per-Baby objects may be partial too, so
 * a caller can change one Baby's track without restating its `modelRef`.
 */
export type RunConfigOverrides = Omit<Partial<RunConfig>, 'babyA' | 'babyB'> & {
  runId: string;
  experimentId: string;
  randomSeed: string;
  babyA?: Partial<RunConfig['babyA']>;
  babyB?: Partial<RunConfig['babyB']>;
};

function buildLearner(
  overrides: Partial<RunConfig['babyA']> | undefined,
): RunConfig['babyA'] {
  const initialPolicyRef = overrides?.initialPolicyRef;
  return {
    track: overrides?.track ?? RUN_CONFIG_DEFAULTS.track,
    modelRef: overrides?.modelRef ?? RUN_CONFIG_DEFAULTS.modelRef,
    trainingIsolation:
      overrides?.trainingIsolation ?? RUN_CONFIG_DEFAULTS.trainingIsolation,
    ...(initialPolicyRef === undefined ? {} : { initialPolicyRef }),
  };
}

/**
 * §18: the learning signal default is track-dependent — `none` for
 * `frozen-llm`/`no-learning`, `self-supervised` for `self-supervised`,
 * `extrinsic-task` otherwise. A mixed pair (for example `scratch-rl` against
 * `no-learning`) has no signal that satisfies both, so the derived default is
 * deliberately the one that makes the incompatibility surface as a validation
 * error rather than a silently rewritten experiment.
 */
function defaultLearningSignal(
  tracks: readonly LearnerTrackId[],
): RunConfig['learningSignal'] {
  if (
    tracks.some((track) => track === 'frozen-llm' || track === 'no-learning')
  ) {
    return 'none';
  }
  if (tracks.some((track) => track === 'self-supervised')) {
    return 'self-supervised';
  }
  return RUN_CONFIG_DEFAULTS.learningSignal;
}

/**
 * Build a complete, validated `RunConfig` from the SPEC §18 defaults.
 *
 * Carrier-scoped bounds are populated only for the carrier they belong to
 * (§11.1), so the result never trips the cross-field rules above. Throws
 * {@link RunConfigValidationError} if the assembled configuration is invalid.
 */
export function buildRunConfig(overrides: RunConfigOverrides): RunConfig {
  const babyA = buildLearner(overrides.babyA);
  const babyB = buildLearner(overrides.babyB);
  const carrierMode = overrides.carrierMode ?? RUN_CONFIG_DEFAULTS.carrierMode;
  const anchorNetwork =
    overrides.anchorNetwork ?? RUN_CONFIG_DEFAULTS.anchorNetwork;

  const symbolInventorySize = hasSymbolInventory(carrierMode)
    ? (overrides.symbolInventorySize ??
      RUN_CONFIG_DEFAULTS.symbolInventorySize)
    : overrides.symbolInventorySize;
  const maxSymbolsPerMessage = hasSymbolInventory(carrierMode)
    ? (overrides.maxSymbolsPerMessage ??
      RUN_CONFIG_DEFAULTS.maxSymbolsPerMessage)
    : overrides.maxSymbolsPerMessage;
  const maxStrokes =
    carrierMode === 'generative-canvas'
      ? (overrides.maxStrokes ?? RUN_CONFIG_DEFAULTS.maxStrokes)
      : overrides.maxStrokes;
  const finalityPolicy =
    overrides.finalityPolicy ??
    (anchorNetwork === 'base-mainnet'
      ? MAINNET_FINALITY_POLICY
      : RUN_CONFIG_DEFAULTS.finalityPolicy);

  const candidate: RunConfig = {
    version: 1,
    runId: overrides.runId,
    experimentId: overrides.experimentId,
    randomSeed: overrides.randomSeed,
    ...(overrides.parentRunId === undefined
      ? {}
      : { parentRunId: overrides.parentRunId }),
    ...(overrides.derivedFromCheckpointHash === undefined
      ? {}
      : { derivedFromCheckpointHash: overrides.derivedFromCheckpointHash }),
    deploymentMode:
      overrides.deploymentMode ?? RUN_CONFIG_DEFAULTS.deploymentMode,
    babyA,
    babyB,
    symmetricTracks:
      overrides.symmetricTracks ?? babyA.track === babyB.track,
    learningSignal:
      overrides.learningSignal ??
      defaultLearningSignal([babyA.track, babyB.track]),
    communicationCondition:
      overrides.communicationCondition ??
      RUN_CONFIG_DEFAULTS.communicationCondition,
    interactionMode:
      overrides.interactionMode ?? RUN_CONFIG_DEFAULTS.interactionMode,
    carrierMode,
    ...(symbolInventorySize === undefined ? {} : { symbolInventorySize }),
    ...(maxSymbolsPerMessage === undefined ? {} : { maxSymbolsPerMessage }),
    ...(maxStrokes === undefined ? {} : { maxStrokes }),
    affectMode: overrides.affectMode ?? RUN_CONFIG_DEFAULTS.affectMode,
    affectWindowSchedule:
      overrides.affectWindowSchedule ??
      RUN_CONFIG_DEFAULTS.affectWindowSchedule,
    observationEncoding:
      overrides.observationEncoding ??
      RUN_CONFIG_DEFAULTS.observationEncoding,
    roleReversalPeriod:
      overrides.roleReversalPeriod ?? RUN_CONFIG_DEFAULTS.roleReversalPeriod,
    turnResponseBudgetMs:
      overrides.turnResponseBudgetMs ??
      RUN_CONFIG_DEFAULTS.turnResponseBudgetMs,
    maxTurnsPerRun:
      overrides.maxTurnsPerRun ?? RUN_CONFIG_DEFAULTS.maxTurnsPerRun,
    ...(overrides.evaluationTurns === undefined
      ? {}
      : { evaluationTurns: overrides.evaluationTurns }),
    maxConsecutiveRejections:
      overrides.maxConsecutiveRejections ??
      RUN_CONFIG_DEFAULTS.maxConsecutiveRejections,
    ledgerLagTurns:
      overrides.ledgerLagTurns ?? RUN_CONFIG_DEFAULTS.ledgerLagTurns,
    curriculumMode:
      overrides.curriculumMode ?? RUN_CONFIG_DEFAULTS.curriculumMode,
    cipherThreatModel:
      overrides.cipherThreatModel ?? RUN_CONFIG_DEFAULTS.cipherThreatModel,
    interventionSuiteThreshold:
      overrides.interventionSuiteThreshold ??
      RUN_CONFIG_DEFAULTS.interventionSuiteThreshold,
    evaluationSeeds:
      overrides.evaluationSeeds ?? RUN_CONFIG_DEFAULTS.evaluationSeeds,
    checkpointEventInterval:
      overrides.checkpointEventInterval ??
      RUN_CONFIG_DEFAULTS.checkpointEventInterval,
    checkpointTimeIntervalMs:
      overrides.checkpointTimeIntervalMs ??
      RUN_CONFIG_DEFAULTS.checkpointTimeIntervalMs,
    anchorNetwork,
    finalityPolicy,
    prototypeRetentionDays:
      overrides.prototypeRetentionDays ??
      RUN_CONFIG_DEFAULTS.prototypeRetentionDays,
    scenarioBundleHash:
      overrides.scenarioBundleHash ?? RUN_CONFIG_DEFAULTS.placeholderHash,
    promptBundleHash:
      overrides.promptBundleHash ?? RUN_CONFIG_DEFAULTS.placeholderHash,
    protocolGitCommit:
      overrides.protocolGitCommit ?? RUN_CONFIG_DEFAULTS.protocolGitCommit,
    preRegistrationHash:
      overrides.preRegistrationHash ?? RUN_CONFIG_DEFAULTS.placeholderHash,
    ...(overrides.registrationClass === undefined
      ? {}
      : { registrationClass: overrides.registrationClass }),
    ...(overrides.interventionPlan === undefined
      ? {}
      : { interventionPlan: overrides.interventionPlan }),
    ...(overrides.glyphBundleHash === undefined
      ? {}
      : { glyphBundleHash: overrides.glyphBundleHash }),
    ...(overrides.affectDerivedMapping === undefined
      ? {}
      : { affectDerivedMapping: overrides.affectDerivedMapping }),
  };

  return assertValidRunConfig(candidate).config;
}
