/**
 * E22 staged-curriculum executor (EXPERIMENT-NOTEBOOK.md E22; SPEC §18
 * `curriculumMode: fixed-schedule`, `CurriculumStageSchema` in `@ald/types`;
 * BACKLOG ALD-072, ALD-075 acceptance criterion 3 — "`ALD-072`'s scaffold
 * supports a staged/curriculum sequence of interventions within a single
 * run").
 *
 * E22's procedure is what this module enforces and records:
 *
 * - "Pre-register every schedule" — the stages come from
 *   `RunConfig.interventionPlan.curriculum.stages`, which is inside the
 *   hashed run configuration, so a curriculum is a configuration change and
 *   never a code change (ALD-072 acceptance criterion 1);
 * - "Define competence gates without age labels" — a stage is keyed by
 *   `startTurn` only; this module has no notion of age, and
 *   `curriculumMode: 'adaptive-guided'` (which would let a schedule react to
 *   performance) is rejected here rather than silently treated as fixed,
 *   because SPEC §18 requires an adaptive curriculum to be labeled;
 * - "Prevent adaptive BabySitter teaching" — `stageForTurn` is a pure
 *   function of the turn index, so nothing about a run's outcomes can move a
 *   transition;
 * - "Record exact transition points and policy hashes" —
 *   {@link CurriculumTransition} carries `policyHashBefore`/`policyHashAfter`
 *   for the runtime to fill from `exportPolicy()` around the
 *   `applyCurriculumStage` call, and {@link curriculumTransitionsAttachment}
 *   packages the log as the `curriculum-transitions` bundle attachment.
 *
 * A stage whose knob the target adapter cannot honour is rejected *before the
 * run starts* by {@link assertStagesSupported}, mirroring the adapter-side
 * rule that an adapter must reject a knob it cannot apply rather than ignore
 * it (SPEC §6.2 note on `applyCurriculumStage`).
 */
import type { CurriculumStage, InterventionPlan, RunConfig } from '@ald/types';

import { buildAttachment, type AttachmentFile } from './attachment.js';
import { InterventionError } from './errors.js';

/** Analysis version of the `curriculum-transitions` attachment. */
export const CURRICULUM_TRANSITIONS_VERSION = 'curriculum-transitions/v1';

/** SPEC §9.1 hard ceiling on marks per message, whatever a stage asks for. */
export const MAX_SYMBOLS_PER_MESSAGE_CEILING = 16;

/** Knobs a `CurriculumStage` can carry (`CurriculumStageSchema`). */
export const CURRICULUM_KNOBS = [
  'learningRate',
  'temperature',
  'explorationRate',
  'memoryCapacity',
  'maxSymbolsPerMessage',
  'consolidation',
] as const;

export type CurriculumKnob = (typeof CURRICULUM_KNOBS)[number];

/** Which knobs a target adapter declares it can apply. */
export type CurriculumCapabilities = Readonly<
  Partial<Record<CurriculumKnob, boolean>>
>;

export interface CurriculumTransition {
  readonly stageIndex: number;
  /** Turn at which the stage becomes active (`stage.startTurn`). */
  readonly turn: number;
  readonly stage: CurriculumStage;
  /** `exportPolicy()` hash before `applyCurriculumStage`; runtime-filled. */
  readonly policyHashBefore?: string;
  /** `exportPolicy()` hash after `applyCurriculumStage`; runtime-filled. */
  readonly policyHashAfter?: string;
}

export interface CurriculumValidationInput {
  readonly stages: readonly CurriculumStage[];
  /** The run's own per-message ceiling; a stage may lower it, never raise it. */
  readonly maxSymbolsPerMessage?: number;
  readonly maxTurnsPerRun?: number;
}

/**
 * Validate a stage list against SPEC §18 and E22:
 *
 * 1. at least one stage, and the first starts at turn 0 — a run must have a
 *    defined configuration from its first turn;
 * 2. `startTurn` strictly increasing, so `stageForTurn` is single-valued;
 * 3. `stageIndex` equal to the position in the list, because transitions and
 *    the attachment identify a stage by that index;
 * 4. `maxSymbolsPerMessage` at or below both the run's configured value and
 *    the §9.1 ceiling of 16 — staged bandwidth may narrow the channel, never
 *    widen it beyond what was pre-registered;
 * 5. every `startTurn` inside `maxTurnsPerRun` when it is given, so a
 *    schedule cannot silently contain a stage the run never reaches.
 */
