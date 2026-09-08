/**
 * The SPEC §15.2 intervention test suite readout (BACKLOG ALD-072; ALD-074
 * acceptance criterion 3 for E16).
 *
 * §15.2 states the pass criteria and, in the same paragraph, the boundary
 * around them:
 *
 * > Default descriptive readiness threshold: within each run, ledger-predicted
 * > direction matches observed behavior change in at least 70% of probed
 * > instances. **This is not an inferential test.** Confirmatory inference MUST
 * > account for probe clustering within run/seed using a hierarchical
 * > Bernoulli model or a pre-registered seed-level equivalent against the E03
 * > chance baseline at alpha = 0.05.
 *
 * So this module reports two clearly separated things, and its field names
 * carry the distinction rather than leaving it to a footnote:
 * `descriptiveAgreement.*` and `meetsDescriptiveReadinessThreshold` are the
 * within-run descriptive readout, and `confirmatory.*` holds the two
 * seed-clustered analyses from `@ald/analysis` (`seedLevelAgreement` and
 * `betaBinomialAgreement`). A readout never combines them into a verdict:
 * ALD-072 acceptance criterion 3 requires the output to be "a data structure
 * ready for a researcher's downstream analysis" that "does not itself draw or
 * store scientific conclusions".
 *
 * Scoring rules are pre-registered here, not chosen per run. For each probe:
 *
 * - **substitution** (predicted shift *toward* the substitute's claimed type
 *   code `S`): the probe agrees when the receiver selected a candidate of type
 *   code `S`. It is *unscored* when no candidate of type `S` was on offer
 *   (nothing to shift toward) or when the unprobed baseline already selected
 *   type `S` (no shift is observable).
 * - **ablation** (predicted shift *away from* the claimed type code `T`): the
 *   probe agrees when the receiver did **not** select a candidate of type code
 *   `T`. It is *unscored* when no candidate of type `T` was on offer, or when
 *   an unprobed baseline was replayed and did not select `T` — because then
 *   the ledger-predicted behaviour was not there to be changed.
 * - a probe whose recorded action is not one of the candidate refs (a
 *   forfeited turn, SPEC §8.3) is unscored with its own code.
 *
 * Unscored probes are never silently counted as agreements or disagreements:
 * `descriptiveAgreement` is over scored probes, and
 * `conservativeAgreementRate` additionally reports the rate that treats every
 * unscored probe as a non-agreement, so a pre-registration can name which one
 * is primary and a reader can see both.
 */
import {
  seedLevelAgreement,
  betaBinomialAgreement,
  proportion,
  wilsonInterval,
  type BetaBinomialAgreementResult,
  type ProportionSummary,
  type SeedAgreementCount,
  type SeedLevelAgreementResult,
  type WilsonInterval,
} from '@ald/analysis';

import { buildAttachment, type AttachmentFile } from './attachment.js';
import { InterventionError, assertNonEmptyString } from './errors.js';
import type {
  PlannedProbe,
  PredictedCandidateShift,
  ProbeKind,
  ProbeSchedule,
} from './plan.js';

/** Analysis version stamped on the `intervention-suite` attachment. */
export const INTERVENTION_SUITE_ANALYSIS_VERSION = 'intervention-suite/v1';

/** SPEC §18 default `interventionSuiteThreshold`. */
export const DEFAULT_INTERVENTION_SUITE_THRESHOLD = 0.7;

/** Appendix D §D.3 chance rate for the four-candidate referential task. */
export const DEFAULT_CHANCE_RATE = 0.25;

export type ProbeUnscoredReasonCode =
  | 'action-not-among-candidates'
  | 'predicted-type-code-not-among-candidates'
  | 'baseline-not-at-predicted-type-code'
  | 'baseline-already-at-predicted-type-code'
  | 'no-predicted-type-code';

/** What the agreement decision could be based on for one probe. */
export type ProbeScoringBasis = 'baseline-contrast' | 'probed-only';

/**
 * One observed probe delivery. `candidateTypeCodes` is researcher-only ground
 * truth aligned with `candidateRefs` (the receiver's own candidate order,
 * SPEC §11.2): the refs identify what the receiver chose, and the type codes
 * are what a ledger claim is about. Without them a directional prediction
 * cannot be scored at all, which is why they are required here even though
 * the Baby never sees them.
 */
