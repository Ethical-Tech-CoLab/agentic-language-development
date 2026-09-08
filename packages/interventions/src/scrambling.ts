/**
 * The SPEC §15.2 scrambling control — offline only.
 *
 * > | Scrambling control | Replay with a shuffled post-hoc symbol-to-meaning
 * > mapping (offline analysis only, never live) | Ledger-predicted accuracy
 * > collapses toward chance, confirming the ledger is not a post-hoc
 * > rationalization |
 *
 * "Offline analysis only, never live" is a hard property of this module, not
 * a convention: it takes an already-observed probe set and re-scores it, and
 * it has no way to reach a Gateway, a delivery, or a run. `ArtifactProbe`
 * (SPEC §15.2 / `@ald/types`) deliberately has no `scrambling` kind for the
 * same reason, so a scrambled mapping can never become a delivered
 * perturbation.
 *
 * The control answers one question: if the ledger's form-to-meaning map were
 * replaced by a random permutation of the same meanings, how well would the
 * *same* pre-registered scoring rules (`scoreProbeAgreement`) predict the
 * *same* observed behaviour? If the observed agreement rate is inside the
 * scrambled distribution, the run's agreement is consistent with post-hoc
 * rationalization; if it sits above it, the ledger's specific claims carried
 * the prediction. The module reports both numbers and the gap; it does not
 * decide which conclusion the researcher may draw.
 *
 * Determinism: the permutations come from a `SeededPrng` derived from the
 * caller's seed, so a scrambling control replays exactly (SPEC §14.3).
 */
import { percentileInterval, type ConfidenceInterval } from '@ald/analysis';
import { SeededPrng } from '@ald/hashing';

import { buildAttachment, type AttachmentFile } from './attachment.js';
import { InterventionError, assertNonEmptyString } from './errors.js';
import type { PlannedProbe, ProbeSchedule } from './plan.js';
import {
  scoreProbeAgreement,
  type ObservedProbeOutcome,
} from './suite.js';

/** Analysis version of the scrambling-control readout. */
export const SCRAMBLING_CONTROL_VERSION = 'scrambling-control/v1';

const DEFAULT_PERMUTATIONS = 1_000;

export type ScramblingDecision =
  /** Observed agreement is above the scrambled `confidence` interval. */
  | 'observed-above-scrambled-interval'
  /** Observed agreement lies inside the scrambled interval. */
  | 'observed-within-scrambled-interval'
  /** Observed agreement is below the scrambled interval. */
  | 'observed-below-scrambled-interval'
  /** Fewer than two scored probes, or fewer than two distinct meanings. */
  | 'insufficient-probes';

export interface ScramblingInput {
  readonly schedule: ProbeSchedule;
  readonly observed: readonly ObservedProbeOutcome[];
  /** Number of shuffled meaning maps to draw (default 1000). */
  readonly permutations?: number;
  readonly confidence?: number;
  /** Chance rate the collapse is measured against (E03 baseline). */
  readonly chanceRate?: number;
  /** Seed for the permutations; defaults to the schedule's own seed. */
  readonly seed?: string;
}

export interface ScramblingResult {
  readonly analysisVersion: string;
  readonly seed: string;
  readonly permutations: number;
  readonly confidence: number;
  readonly chanceRate: number;
  /** Distinct forms the schedule's probes referred to. */
  readonly formsRemapped: number;
  /** Distinct claimed meanings that were permuted among those forms. */
  readonly meaningsPermuted: number;
  readonly scoredProbes: number;
  /** Agreement rate under the ledger's own claims (the observed run). */
  readonly observedAgreementRate: number;
  /** Mean agreement rate over the shuffled meaning maps. */
  readonly scrambledMeanAgreementRate: number;
  /** Central `confidence` interval of the shuffled agreement rates. */
  readonly scrambledInterval: ConfidenceInterval;
  /** `observed - scrambled mean`: how much the ledger's specificity bought. */
  readonly collapseTowardChance: number;
  /** Distance of the scrambled mean from the chance rate. */
  readonly scrambledMinusChance: number;
  /** Share of shuffled maps that scored at least as well as the ledger's. */
  readonly permutationP: number;
  readonly decision: ScramblingDecision;
  readonly claimBoundary: 'software-readiness-only';
}

