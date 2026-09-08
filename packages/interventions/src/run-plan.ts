/**
 * The single configuration-driven entry point for every intervention this
 * package supports — BACKLOG ALD-072 acceptance criterion 1:
 *
 * > An intervention defined in a pre-registration reference (`ALD-071`) can be
 * > toggled on/off for a run via configuration, with no code change per
 * > intervention.
 *
 * {@link buildInterventionRunPlan} reads *only* `RunConfig` (its
 * `interventionPlan`, `interventionSuiteThreshold`, `maxSymbolsPerMessage`,
 * `maxTurnsPerRun`, `roleReversalPeriod`, `curriculumMode`, `randomSeed`) plus
 * the run's ledgers and inventory, and returns every scheduled intervention
 * the runtime has to apply. Adding a probe kind, a repair turn, a held-out
 * split, a curriculum, or a drift-evaluation cadence to a run is therefore a
 * change to the hashed configuration and to nothing else; the call site in the
 * runtime is identical for every combination. That is exactly what the
 * acceptance criterion asks for, and the table test in
 * `__tests__/interventions.test.ts` walks the toggle combinations through the
 * planner to demonstrate it.
 *
 * Seed derivation: the planner runs inside the Nursery trust zone (SPEC §4.2)
 * and may read `RunConfig.randomSeed`, but a probe schedule ends up in a
 * public bundle attachment, so the default planner seed is the one-way
 * derivation `deriveSeedHex(PROBE_SEED_DOMAIN, runId, randomSeed)` rather than
 * the run seed itself. The derivation is implementation-defined and belongs in
 * BACKLOG §15; a caller that pre-registered its own analysis seed passes
 * `seed` instead.
 */
import { deriveSeedHex } from '@ald/hashing';
import type { BabyRole, LedgerEvent, RunConfig } from '@ald/types';

import { CurriculumExecutor } from './curriculum.js';
import { InterventionError } from './errors.js';
import {
  planEvaluationProbes,
  type ProbeSchedule,
} from './plan.js';

/**
 * Implementation-defined domain for the derived analysis seed (see the module
 * comment). It is not a hash domain of an evidence artifact, so it lives here
 * rather than in `HASH_DOMAINS`.
 */
export const PROBE_SEED_DOMAIN = 'dtsf-intervention-probe-seed-v1';

export interface InterventionToggleState {
  readonly evaluationSuite: boolean;
  readonly ablation: boolean;
  readonly substitution: boolean;
  readonly scramblingControl: boolean;
  readonly repair: boolean;
  readonly heldOutTypeCodes: boolean;
  readonly curriculum: boolean;
  readonly driftEvaluation: boolean;
}

export interface InterventionRunPlan {
  readonly runId: string;
  readonly experimentId: string;
  /** Where every switch came from; a constant, recorded as data. */
  readonly configurationBasis: 'run-config-intervention-plan';
  readonly planPresent: boolean;
  readonly enabled: InterventionToggleState;
  readonly seed: string;
  /** `RunConfig.interventionSuiteThreshold` (SPEC §18, default 0.70). */
  readonly threshold: number;
  readonly probeShare: number;
  readonly probeSchedule: ProbeSchedule;
  /** E14: the bounded extra turn, or `null` when not pre-registered. */
  readonly repair: { readonly enabled: boolean; readonly maxExtraTurns: 1 } | null;
  /** E15: type codes withheld from training. */
  readonly heldOutTypeCodes: readonly number[];
  /** E22: the staged executor, or `null` when no curriculum is registered. */
  readonly curriculum: CurriculumExecutor | null;
  /** E31: turns at which a frozen drift evaluation is scheduled. */
  readonly driftEvaluationTurns: readonly number[];
  /**
   * SPEC §15.2: the scrambling control is an offline re-analysis and is never
   * applied to a live delivery, whatever the toggle says.
   */
  readonly scramblingControl: {
    readonly enabled: boolean;
    readonly appliesTo: 'offline-analysis-only';
  };
}

