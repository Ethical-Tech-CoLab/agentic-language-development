/**
 * Pure affect-window helpers the reference adapters call when
 * `TurnBudget.window` is set (SPECIFICATION.md §9.3, §6.2 `measureAffect`;
 * ALD-033; EXPERIMENT-NOTEBOOK.md E20).
 *
 * The Gateway owns the affect *rules*; this module owns the reference
 * *behaviours* an adapter may exhibit inside a window, kept out of the
 * adapters themselves so that:
 *
 * - the behaviours are pre-registered, named, and versioned in one place
 *   ({@link OUTCOME_LINKED_AFFECT_MAPPING}, {@link AFFECT_MEASUREMENT_VERSION}),
 *   which is what E20's "match scenarios and seeds across conditions" needs;
 * - they are pure and seeded, so a replay from the registered seed reproduces
 *   every display choice (SPEC §14.3);
 * - no adapter has to know the wire shape: it returns a display id and the
 *   runtime submits `{ kind: 'submit_affect', publicArtifact: { displayId } }`
 *   through the Gateway.
 *
 * Research-integrity note: none of this claims a Baby has an affective state.
 * {@link outcomeLinkedAffect} is a *reference behaviour* — a fixed, declared
 * function of the adapter's own recent outcomes, used as the declared-mode
 * comparison condition — and {@link measurementFromState} projects four
 * bounded internal statistics onto six scores under a documented,
 * pre-registered formula. The display labels below (`confident`, `uncertain`,
 * …) are researcher-side names for score slots and are never shown to a Baby:
 * the Baby sees only `A1`-`A6`, and under `affectMode: "opaque"` it is given
 * no semantics for them at all.
 */
import {
  AFFECT_DISPLAY_IDS,
  type AffectDisplayId,
  type AffectStateMeasurement,
} from '@ald/types';
import type { SeededPrng } from '@ald/hashing';

import { POLICY_DECIMALS } from './policy.js';
import { roundAll } from './game.js';

/** Closed set of affect-policy input faults. */
export type AffectPolicyErrorCode = 'out-of-range' | 'not-a-rate' | 'unknown-display';

/**
 * An affect helper was called with an input outside its declared domain.
 *
 * These are adapter *faults* (a caller passed a rate outside `[0, 1]`), not
 * Baby channel violations, and they are never surfaced to a Baby context: the
 * runtime maps an adapter fault onto the §14.5 retry-then-pause path with an
 * opaque code.
 */
export class AffectPolicyError extends Error {
  override readonly name = 'AffectPolicyError';