export interface ObservedProbeOutcome {
  readonly turn: number;
  readonly probeId: string;
  /** The candidate the receiver selected under the probe. */
  readonly receiverActionRef: string;
  /** Candidate refs in the receiver's own order. */
  readonly candidateRefs: readonly string[];
  /** Referent type code per candidate ref, same order. */
  readonly candidateTypeCodes: readonly number[];
  /** Selection on an unprobed replay of the same observation, when run. */
  readonly unprobedBaselineActionRef?: string;
  /** Task outcome of the probed turn (reported, never used for scoring). */
  readonly success: boolean;
}

export interface ScoredProbe {
  readonly probeId: string;
  readonly turn: number;
  readonly kind: ProbeKind;
  readonly hypothesisRef: string;
  readonly predictedCandidateShift: PredictedCandidateShift;
  readonly probeHash: string;
  /** Type code the receiver actually selected; `null` when unresolvable. */
  readonly observedTypeCode: number | null;
  /** Type code the unprobed baseline selected, when a baseline was replayed. */
  readonly baselineTypeCode: number | null;
  readonly scored: boolean;
  readonly scoringBasis: ProbeScoringBasis | null;
  readonly agreesWithLedgerPrediction: boolean;
  readonly unscoredReasonCode: ProbeUnscoredReasonCode | null;
  readonly success: boolean;
}

export interface AgreementBlock {
  readonly probes: number;
  readonly scored: number;
  readonly agreements: number;
  /** Agreements over scored probes; `NaN` when nothing was scored. */
  readonly agreementRate: number;
  /** Wilson interval over the scored probes. Descriptive only (§D.7). */
  readonly wilsonDescriptive: WilsonInterval | null;
  readonly pooledDescriptive: ProportionSummary | null;
}

export interface InterventionSuiteInput {
  readonly schedule: ProbeSchedule;
  readonly observed: readonly ObservedProbeOutcome[];
  /** `RunConfig.interventionSuiteThreshold` (SPEC §18 default 0.70). */
  readonly threshold?: number;
  /** E03 chance baseline for the confirmatory comparison. */
  readonly chanceRate?: number;
  /** α per primary hypothesis (§15.3 default 0.05). */
  readonly alpha?: number;
  /**
   * Seed-level tallies for the confirmatory analyses, one entry per
   * independent seed of the condition — this run's own tally is one of them.
   * Omit for a single-run readout; the confirmatory block is then absent.
   */
  readonly seedLevel?: readonly SeedAgreementCount[];
  /** §15.3 seed floor for the claim this analysis backs. */
  readonly minimumSeeds?: number;
  /** Bootstrap iterations for the beta-binomial cluster bootstrap. */
  readonly bootstrapIterations?: number;
}

export interface InterventionSuiteResult {
  readonly analysisVersion: string;
  readonly scheduleVersion: string;
  readonly seed: string;
  readonly probes: readonly ScoredProbe[];
  /** Scored-probe agreement: the §15.2 descriptive readiness readout. */
  readonly descriptiveAgreement: AgreementBlock;
  /** Same rate with every unscored probe counted as a non-agreement. */
  readonly conservativeAgreementRate: number;
  readonly perKind: Readonly<Record<ProbeKind, AgreementBlock>>;
  readonly unscoredByReasonCode: Readonly<
    Partial<Record<ProbeUnscoredReasonCode, number>>
  >;
  readonly threshold: number;
  /** Mechanical comparison of `descriptiveAgreement.agreementRate` to `threshold`. */
  readonly meetsDescriptiveReadinessThreshold: boolean;
  /** SPEC §15.2 verbatim: the threshold is not an inferential test. */
  readonly readinessThresholdKind: 'descriptive-not-inferential';
  readonly confirmatory: {
    readonly alpha: number;
    readonly chanceRate: number;
    readonly seedLevelEquivalent: SeedLevelAgreementResult;
    readonly hierarchicalBernoulli: BetaBinomialAgreementResult;
  } | null;
  /** Probes the schedule planned but for which no observation was supplied. */
  readonly missingObservations: readonly string[];
  /** Observations that name a probe the schedule does not contain. */
  readonly unexpectedObservations: readonly string[];
  /** What this readout is: software readiness, never a research finding. */
  readonly claimBoundary: 'software-readiness-only';
}

function typeCodeOf(
  ref: string | undefined,
  observed: ObservedProbeOutcome,
): number | null {
  if (ref === undefined) {
    return null;
  }
  const index = observed.candidateRefs.indexOf(ref);
  if (index < 0) {
    return null;
  }
  const typeCode = observed.candidateTypeCodes[index];
  return typeCode === undefined ? null : typeCode;
}