export interface InterventionRunPlanInput {
  readonly config: RunConfig;
  /** Evaluation-phase turn numbers, strictly increasing. */
  readonly evaluationTurns: readonly number[];
  readonly ledgers: {
    readonly babyA: readonly LedgerEvent[];
    readonly babyB: readonly LedgerEvent[];
  };
  readonly policies?: {
    readonly babyA?: unknown;
    readonly babyB?: unknown;
  };
  readonly symbolInventory: readonly string[];
  /** Overrides the derived analysis seed. */
  readonly seed?: string;
  readonly receiverForTurn?: (turn: number) => BabyRole;
  readonly messageLength?: number;
}

/**
 * E31 frozen-evaluation turns: every multiple of `driftEvaluationInterval`
 * inside the training phase. Turn 0 is excluded (there is nothing to compare
 * an initial-state evaluation against inside the same run), and the last turn
 * of the phase is excluded because the run's own evaluation phase follows it.
 */
export function driftEvaluationTurns(
  interval: number | undefined,
  maxTurnsPerRun: number,
): number[] {
  if (interval === undefined) {
    return [];
  }
  if (!Number.isInteger(interval) || interval < 1) {
    throw new InterventionError(
      'invalid-plan',
      'driftEvaluationInterval must be a positive integer',
    );
  }
  const turns: number[] = [];
  for (let turn = interval; turn < maxTurnsPerRun; turn += interval) {
    turns.push(turn);
  }
  return turns;
}

/** Derived analysis seed for one run (see the module comment). */
export function deriveInterventionSeed(config: RunConfig): string {
  return deriveSeedHex(PROBE_SEED_DOMAIN, config.runId, config.randomSeed);
}

/**
 * Assemble every intervention a run's configuration asks for.
 *
 * The function never inspects an outcome, so it is safe to call before the
 * evaluation phase begins — which E16 requires, since the probe schedule must
 * be fixed before outcomes are seen.
 */
export function buildInterventionRunPlan(
  input: InterventionRunPlanInput,
): InterventionRunPlan {
  const { config } = input;
  const plan = config.interventionPlan;
  const suite = plan?.evaluationSuite;
  const seed = input.seed ?? deriveInterventionSeed(config);

  const probeSchedule = planEvaluationProbes({
    plan,
    evaluationTurns: input.evaluationTurns,
    ledgers: input.ledgers,
    ...(input.policies === undefined ? {} : { policies: input.policies }),
    symbolInventory: input.symbolInventory,
    seed,
    roleReversalPeriod: config.roleReversalPeriod,
    ...(input.receiverForTurn === undefined
      ? {}
      : { receiverForTurn: input.receiverForTurn }),
    ...(input.messageLength === undefined
      ? {}
      : { messageLength: input.messageLength }),
  });

  return {
    runId: config.runId,
    experimentId: config.experimentId,
    configurationBasis: 'run-config-intervention-plan',
    planPresent: plan !== undefined,
    enabled: {
      evaluationSuite: suite !== undefined,
      ablation: suite?.ablation === true,
      substitution: suite?.substitution === true,
      scramblingControl: suite?.scramblingControl === true,
      repair: plan?.repair?.enabled === true,
      heldOutTypeCodes: (plan?.heldOutTypeCodes ?? []).length > 0,
      curriculum: plan?.curriculum !== undefined,
      driftEvaluation: plan?.driftEvaluationInterval !== undefined,
    },
    seed,
    threshold: config.interventionSuiteThreshold,
    probeShare: suite?.probeShare ?? 0,
    probeSchedule,
    repair:
      plan?.repair === undefined
        ? null
        : { enabled: plan.repair.enabled, maxExtraTurns: plan.repair.maxExtraTurns },
    heldOutTypeCodes: [...(plan?.heldOutTypeCodes ?? [])],
    curriculum: CurriculumExecutor.fromRunConfig(config),
    driftEvaluationTurns: driftEvaluationTurns(
      plan?.driftEvaluationInterval,
      config.maxTurnsPerRun,
    ),
    scramblingControl: {
      enabled: suite?.scramblingControl === true,
      appliesTo: 'offline-analysis-only',
    },
  };
}