interface PairedProbe {
  readonly planned: PlannedProbe;
  readonly observed: ObservedProbeOutcome;
}

/**
 * Re-score the observed probes under a permuted form-to-meaning map.
 *
 * The permutation is applied to the *meanings*: the distinct claimed type
 * codes of the schedule's probes are shuffled among the distinct forms, so
 * the scrambled map has the same forms and the same multiset of meanings as
 * the ledger's map and differs only in their pairing. That is what makes the
 * comparison a control rather than a different analysis.
 */
function scoreUnderMap(
  pairs: readonly PairedProbe[],
  map: ReadonlyMap<string, number>,
): { scored: number; agreements: number } {
  let scored = 0;
  let agreements = 0;
  for (const pair of pairs) {
    const targetMeaning = map.get(pair.planned.targetForm);
    const substituteMeaning =
      pair.planned.substituteForm === null
        ? null
        : (map.get(pair.planned.substituteForm) ?? null);
    if (targetMeaning === undefined) {
      continue;
    }
    const shift =
      pair.planned.kind === 'substitution' && substituteMeaning !== null
        ? {
            kind: 'toward-type-code' as const,
            towardTypeCode: substituteMeaning,
            awayFromTypeCode: targetMeaning,
          }
        : {
            kind: 'away-from-type-code' as const,
            towardTypeCode: null,
            awayFromTypeCode: targetMeaning,
          };
    const scoring = scoreProbeAgreement({ shift, observed: pair.observed });
    if (!scoring.scored) {
      continue;
    }
    scored += 1;
    if (scoring.agrees) {
      agreements += 1;
    }
  }
  return { scored, agreements };
}

/**
 * Run the offline scrambling control over a scored probe set.
 *
 * Only probes that the schedule planned *and* the run observed take part; a
 * probe with no observation cannot be re-scored under any map.
 */
