/**
 * The SPEC §15.2 causal-probe planner (BACKLOG ALD-072, ALD-074 acceptance
 * criterion 3 for E16).
 *
 * §15.2 makes two of the three suite tests live interventions on a delivery:
 *
 * | Test | Procedure | Pass criterion (default) |
 * |---|---|---|
 * | Ablation | Drop a symbol/stroke-feature the ledger claims is meaningful | Receiver behavior changes in the ledger-predicted direction |
 * | Substitution | Swap a symbol for another in-inventory symbol | Receiver behavior shifts toward the substituted symbol's ledger-claimed meaning |
 *
 * (the third, scrambling, is offline only and lives in `scrambling.ts`).
 *
 * This module turns a pre-registered `InterventionPlan` (SPEC §18,
 * `RunConfig.interventionPlan`) plus the Babies' own ledgers into an ordered
 * `ProbeSchedule`: which evaluation turns carry a probe, which
 * `ArtifactProbe` each one applies, and — recorded *with* the probe, before
 * any outcome exists — the direction the ledger predicts the receiver's
 * behaviour will move in. E16's procedure requires exactly that order:
 * "Select ledger hypotheses before viewing intervention outcomes." The
 * planner therefore reads claims (`claims.ts`) and never an outcome, a
 * reward, or a success flag; `evaluateInterventionSuite` in `suite.ts` is the
 * only place observed behaviour enters.
 *
 * Determinism: which turns are probed and every tie-break come from a
 * `SeededPrng` derived from the caller's seed, so a schedule replays
 * bit-for-bit from the recorded seed manifest (SPEC §14.3) and
 * `hashProbe` is stable across processes.
 *
 * No intervention is hard-coded here: `plan.evaluationSuite.{ablation,
 * substitution,probeShare}` are the only switches, and they are part of the
 * hashed `RunConfig`, so turning a probe kind on or off is a pre-registered
 * configuration change and never a code change (ALD-072 acceptance
 * criterion 1).
 */
import { hashCanonical, SeededPrng } from '@ald/hashing';
import {
  HASH_DOMAINS,
  type ArtifactProbe,
  type BabyRole,
  type InterventionPlan,
  type LedgerEvent,
  type Sha256Hash,
} from '@ald/types';

import {
  indexLedgerClaims,
  type LedgerClaimIndex,
  type LedgerFormClaim,
} from './claims.js';
import {
  InterventionError,
  assertNonEmptyString,
  assertTurnList,
} from './errors.js';
import { readPolicyFormClaims, type PolicyFormClaims } from './policy-claims.js';

/** Version of the schedule structure and of the selection rules below. */
export const PROBE_SCHEDULE_VERSION = 'intervention-probe-schedule/v1';

/**
 * Version of the ledger-to-prediction function (RESEARCH.md §6.8): the rule
 * that turns a ledger claim plus a probe into a directional prediction
 * *without* observing the outcome. It is recorded with every prediction so a
 * re-analysis can tell which rule produced it.
 */
export const LEDGER_PREDICTION_FUNCTION_VERSION =
  'ledger-direction:claimed-type-code:v1';

/** Probe kinds in the fixed order the planner alternates through. */
export const PROBE_KINDS = ['ablation', 'substitution'] as const;

export type ProbeKind = (typeof PROBE_KINDS)[number];

export type ProbeShortfallCode =
  /** `plan.evaluationSuite` is absent: the run pre-registered no live probes. */
  | 'suite-absent'
  /** Both probe kinds are switched off in the plan. */
  | 'no-probe-kind-enabled'
  /** `probeShare` is 0: pre-registered as an unprobed evaluation phase. */
  | 'probe-share-zero'
  /** No ledger claim was available to target. */
  | 'no-ledger-claim'
  /** No second claim with a different meaning existed for a substitution. */
  | 'no-substitute-with-distinct-claim'
  /** The substitute a claim named is not in the run's inventory. */
  | 'substitute-not-in-inventory';

/**
 * How the probe position was chosen. `ledger-observed` means the ledger's own
 * `intention.recorded`/`interpretation.recorded` events put the form at that
 * position; `default-first` means the ledger recorded no message for the form
 * and the planner fell back to position 0. The distinction is recorded
 * because a `default-first` probe tests a weaker claim.
 */
export type ProbePositionBasis = 'ledger-observed' | 'default-first';

export interface PredictedCandidateShift {
  /**
   * `away-from-type-code` (ablation): removing the mark should move the
   * receiver off candidates of the claimed type code.
   * `toward-type-code` (substitution): the receiver should move toward
   * candidates of the substitute's claimed type code.
   */
  readonly kind: 'away-from-type-code' | 'toward-type-code';
  /** The type code the receiver is predicted to move toward, if any. */
  readonly towardTypeCode: number | null;
  /** The type code the receiver is predicted to move away from, if any. */
  readonly awayFromTypeCode: number | null;
}