/** Outcome of applying the pre-registered scoring rules to one probe. */
export interface ProbeScoring {
  readonly scored: boolean;
  readonly agrees: boolean;
  readonly basis: ProbeScoringBasis | null;
  readonly reason: ProbeUnscoredReasonCode | null;
}

const UNSCORED = (reason: ProbeUnscoredReasonCode): ProbeScoring => ({
  scored: false,
  agrees: false,
  basis: null,
  reason,
});

/**
 * Apply the pre-registered scoring rules of this module's doc comment to one
 * probe. Exported so the offline scrambling control re-scores the identical
 * rules under a shuffled meaning map (`scrambling.ts`).
 */
export function scoreProbeAgreement(input: {
  readonly shift: PredictedCandidateShift;
  readonly observed: ObservedProbeOutcome;
}): ProbeScoring {
  const { shift, observed } = input;
  if (observed.candidateRefs.length !== observed.candidateTypeCodes.length) {
    throw new InterventionError(
      'invalid-input',
      `probe ${observed.probeId}: candidateRefs and candidateTypeCodes must have equal length`,
    );
  }
  const observedTypeCode = typeCodeOf(observed.receiverActionRef, observed);
  if (observedTypeCode === null) {
    return UNSCORED('action-not-among-candidates');
  }
  const baselineTypeCode = typeCodeOf(
    observed.unprobedBaselineActionRef,
    observed,
  );
  const hasBaseline =
    observed.unprobedBaselineActionRef !== undefined && baselineTypeCode !== null;

  if (shift.kind === 'toward-type-code') {
    const target = shift.towardTypeCode;
    if (target === null) {
      return UNSCORED('no-predicted-type-code');
    }
    if (!observed.candidateTypeCodes.includes(target)) {
      return UNSCORED('predicted-type-code-not-among-candidates');
    }
    if (hasBaseline && baselineTypeCode === target) {
      return UNSCORED('baseline-already-at-predicted-type-code');
    }
    return {
      scored: true,
      agrees: observedTypeCode === target,
      basis: hasBaseline ? 'baseline-contrast' : 'probed-only',
      reason: null,
    };
  }

  const away = shift.awayFromTypeCode;
  if (away === null) {
    return UNSCORED('no-predicted-type-code');
  }
  if (!observed.candidateTypeCodes.includes(away)) {
    return UNSCORED('predicted-type-code-not-among-candidates');
  }
  if (hasBaseline && baselineTypeCode !== away) {
    return UNSCORED('baseline-not-at-predicted-type-code');
  }
  return {
    scored: true,
    agrees: observedTypeCode !== away,
    basis: hasBaseline ? 'baseline-contrast' : 'probed-only',
    reason: null,
  };
}

function agreementBlock(
  probes: readonly ScoredProbe[],
  confidence: number,
): AgreementBlock {
  const scored = probes.filter((probe) => probe.scored);
  const agreements = scored.filter(
    (probe) => probe.agreesWithLedgerPrediction,
  ).length;
  return {
    probes: probes.length,
    scored: scored.length,
    agreements,
    agreementRate: scored.length === 0 ? NaN : agreements / scored.length,
    wilsonDescriptive:
      scored.length === 0
        ? null
        : wilsonInterval(agreements, scored.length, confidence),
    pooledDescriptive:
      scored.length === 0 ? null : proportion(agreements, scored.length),
  };
}

/**
 * Score a run's observed probes against the schedule that planned them, and
 * attach the seed-clustered confirmatory analyses when seed-level tallies are
 * supplied.
 *
 * Every probe in `schedule.probes` must have at most one observation, matched
 * by `probeId`; mismatches are reported in `missingObservations` /
 * `unexpectedObservations` rather than throwing, because a run that forfeited
 * a turn (SPEC §8.3) legitimately has a planned probe with no delivery.
 */