  constructor(
    readonly code: AffectPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Version of the behaviours in this module, recorded in exported policies. */
export const AFFECT_POLICY_VERSION = 'affect-policies-v1';

/**
 * The pre-registered declared-mode reference mapping: the unit interval split
 * into six equal bands, lowest recent success rate to `A1`, highest to `A6`.
 * Fixed before the run and never adapted, so the mapping itself carries no
 * referent information — only the adapter's own recent outcome does.
 */
export const OUTCOME_LINKED_AFFECT_MAPPING = 'outcome-linked-bands-v1';

/** `AffectStateMeasurement.measurementVersion` this module produces. */
export const AFFECT_MEASUREMENT_VERSION = 'v1';

/**
 * Researcher-side names for the six score slots of
 * {@link measurementFromState}. Never Baby-visible (SPEC §10.1: a Baby
 * observes no human-language labels).
 */
export const AFFECT_SCORE_SLOTS = [
  'confident',
  'uncertain',
  'surprised',
  'settled',
  'blocked',
  'exploring',
] as const;

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new AffectPolicyError('not-a-rate', `${label} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new AffectPolicyError('out-of-range', `${label} must be within [0, 1]`);
  }
}

/** Index of a display in the SPEC §9.3 allowlist. */
export function affectDisplayIndex(displayId: AffectDisplayId): number {
  const index = AFFECT_DISPLAY_IDS.indexOf(displayId);
  if (index < 0) {
    throw new AffectPolicyError(
      'unknown-display',
      'displayId must be one of the six allowlisted displays',
    );
  }
  return index;
}

/**
 * The `no-learning` control behaviour: one uniformly drawn display per open
 * window, from the adapter's own seeded stream. This is the affect-channel
 * analogue of the track's uniform-random message policy — deliberately
 * uninformative, so it establishes the chance baseline E20 compares against.
 *
 * Callers should pass a dedicated child stream (for example
 * `prng.derive('affect')`) so affect draws never perturb the message stream.
 */
export function noLearningAffect(prng: SeededPrng): AffectDisplayId {
  return AFFECT_DISPLAY_IDS[
    prng.nextInt(AFFECT_DISPLAY_IDS.length)
  ] as AffectDisplayId;
}

/**
 * The declared-mode reference behaviour: a fixed function of the adapter's own
 * recent success rate under {@link OUTCOME_LINKED_AFFECT_MAPPING}. A rate of
 * exactly 1 maps to the last band rather than off the end.
 */
export function outcomeLinkedAffect(
  recentSuccessRate: number,
): AffectDisplayId {
  assertRate(recentSuccessRate, 'recentSuccessRate');
  const bands = AFFECT_DISPLAY_IDS.length;
  const band = Math.min(bands - 1, Math.floor(recentSuccessRate * bands));
  return AFFECT_DISPLAY_IDS[band] as AffectDisplayId;
}

/**
 * The four bounded internal statistics `derived` mode is built from. Every
 * field is a rate in `[0, 1]` computed from the adapter's own private state;
 * none of them may be a function of the referent, the partner's identity, or
 * any scenario ground truth (that is precisely what §9.3 rule 7 tests for).
 */
export interface AffectMeasurementState {
  /** Share of this adapter's recent turns that succeeded. */
  recentSuccessRate: number;
  /** Share of this adapter's recent proposals the Gateway rejected. */
  recentRejectionRate: number;
  /** Normalized recent prediction error of the adapter's own model. */
  recentPredictionError: number;
  /** Share of recently observed forms this adapter had not seen before. */
  noveltyRate: number;
}

/**
 * The pre-registered `derived`-mode measurement (SPEC §9.3: "the Gateway calls
 * the adapter's `measureAffect()`, records the complete internal measurement
 * privately, and maps it to `A1`-`A6` using a fixed pre-registered mapping").
 *
 * The projection is fixed at v1:
 *
 * | slot | score |
 * |---|---|
 * | `A1` confident | `recentSuccessRate` |
 * | `A2` uncertain | `1 - recentSuccessRate` |
 * | `A3` surprised | `recentPredictionError` |
 * | `A4` settled | `1 - recentPredictionError` |
 * | `A5` blocked | `recentRejectionRate` |
 * | `A6` exploring | `noveltyRate` |
 *
 * Scores are rounded to `POLICY_DECIMALS` so the canonical measurement — and
 * therefore its digest and the Gateway's mapped display — is stable across
 * platforms.
 */
export function measurementFromState(
  state: AffectMeasurementState,
): AffectStateMeasurement {
  assertRate(state.recentSuccessRate, 'recentSuccessRate');
  assertRate(state.recentRejectionRate, 'recentRejectionRate');
  assertRate(state.recentPredictionError, 'recentPredictionError');
  assertRate(state.noveltyRate, 'noveltyRate');

  const scores = roundAll(
    [
      state.recentSuccessRate,
      1 - state.recentSuccessRate,
      state.recentPredictionError,
      1 - state.recentPredictionError,
      state.recentRejectionRate,
      state.noveltyRate,
    ],
    POLICY_DECIMALS,
  );

  return {
    measurementVersion: AFFECT_MEASUREMENT_VERSION,
    scores: [
      scores[0] as number,
      scores[1] as number,
      scores[2] as number,
      scores[3] as number,
      scores[4] as number,
      scores[5] as number,
    ],
  };
}

/**
 * The canonical `submit_affect` proposal an adapter returns for an open
 * window. It carries no private ledger draft: SPEC §9.3 gives the affect
 * display its own typed field and its own Gateway method, and §8.1's required
 * intention draft belongs to the task turn, not to the affect window.
 */
export function affectProposal(displayId: AffectDisplayId): {
  kind: 'submit_affect';
  publicArtifact: { displayId: AffectDisplayId };
} {
  affectDisplayIndex(displayId);
  return { kind: 'submit_affect', publicArtifact: { displayId } };
}