export interface LedgerPredictedDirection {
  /** The ledger hypothesis under test (SPEC §15.2, `ArtifactProbe.hypothesisRef`). */
  readonly hypothesisRef: string;
  /** SPEC §11.4: the prediction comes from agent-native state, not an audit gloss. */
  readonly predictedBy: 'agent-native-ledger';
  readonly predictionFunctionVersion: string;
  readonly claimedTypeCode: number;
  readonly claimedConfidence: number;
  readonly predictedCandidateShift: PredictedCandidateShift;
  /**
   * Optional consistency check of the same claim against the Baby's own
   * exported policy. `null` when no policy was supplied or its shape is not
   * one this module can read. It is a diagnostic, never part of the
   * prediction (SPEC §15.2 validates ledgers behaviourally).
   */
  readonly policyConsistency: PolicyFormClaims | null;
}

export interface PlannedProbe {
  readonly turn: number;
  /** The Baby that receives the perturbed delivery on this turn. */
  readonly receiver: BabyRole;
  /**
   * The form the probe removes or replaces. Recorded next to the probe
   * because the offline scrambling control (`scrambling.ts`) has to re-derive
   * the prediction under a shuffled form-to-meaning map, and `ArtifactProbe`
   * itself carries only the position.
   */
  readonly targetForm: string;
  /** The in-inventory form delivered instead; `null` for an ablation. */
  readonly substituteForm: string | null;
  readonly probe: ArtifactProbe;
  /** `hashProbe(probe)`; the value `TurnRecord.probeHash` records. */
  readonly probeHash: Sha256Hash;
  readonly kind: ProbeKind;
  readonly positionBasis: ProbePositionBasis;
  readonly predictedDirection: LedgerPredictedDirection;
}

export interface ProbeSchedule {
  readonly scheduleVersion: string;
  /** Fixes the order of operations E16 requires; a constant, recorded as data. */
  readonly selectionBasis: 'ledger-claims-selected-before-outcomes';
  readonly seed: string;
  readonly probeShare: number;
  readonly evaluationTurns: readonly number[];
  /** Turns the planner intended to probe, before per-turn shortfalls. */
  readonly targetProbeCount: number;
  readonly probes: readonly PlannedProbe[];
  /** Evaluation turns with no probe: the within-run unprobed baseline. */
  readonly baselineTurns: readonly number[];
  /** Why the schedule carries fewer probes than `targetProbeCount`. */
  readonly shortfalls: readonly {
    readonly turn: number;
    readonly code: ProbeShortfallCode;
  }[];
  readonly enabledKinds: readonly ProbeKind[];
  readonly claimsConsidered: number;
}

export interface ProbePlanInput {
  /** `RunConfig.interventionPlan`; `undefined` yields an empty schedule. */
  readonly plan?: InterventionPlan | undefined;
  /** Turn numbers of the evaluation phase, strictly increasing. */
  readonly evaluationTurns: readonly number[];
  /** Each Baby's own ledger events, as far as they exist when planning runs. */
  readonly ledgers: {
    readonly babyA: readonly LedgerEvent[];
    readonly babyB: readonly LedgerEvent[];
  };
  /** Each Baby's `exportPolicy()` output, for the optional consistency check. */
  readonly policies?: {
    readonly babyA?: unknown;
    readonly babyB?: unknown;
  };
  /** The run's declared inventory (SPEC §9.1); substitutes must be in it. */
  readonly symbolInventory: readonly string[];
  readonly seed: string;
  /** SPEC §18 `roleReversalPeriod`; used by the default `receiverForTurn`. */
  readonly roleReversalPeriod?: number;
  /** Override the role schedule when the runtime uses a different one. */
  readonly receiverForTurn?: (turn: number) => BabyRole;
  /** Marks per delivered message; defaults to what the ledgers recorded. */
  readonly messageLength?: number;
}

/** Canonical probe hash (`HASH_DOMAINS.causalProbe`; `TurnRecord.probeHash`). */
export function hashProbe(probe: ArtifactProbe): Sha256Hash {
  return hashCanonical(HASH_DOMAINS.causalProbe, probe);
}

/**
 * SPEC §8.1 step 9 role schedule, mirrored from the Nursery runtime's
 * `senderForTurn`: `baby-a` sends while `floor(turn / period)` is even, so the
 * receiver is the other Baby. Pass `receiverForTurn` to override.
 */
export function receiverForTurn(
  turn: number,
  roleReversalPeriod: number,
): BabyRole {
  if (!Number.isInteger(roleReversalPeriod) || roleReversalPeriod < 1) {
    throw new InterventionError(
      'invalid-input',
      'roleReversalPeriod must be a positive integer',
    );
  }
  return Math.floor(turn / roleReversalPeriod) % 2 === 0 ? 'baby-b' : 'baby-a';
}