export function evaluateScramblingControl(
  input: ScramblingInput,
): ScramblingResult {
  const seed = input.seed ?? input.schedule.seed;
  assertNonEmptyString(seed, 'seed');
  const permutations = input.permutations ?? DEFAULT_PERMUTATIONS;
  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new InterventionError(
      'invalid-input',
      'permutations must be a positive integer',
    );
  }
  const confidence = input.confidence ?? 0.95;
  if (!(confidence > 0) || !(confidence < 1)) {
    throw new InterventionError(
      'invalid-input',
      'confidence must be within (0, 1)',
    );
  }
  const chanceRate = input.chanceRate ?? 0.25;

  const observedById = new Map(
    input.observed.map((observation) => [observation.probeId, observation]),
  );
  const pairs: PairedProbe[] = [];
  for (const planned of input.schedule.probes) {
    const observed = observedById.get(planned.probe.probeId);
    if (observed !== undefined) {
      pairs.push({ planned, observed });
    }
  }

  const forms = [
    ...new Set(
      pairs.flatMap((pair) =>
        pair.planned.substituteForm === null
          ? [pair.planned.targetForm]
          : [pair.planned.targetForm, pair.planned.substituteForm],
      ),
    ),
  ].sort();
  const ledgerMap = new Map<string, number>();
  for (const pair of pairs) {
    ledgerMap.set(
      pair.planned.targetForm,
      pair.planned.predictedDirection.claimedTypeCode,
    );
    const shift = pair.planned.predictedDirection.predictedCandidateShift;
    if (pair.planned.substituteForm !== null && shift.towardTypeCode !== null) {
      ledgerMap.set(pair.planned.substituteForm, shift.towardTypeCode);
    }
  }
  const meanings = forms.map((form) => ledgerMap.get(form) as number);
  const distinctMeanings = new Set(meanings.filter((value) => value !== undefined));

  const ledgerScore = scoreUnderMap(pairs, ledgerMap);
  const observedRate =
    ledgerScore.scored === 0 ? NaN : ledgerScore.agreements / ledgerScore.scored;

  if (ledgerScore.scored < 2 || distinctMeanings.size < 2) {
    return {
      analysisVersion: SCRAMBLING_CONTROL_VERSION,
      seed,
      permutations,
      confidence,
      chanceRate,
      formsRemapped: forms.length,
      meaningsPermuted: distinctMeanings.size,
      scoredProbes: ledgerScore.scored,
      observedAgreementRate: observedRate,
      scrambledMeanAgreementRate: NaN,
      scrambledInterval: { lower: NaN, upper: NaN, level: confidence },
      collapseTowardChance: NaN,
      scrambledMinusChance: NaN,
      permutationP: NaN,
      decision: 'insufficient-probes',
      claimBoundary: 'software-readiness-only',
    };
  }

  const prng = new SeededPrng(`${seed}/scrambling-control`);
  const rates: number[] = [];
  let atLeastAsGood = 0;
  for (let replicate = 0; replicate < permutations; replicate += 1) {
    const shuffled = prng.shuffle(meanings);
    const map = new Map<string, number>();
    forms.forEach((form, index) => {
      map.set(form, shuffled[index] as number);
    });
    const score = scoreUnderMap(pairs, map);
    if (score.scored === 0) {
      continue;
    }
    const rate = score.agreements / score.scored;
    rates.push(rate);
    if (rate >= observedRate) {
      atLeastAsGood += 1;
    }
  }

  if (rates.length === 0) {
    return {
      analysisVersion: SCRAMBLING_CONTROL_VERSION,
      seed,
      permutations,
      confidence,
      chanceRate,
      formsRemapped: forms.length,
      meaningsPermuted: distinctMeanings.size,
      scoredProbes: ledgerScore.scored,
      observedAgreementRate: observedRate,
      scrambledMeanAgreementRate: NaN,
      scrambledInterval: { lower: NaN, upper: NaN, level: confidence },
      collapseTowardChance: NaN,
      scrambledMinusChance: NaN,
      permutationP: NaN,
      decision: 'insufficient-probes',
      claimBoundary: 'software-readiness-only',
    };
  }

  const scrambledMean =
    rates.reduce((total, rate) => total + rate, 0) / rates.length;
  const interval = percentileInterval(rates, confidence);
  let decision: ScramblingDecision;
  if (observedRate > interval.upper) {
    decision = 'observed-above-scrambled-interval';
  } else if (observedRate < interval.lower) {
    decision = 'observed-below-scrambled-interval';
  } else {
    decision = 'observed-within-scrambled-interval';
  }

  return {
    analysisVersion: SCRAMBLING_CONTROL_VERSION,
    seed,
    permutations,
    confidence,
    chanceRate,
    formsRemapped: forms.length,
    meaningsPermuted: distinctMeanings.size,
    scoredProbes: ledgerScore.scored,
    observedAgreementRate: observedRate,
    scrambledMeanAgreementRate: scrambledMean,
    scrambledInterval: interval,
    collapseTowardChance: observedRate - scrambledMean,
    scrambledMinusChance: scrambledMean - chanceRate,
    permutationP: (atLeastAsGood + 1) / (rates.length + 1),
    decision,
    claimBoundary: 'software-readiness-only',
  };
}

/** Package a scrambling result inside an `intervention-suite` attachment. */
export function scramblingControlAttachment(
  result: ScramblingResult,
): AttachmentFile {
  return buildAttachment({
    kind: 'intervention-suite',
    analysisVersion: result.analysisVersion,
    value: result,
  });
}