export function validateCurriculumStages(
  input: CurriculumValidationInput,
): readonly CurriculumStage[] {
  const { stages } = input;
  if (stages.length === 0) {
    throw new InterventionError(
      'invalid-curriculum',
      'a curriculum must declare at least one stage',
    );
  }
  const first = stages[0] as CurriculumStage;
  if (first.startTurn !== 0) {
    throw new InterventionError(
      'invalid-curriculum',
      'the first curriculum stage must start at turn 0',
    );
  }
  const ceiling = Math.min(
    input.maxSymbolsPerMessage ?? MAX_SYMBOLS_PER_MESSAGE_CEILING,
    MAX_SYMBOLS_PER_MESSAGE_CEILING,
  );
  let previousTurn = -1;
  stages.forEach((stage, index) => {
    if (stage.stageIndex !== index) {
      throw new InterventionError(
        'invalid-curriculum',
        `stage at position ${index} declares stageIndex ${stage.stageIndex}`,
      );
    }
    if (stage.startTurn <= previousTurn) {
      throw new InterventionError(
        'invalid-curriculum',
        'curriculum stages must have strictly increasing startTurn',
      );
    }
    previousTurn = stage.startTurn;
    if (
      stage.maxSymbolsPerMessage !== undefined &&
      stage.maxSymbolsPerMessage > ceiling
    ) {
      throw new InterventionError(
        'invalid-curriculum',
        `stage ${index} raises maxSymbolsPerMessage to ${stage.maxSymbolsPerMessage} above the run ceiling ${ceiling}`,
      );
    }
    if (
      input.maxTurnsPerRun !== undefined &&
      stage.startTurn >= input.maxTurnsPerRun
    ) {
      throw new InterventionError(
        'invalid-curriculum',
        `stage ${index} starts at turn ${stage.startTurn}, at or beyond maxTurnsPerRun ${input.maxTurnsPerRun}`,
      );
    }
  });
  return stages;
}

/** Knobs a stage actually sets, in `CURRICULUM_KNOBS` order. */
export function knobsOf(stage: CurriculumStage): CurriculumKnob[] {
  const options = stage.learnerOptions ?? {};
  return CURRICULUM_KNOBS.filter((knob) => {
    if (knob === 'maxSymbolsPerMessage') {
      return stage.maxSymbolsPerMessage !== undefined;
    }
    if (knob === 'consolidation') {
      return stage.consolidation !== undefined;
    }
    return options[knob] !== undefined;
  });
}

/**
 * Reject a schedule whose stages set knobs the target adapter declared it
 * cannot apply. SPEC §6.2 requires the adapter itself to reject such a stage
 * at run time; checking it here means a pre-registered schedule fails before
 * a run consumes turns, with the offending stage and knob named.
 */
export function assertStagesSupported(
  stages: readonly CurriculumStage[],
  capabilities: CurriculumCapabilities,
): void {
  stages.forEach((stage, index) => {
    for (const knob of knobsOf(stage)) {
      if (capabilities[knob] !== true) {
        throw new InterventionError(
          'unsupported-curriculum-knob',
          `stage ${index} sets ${knob}, which the adapter does not support`,
        );
      }
    }
  });
}

/**
 * The staged executor. Construction validates the schedule, so an instance
 * always describes a schedule the run may legally follow.
 */
export class CurriculumExecutor {
  readonly stages: readonly CurriculumStage[];

  constructor(input: CurriculumValidationInput) {
    this.stages = validateCurriculumStages(input);
  }

  /** Build an executor from a run configuration, or `null` when it has none. */
  static fromRunConfig(config: RunConfig): CurriculumExecutor | null {
    const stages = config.interventionPlan?.curriculum?.stages;
    if (stages === undefined) {
      return null;
    }
    if (config.curriculumMode !== 'fixed-schedule') {
      // SPEC §18: `adaptive-guided` "must be labeled"; executing it as if it
      // were a fixed schedule would drop that label silently.
      throw new InterventionError(
        'invalid-curriculum',
        `curriculumMode ${config.curriculumMode} is not executable by the fixed-schedule executor`,
      );
    }
    return new CurriculumExecutor({
      stages,
      ...(config.maxSymbolsPerMessage === undefined
        ? {}
        : { maxSymbolsPerMessage: config.maxSymbolsPerMessage }),
      maxTurnsPerRun: config.maxTurnsPerRun,
    });
  }