/** Contiguous evaluation turn numbers, the shape the runtime produces. */
export function evaluationTurnRange(
  firstEvaluationTurn: number,
  evaluationTurns: number,
): number[] {
  if (!Number.isInteger(firstEvaluationTurn) || firstEvaluationTurn < 0) {
    throw new InterventionError(
      'invalid-input',
      'firstEvaluationTurn must be a non-negative integer',
    );
  }
  if (!Number.isInteger(evaluationTurns) || evaluationTurns < 1) {
    throw new InterventionError(
      'invalid-input',
      'evaluationTurns must be a positive integer',
    );
  }
  return Array.from(
    { length: evaluationTurns },
    (_unused, index) => firstEvaluationTurn + index,
  );
}

/**
 * How many evaluation turns a `probeShare` buys.
 *
 * `round(share * n)`, clamped to `[0, n]`, with one documented exception: a
 * pre-registered non-zero share on a short evaluation phase always buys at
 * least one probe, because rounding a deliberately registered intervention
 * away to zero would silently drop it from the run (BACKLOG §15 decision).
 */
export function probeCountFor(probeShare: number, turns: number): number {
  if (!Number.isFinite(probeShare) || probeShare < 0 || probeShare > 1) {
    throw new InterventionError(
      'invalid-plan',
      'probeShare must be within [0, 1]',
    );
  }
  if (probeShare === 0 || turns === 0) {
    return 0;
  }
  return Math.min(turns, Math.max(1, Math.round(probeShare * turns)));
}

function claimPosition(
  claim: LedgerFormClaim,
  messageLength: number,
): { position: number; basis: ProbePositionBasis } {
  for (const entry of claim.positions) {
    if (entry.position < messageLength) {
      return { position: entry.position, basis: 'ledger-observed' };
    }
  }
  return { position: 0, basis: 'default-first' };
}

function emptySchedule(
  input: ProbePlanInput,
  probeShare: number,
  enabledKinds: readonly ProbeKind[],
  code: ProbeShortfallCode,
  claimsConsidered: number,
): ProbeSchedule {
  return {
    scheduleVersion: PROBE_SCHEDULE_VERSION,
    selectionBasis: 'ledger-claims-selected-before-outcomes',
    seed: input.seed,
    probeShare,
    evaluationTurns: [...input.evaluationTurns],
    targetProbeCount: 0,
    probes: [],
    baselineTurns: [...input.evaluationTurns],
    shortfalls: [{ turn: -1, code }],
    enabledKinds,
    claimsConsidered,
  };
}

/**
 * Build the ordered probe schedule for one run's evaluation phase.
 *
 * Selection rules, all fixed before any outcome exists:
 *
 * 1. `probeCountFor(probeShare, evaluationTurns.length)` turns are probed,
 *    drawn from the evaluation turns by a seeded shuffle and then sorted, so
 *    probes are spread over the phase without a systematic position.
 * 2. Probe kinds alternate through the enabled ones in `PROBE_KINDS` order,
 *    which balances ablation and substitution across the phase.
 * 3. The target claim rotates through the receiver's claims ranked by the
 *    Baby's own recorded confidence (`claims.ts`), so successive probes test
 *    successive hypotheses rather than the same one repeatedly. §15.2's
 *    "a symbol the ledger claims is meaningful" is the highest-confidence
 *    claim, which is where the rotation starts.
 * 4. A substitution needs a second in-inventory form whose ledger-claimed
 *    meaning differs from the target's; the highest-confidence such form is
 *    used. When none exists the turn falls back to an ablation, and the
 *    fallback is recorded in `shortfalls`.
 */