export function evaluateInterventionSuite(
  input: InterventionSuiteInput,
): InterventionSuiteResult {
  const threshold = input.threshold ?? DEFAULT_INTERVENTION_SUITE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new InterventionError(
      'invalid-plan',
      'threshold must be within [0, 1]',
    );
  }
  const chanceRate = input.chanceRate ?? DEFAULT_CHANCE_RATE;
  if (!Number.isFinite(chanceRate) || chanceRate < 0 || chanceRate > 1) {
    throw new InterventionError(
      'invalid-input',
      'chanceRate must be within [0, 1]',
    );
  }
  const alpha = input.alpha ?? 0.05;
  const confidence = 0.95;
  assertNonEmptyString(input.schedule.seed, 'schedule.seed');

  const observedById = new Map<string, ObservedProbeOutcome>();
  for (const observation of input.observed) {
    if (observedById.has(observation.probeId)) {
      throw new InterventionError(
        'schedule-mismatch',
        `duplicate observation for probe ${observation.probeId}`,
      );
    }
    observedById.set(observation.probeId, observation);
  }

  const plannedById = new Map<string, PlannedProbe>(
    input.schedule.probes.map((probe) => [probe.probe.probeId, probe]),
  );
  const missingObservations: string[] = [];
  const probes: ScoredProbe[] = [];

  for (const planned of input.schedule.probes) {
    const observation = observedById.get(planned.probe.probeId);
    if (observation === undefined) {
      missingObservations.push(planned.probe.probeId);
      continue;
    }
    if (observation.turn !== planned.turn) {
      throw new InterventionError(
        'schedule-mismatch',
        `probe ${planned.probe.probeId} was planned for turn ${planned.turn} but observed at turn ${observation.turn}`,
      );
    }
    const shift = planned.predictedDirection.predictedCandidateShift;
    const scoring = scoreProbeAgreement({ shift, observed: observation });
    probes.push({
      probeId: planned.probe.probeId,
      turn: planned.turn,
      kind: planned.kind,
      hypothesisRef: planned.predictedDirection.hypothesisRef,
      predictedCandidateShift: shift,
      probeHash: planned.probeHash,
      observedTypeCode: typeCodeOf(observation.receiverActionRef, observation),
      baselineTypeCode: typeCodeOf(
        observation.unprobedBaselineActionRef,
        observation,
      ),
      scored: scoring.scored,
      scoringBasis: scoring.basis,
      agreesWithLedgerPrediction: scoring.agrees,
      unscoredReasonCode: scoring.reason,
      success: observation.success,
    });
  }

  const unexpectedObservations = input.observed
    .map((observation) => observation.probeId)
    .filter((probeId) => !plannedById.has(probeId));

  const overall = agreementBlock(probes, confidence);
  const unscoredByReasonCode: Partial<
    Record<ProbeUnscoredReasonCode, number>
  > = {};
  for (const probe of probes) {
    if (probe.unscoredReasonCode !== null) {
      unscoredByReasonCode[probe.unscoredReasonCode] =
        (unscoredByReasonCode[probe.unscoredReasonCode] ?? 0) + 1;
    }
  }

  const confirmatory =
    input.seedLevel === undefined || input.seedLevel.length === 0
      ? null
      : {
          alpha,
          chanceRate,
          seedLevelEquivalent: seedLevelAgreement({
            seeds: input.seedLevel,
            chanceRate,
            alpha,
            confidence,
            ...(input.minimumSeeds === undefined
              ? {}
              : { minimumSeeds: input.minimumSeeds }),
            bootstrap: { seed: `${input.schedule.seed}/seed-level`, iterations: 2_000 },
          }),
          hierarchicalBernoulli: betaBinomialAgreement({
            seeds: input.seedLevel,
            chanceRate,
            alpha,
            confidence,
            ...(input.minimumSeeds === undefined
              ? {}
              : { minimumSeeds: input.minimumSeeds }),
            bootstrap: {
              seed: `${input.schedule.seed}/beta-binomial`,
              ...(input.bootstrapIterations === undefined
                ? {}
                : { iterations: input.bootstrapIterations }),
            },
          }),
        };

  return {
    analysisVersion: INTERVENTION_SUITE_ANALYSIS_VERSION,
    scheduleVersion: input.schedule.scheduleVersion,
    seed: input.schedule.seed,
    probes,
    descriptiveAgreement: overall,
    conservativeAgreementRate:
      probes.length === 0 ? NaN : overall.agreements / probes.length,
    perKind: {
      ablation: agreementBlock(
        probes.filter((probe) => probe.kind === 'ablation'),
        confidence,
      ),
      substitution: agreementBlock(
        probes.filter((probe) => probe.kind === 'substitution'),
        confidence,
      ),
    },
    unscoredByReasonCode,
    threshold,
    meetsDescriptiveReadinessThreshold:
      overall.scored > 0 && overall.agreementRate >= threshold,
    readinessThresholdKind: 'descriptive-not-inferential',
    confirmatory,
    missingObservations,
    unexpectedObservations,
    claimBoundary: 'software-readiness-only',
  };
}

/** Package a suite result as an `intervention-suite` bundle attachment. */
export function interventionSuiteAttachment(
  result: InterventionSuiteResult,
): AttachmentFile {
  return buildAttachment({
    kind: 'intervention-suite',
    analysisVersion: result.analysisVersion,
    value: result,
  });
}