  /** Build an executor from a bare plan (no run configuration available). */
  static fromPlan(
    plan: InterventionPlan | undefined,
    options: Omit<CurriculumValidationInput, 'stages'> = {},
  ): CurriculumExecutor | null {
    const stages = plan?.curriculum?.stages;
    return stages === undefined
      ? null
      : new CurriculumExecutor({ stages, ...options });
  }

  /** The stage active at `turn`: the last one whose `startTurn` is at most it. */
  stageForTurn(turn: number): { stageIndex: number; stage: CurriculumStage } {
    if (!Number.isInteger(turn) || turn < 0) {
      throw new InterventionError(
        'invalid-input',
        'turn must be a non-negative integer',
      );
    }
    let active = this.stages[0] as CurriculumStage;
    for (const stage of this.stages) {
      if (stage.startTurn <= turn) {
        active = stage;
      } else {
        break;
      }
    }
    return { stageIndex: active.stageIndex, stage: active };
  }

  /**
   * Transitions the runtime must apply when advancing from `fromTurn` to
   * `toTurn`: every stage whose `startTurn` is in `(fromTurn, toTurn]`.
   *
   * The lower bound is exclusive and the upper inclusive, so a run starts by
   * calling `transitionsBetween(-1, 0)` (which returns the turn-0 stage) and
   * then `transitionsBetween(previousTurn, turn)` before each later turn.
   * Ranges never overlap and never skip a stage, however large the step.
   */
  transitionsBetween(fromTurn: number, toTurn: number): CurriculumTransition[] {
    if (!Number.isInteger(fromTurn) || fromTurn < -1) {
      throw new InterventionError(
        'invalid-input',
        'fromTurn must be an integer of at least -1',
      );
    }
    if (!Number.isInteger(toTurn) || toTurn < fromTurn) {
      throw new InterventionError(
        'invalid-input',
        'toTurn must be an integer at or after fromTurn',
      );
    }
    return this.stages
      .filter((stage) => stage.startTurn > fromTurn && stage.startTurn <= toTurn)
      .map((stage) => ({
        stageIndex: stage.stageIndex,
        turn: stage.startTurn,
        stage,
      }));
  }

  /**
   * E22 "consolidation intervals": true while the active stage forbids policy
   * updates. The runtime must skip `updatePolicy` for these turns; this is the
   * predicate it asks.
   */
  consolidating(turn: number): boolean {
    return this.stageForTurn(turn).stage.consolidation === true;
  }

  /** The per-message mark ceiling in force at `turn`, when a stage sets one. */
  maxSymbolsPerMessageAt(turn: number): number | null {
    return this.stageForTurn(turn).stage.maxSymbolsPerMessage ?? null;
  }

  /** Every transition of a whole run, for pre-run inspection. */
  plannedTransitions(maxTurnsPerRun: number): CurriculumTransition[] {
    return this.transitionsBetween(-1, Math.max(0, maxTurnsPerRun - 1));
  }
}

export interface CurriculumTransitionLog {
  readonly analysisVersion: string;
  readonly runId: string;
  readonly curriculumMode: RunConfig['curriculumMode'];
  readonly stages: number;
  readonly transitions: readonly CurriculumTransition[];
  readonly claimBoundary: 'software-readiness-only';
}

/**
 * Package the applied transitions as the `curriculum-transitions` bundle
 * attachment. The runtime supplies the transitions it actually applied,
 * including the policy hashes it observed around each `applyCurriculumStage`
 * call (E22 "Record exact transition points and policy hashes").
 */
export function curriculumTransitionsAttachment(input: {
  readonly runId: string;
  readonly curriculumMode: RunConfig['curriculumMode'];
  readonly stages: number;
  readonly transitions: readonly CurriculumTransition[];
}): AttachmentFile {
  const log: CurriculumTransitionLog = {
    analysisVersion: CURRICULUM_TRANSITIONS_VERSION,
    runId: input.runId,
    curriculumMode: input.curriculumMode,
    stages: input.stages,
    transitions: input.transitions,
    claimBoundary: 'software-readiness-only',
  };
  return buildAttachment({
    kind: 'curriculum-transitions',
    analysisVersion: CURRICULUM_TRANSITIONS_VERSION,
    value: log,
  });
}