export function planEvaluationProbes(input: ProbePlanInput): ProbeSchedule {
  assertNonEmptyString(input.seed, 'seed');
  assertTurnList(input.evaluationTurns, 'evaluationTurns');
  if (input.symbolInventory.length === 0) {
    throw new InterventionError(
      'invalid-input',
      'symbolInventory must not be empty',
    );
  }
  const suite = input.plan?.evaluationSuite;
  const probeShare = suite?.probeShare ?? 0;
  const enabledKinds = PROBE_KINDS.filter((kind) =>
    kind === 'ablation' ? suite?.ablation === true : suite?.substitution === true,
  );

  const indexes: Record<BabyRole, LedgerClaimIndex> = {
    'baby-a': indexLedgerClaims(input.ledgers.babyA),
    'baby-b': indexLedgerClaims(input.ledgers.babyB),
  };
  const claimsConsidered =
    indexes['baby-a'].claims.length + indexes['baby-b'].claims.length;

  if (suite === undefined) {
    return emptySchedule(input, probeShare, enabledKinds, 'suite-absent', claimsConsidered);
  }
  if (enabledKinds.length === 0) {
    return emptySchedule(
      input,
      probeShare,
      enabledKinds,
      'no-probe-kind-enabled',
      claimsConsidered,
    );
  }
  const targetProbeCount = probeCountFor(
    probeShare,
    input.evaluationTurns.length,
  );
  if (targetProbeCount === 0) {
    return emptySchedule(
      input,
      probeShare,
      enabledKinds,
      'probe-share-zero',
      claimsConsidered,
    );
  }

  const prng = new SeededPrng(`${input.seed}/probe-schedule`);
  const probedTurns = prng
    .shuffle(input.evaluationTurns)
    .slice(0, targetProbeCount)
    .sort((left, right) => left - right);

  const roleFor =
    input.receiverForTurn ??
    ((turn: number) => receiverForTurn(turn, input.roleReversalPeriod ?? 1));

  const inventory = new Set(input.symbolInventory);
  const probes: PlannedProbe[] = [];
  const shortfalls: { turn: number; code: ProbeShortfallCode }[] = [];
  const rotation: Record<BabyRole, number> = { 'baby-a': 0, 'baby-b': 0 };

  probedTurns.forEach((turn, index) => {
    const receiver = roleFor(turn);
    const claims = indexes[receiver].claims;
    if (claims.length === 0) {
      shortfalls.push({ turn, code: 'no-ledger-claim' });
      return;
    }
    const target = claims[rotation[receiver] % claims.length] as LedgerFormClaim;
    rotation[receiver] += 1;

    const messageLength = Math.max(
      1,
      input.messageLength ?? indexes[receiver].observedMessageLength ?? 1,
    );
    const { position, basis } = claimPosition(target, messageLength);

    let kind = enabledKinds[index % enabledKinds.length] as ProbeKind;
    let substitute: LedgerFormClaim | undefined;
    if (kind === 'substitution') {
      substitute = claims.find(
        (claim) =>
          claim.form !== target.form &&
          claim.claimedTypeCode !== target.claimedTypeCode &&
          inventory.has(claim.form),
      );
      if (substitute === undefined) {
        const distinct = claims.find(
          (claim) =>
            claim.form !== target.form &&
            claim.claimedTypeCode !== target.claimedTypeCode,
        );
        shortfalls.push({
          turn,
          code:
            distinct === undefined
              ? 'no-substitute-with-distinct-claim'
              : 'substitute-not-in-inventory',
        });
        if (!enabledKinds.includes('ablation')) {
          return;
        }
        kind = 'ablation';
      }
    }

    const probe: ArtifactProbe = {
      probeId: `probe:t${turn}:${kind}`,
      kind,
      position,
      ...(kind === 'substitution' && substitute !== undefined
        ? { substitute: substitute.form }
        : {}),
      hypothesisRef: target.hypothesisRef,
    };

    const shift: PredictedCandidateShift =
      kind === 'ablation' || substitute === undefined
        ? {
            kind: 'away-from-type-code',
            towardTypeCode: null,
            awayFromTypeCode: target.claimedTypeCode,
          }
        : {
            kind: 'toward-type-code',
            towardTypeCode: substitute.claimedTypeCode,
            awayFromTypeCode: target.claimedTypeCode,
          };

    probes.push({
      turn,
      receiver,
      targetForm: target.form,
      substituteForm: substitute?.form ?? null,
      probe,
      probeHash: hashProbe(probe),
      kind,
      positionBasis: basis,
      predictedDirection: {
        hypothesisRef: target.hypothesisRef,
        predictedBy: 'agent-native-ledger',
        predictionFunctionVersion: LEDGER_PREDICTION_FUNCTION_VERSION,
        claimedTypeCode: target.claimedTypeCode,
        claimedConfidence: target.confidence,
        predictedCandidateShift: shift,
        policyConsistency: readPolicyFormClaims({
          policy:
            receiver === 'baby-a'
              ? input.policies?.babyA
              : input.policies?.babyB,
          form: target.form,
          claimedTypeCode: target.claimedTypeCode,
          symbolInventory: input.symbolInventory,
        }),
      },
    });
  });

  const probedSet = new Set(probes.map((probe) => probe.turn));
  return {
    scheduleVersion: PROBE_SCHEDULE_VERSION,
    selectionBasis: 'ledger-claims-selected-before-outcomes',
    seed: input.seed,
    probeShare,
    evaluationTurns: [...input.evaluationTurns],
    targetProbeCount,
    probes,
    baselineTurns: input.evaluationTurns.filter((turn) => !probedSet.has(turn)),
    shortfalls,
    enabledKinds,
    claimsConsidered,
  };
}
