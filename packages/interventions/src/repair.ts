/**
 * E14 turn-taking, role-reversal and repair metrics
 * (EXPERIMENT-NOTEBOOK.md E14; SPEC §8.1 step 9, §15.3; BACKLOG ALD-072,
 * ALD-074 acceptance criterion 3).
 *
 * E14's result table names five metrics — successful repair rate, turns per
 * resolved ambiguity, role symmetry, reused repair constructions, held-out
 * repair success — and its procedure fixes what a "repair" is allowed to be:
 * "Permit a bounded second turn without adding new channel capacity"
 * (`InterventionPlanSchema.repair = { enabled, maxExtraTurns: 1 }` in
 * `@ald/types`). This module computes those five metrics from episodes the
 * runtime already records, and it *checks the bound* rather than assuming it:
 * an episode that took more extra turns than the plan permits, or whose
 * repair message carried more marks than the run's `maxSymbolsPerMessage`,
 * is reported as a budget violation. A violation invalidates the E14 metric,
 * not the run, and this module says so in codes rather than prose.
 *
 * The input is deliberately carrier-agnostic: a form is identified by an
 * opaque `formHash` (a `markHash` for a generative carrier, or the joined
 * symbol sequence for `fixed-token`), so "reused repair constructions" is
 * measurable for all five SPEC §9.2 carriers.
 *
 * Pure counting: no PRNG, no I/O, and no conclusion. Whether the numbers show
 * dialogue is the researcher's call (ALD-072 acceptance criterion 3).
 */
import {
  cohensH,
  proportion,
  wilsonInterval,
  type ProportionSummary,
  type WilsonInterval,
} from '@ald/analysis';
import type { BabyRole } from '@ald/types';

import { buildAttachment, type AttachmentFile } from './attachment.js';
import { InterventionError } from './errors.js';

/** Analysis version of the E14 readout. */
export const REPAIR_ANALYSIS_VERSION = 'repair-metrics/v1';

/** One delivered turn inside an episode. `attempt` 0 is the first try. */
export interface RepairAttempt {
  readonly turn: number;
  /** 0 for the episode's first attempt, 1.. for bounded repair turns. */
  readonly attempt: number;
  readonly sender: BabyRole;
  readonly receiver: BabyRole;
  readonly success: boolean;
  /** Opaque identity of the delivered form (`markHash` or symbol sequence). */
  readonly formHash?: string;
  /** Marks in the delivered message, for the channel-capacity check. */
  readonly messageLength?: number;
}

export interface RepairEpisode {
  readonly episodeId: string;
  /** E14 "Pre-register ambiguous and unambiguous scenarios". */
  readonly ambiguous: boolean;
  /** E15/E14 "Test whether repair forms generalize to new referents". */
  readonly split: 'train' | 'held-out';
  readonly attempts: readonly RepairAttempt[];
}

export interface RepairInput {
  readonly episodes: readonly RepairEpisode[];
  /** `InterventionPlan.repair.maxExtraTurns`; SPEC's literal default is 1. */
  readonly maxExtraTurns?: number;
  /** `RunConfig.maxSymbolsPerMessage`; a repair must not exceed it. */
  readonly maxSymbolsPerMessage?: number;
  readonly confidence?: number;
}

export type RepairViolationCode =
  /** More extra turns than `maxExtraTurns` permits. */
  | 'repair-budget-exceeded'
  /** A repair message carried more marks than the run's per-message ceiling. */
  | 'repair-added-channel-capacity'
  /** Attempt indices are not 0,1,2,… without gaps. */
  | 'attempt-sequence-invalid'
  /** No attempt with index 0. */
  | 'missing-first-attempt'
  /** An attempt claims a sender that is also its receiver. */
  | 'sender-equals-receiver';

export interface ProportionWithWilson {
  readonly summary: ProportionSummary;
  readonly wilson: WilsonInterval;
}

export interface RoleSymmetryResult {
  readonly perRole: Readonly<Record<BabyRole, ProportionWithWilson | null>>;
  /** `baby-a` minus `baby-b` sender success; `NaN` when a role has no turns. */
  readonly successGap: number;
  /** §15.3 mandatory effect size for the role contrast. */
  readonly cohensH: number;
  /** Turns each Baby spent as sender: the §8.1 step 9 reversal check. */
  readonly senderTurns: Readonly<Record<BabyRole, number>>;
}

export interface RepairReuseResult {
  readonly repairAttemptsWithForm: number;
  readonly distinctRepairForms: number;
  /** Repair attempts whose form had already been used in an earlier repair. */
  readonly reusedAttempts: number;
  /** `reusedAttempts / repairAttemptsWithForm`; `NaN` without forms. */
  readonly reuseRate: number;
  /** Forms that appear in repair turns but never in a first attempt. */
  readonly repairSpecificForms: number;
}

export interface RepairResult {
  readonly analysisVersion: string;
  readonly episodes: number;
  readonly ambiguousEpisodes: number;
  readonly heldOutEpisodes: number;
  readonly maxExtraTurns: number;
  /** Episodes whose first attempt failed: the repair opportunities. */
  readonly repairOpportunities: number;
  /** Opportunities in which at least one extra turn was taken. */
  readonly repairAttempted: number;
  /** Attempted repairs that ended in a success. */
  readonly repairResolved: number;
  /** E14 "Successful repair rate": resolved over attempted. */
  readonly repairRate: ProportionWithWilson | null;
  /** The same numerator over every opportunity, attempted or not. */
  readonly repairRateOverOpportunities: ProportionWithWilson | null;
  readonly firstAttemptSuccess: ProportionWithWilson | null;
  /** E14 "Turns per resolved ambiguity": mean attempts in resolved ambiguous episodes. */
  readonly turnsPerResolvedAmbiguity: number;
  readonly resolvedAmbiguousEpisodes: number;
  /** E14 "Role symmetry". */
  readonly roleSymmetry: RoleSymmetryResult;
  /**
   * Who took the repair turn. `original-receiver` means the Baby that failed
   * to act on the first message initiated the repair, which is E14's
   * "receiver requests or elicits repair"; `original-sender` is a
   * re-formulation by the same speaker.
   */
  readonly repairInitiation: {
    readonly originalReceiver: number;
    readonly originalSender: number;
  };
  /** E14 "Reused repair constructions". */
  readonly reuse: RepairReuseResult;
  /** E14 "Held-out repair success". */
  readonly heldOutRepairRate: ProportionWithWilson | null;
  readonly seenRepairRate: ProportionWithWilson | null;
  readonly violations: readonly {
    readonly episodeId: string;
    readonly code: RepairViolationCode;
    readonly turn: number | null;
  }[];
  readonly claimBoundary: 'software-readiness-only';
}

function withWilson(
  successes: number,
  n: number,
  confidence: number,
): ProportionWithWilson | null {
  if (n === 0) {
    return null;
  }
  return {
    summary: proportion(successes, n),
    wilson: wilsonInterval(successes, n, confidence),
  };
}

/** Attempts of one episode in `attempt` order. */
function orderedAttempts(episode: RepairEpisode): RepairAttempt[] {
  return [...episode.attempts].sort((left, right) => left.attempt - right.attempt);
}

/**
 * Compute the five E14 metrics plus the repair-budget checks.
 *
 * An episode with no attempts at all is an input error: E14 measures
 * dialogue, and an episode that never delivered a turn is not a data point
 * with a missing field but a malformed record.
 */
export function evaluateRepair(input: RepairInput): RepairResult {
  if (input.episodes.length === 0) {
    throw new InterventionError('invalid-input', 'episodes must not be empty');
  }
  const confidence = input.confidence ?? 0.95;
  const maxExtraTurns = input.maxExtraTurns ?? 1;
  if (!Number.isInteger(maxExtraTurns) || maxExtraTurns < 0) {
    throw new InterventionError(
      'invalid-plan',
      'maxExtraTurns must be a non-negative integer',
    );
  }

  const violations: RepairResult['violations'][number][] = [];
  let repairOpportunities = 0;
  let repairAttempted = 0;
  let repairResolved = 0;
  let firstAttempts = 0;
  let firstAttemptSuccesses = 0;
  let resolvedAmbiguous = 0;
  let resolvedAmbiguousTurns = 0;
  let heldOutAttempted = 0;
  let heldOutResolved = 0;
  let seenAttempted = 0;
  let seenResolved = 0;
  let originalReceiverRepairs = 0;
  let originalSenderRepairs = 0;

  const senderTurns: Record<BabyRole, number> = { 'baby-a': 0, 'baby-b': 0 };
  const senderSuccesses: Record<BabyRole, number> = {
    'baby-a': 0,
    'baby-b': 0,
  };
  const firstAttemptForms = new Set<string>();
  const repairForms = new Map<string, number>();
  let repairAttemptsWithForm = 0;
  let reusedAttempts = 0;

  for (const episode of input.episodes) {
    const attempts = orderedAttempts(episode);
    if (attempts.length === 0) {
      throw new InterventionError(
        'invalid-input',
        `episode ${episode.episodeId} has no attempts`,
      );
    }
    attempts.forEach((attempt, index) => {
      if (attempt.attempt !== index) {
        violations.push({
          episodeId: episode.episodeId,
          code:
            index === 0 ? 'missing-first-attempt' : 'attempt-sequence-invalid',
          turn: attempt.turn,
        });
      }
      if (attempt.sender === attempt.receiver) {
        violations.push({
          episodeId: episode.episodeId,
          code: 'sender-equals-receiver',
          turn: attempt.turn,
        });
      }
      senderTurns[attempt.sender] += 1;
      if (attempt.success) {
        senderSuccesses[attempt.sender] += 1;
      }
    });

    const first = attempts[0] as RepairAttempt;
    const extras = attempts.slice(1);
    if (first.attempt === 0) {
      firstAttempts += 1;
      if (first.success) {
        firstAttemptSuccesses += 1;
      }
      if (first.formHash !== undefined) {
        firstAttemptForms.add(first.formHash);
      }
    }
    if (extras.length > maxExtraTurns) {
      violations.push({
        episodeId: episode.episodeId,
        code: 'repair-budget-exceeded',
        turn: (extras[maxExtraTurns] as RepairAttempt).turn,
      });
    }
    for (const extra of extras) {
      if (
        input.maxSymbolsPerMessage !== undefined &&
        extra.messageLength !== undefined &&
        extra.messageLength > input.maxSymbolsPerMessage
      ) {
        violations.push({
          episodeId: episode.episodeId,
          code: 'repair-added-channel-capacity',
          turn: extra.turn,
        });
      }
      if (extra.sender === first.receiver) {
        originalReceiverRepairs += 1;
      } else {
        originalSenderRepairs += 1;
      }
      if (extra.formHash !== undefined) {
        repairAttemptsWithForm += 1;
        const seen = repairForms.get(extra.formHash) ?? 0;
        if (seen > 0) {
          reusedAttempts += 1;
        }
        repairForms.set(extra.formHash, seen + 1);
      }
    }

    if (first.success) {
      continue;
    }
    repairOpportunities += 1;
    if (extras.length === 0) {
      continue;
    }
    repairAttempted += 1;
    const resolved = extras.some((extra) => extra.success);
    if (resolved) {
      repairResolved += 1;
      if (episode.ambiguous) {
        resolvedAmbiguous += 1;
        resolvedAmbiguousTurns += attempts.length;
      }
    }
    if (episode.split === 'held-out') {
      heldOutAttempted += 1;
      if (resolved) {
        heldOutResolved += 1;
      }
    } else {
      seenAttempted += 1;
      if (resolved) {
        seenResolved += 1;
      }
    }
  }

  const roleRate = (role: BabyRole): ProportionWithWilson | null =>
    withWilson(senderSuccesses[role], senderTurns[role], confidence);
  const rateA = roleRate('baby-a');
  const rateB = roleRate('baby-b');

  return {
    analysisVersion: REPAIR_ANALYSIS_VERSION,
    episodes: input.episodes.length,
    ambiguousEpisodes: input.episodes.filter((episode) => episode.ambiguous)
      .length,
    heldOutEpisodes: input.episodes.filter(
      (episode) => episode.split === 'held-out',
    ).length,
    maxExtraTurns,
    repairOpportunities,
    repairAttempted,
    repairResolved,
    repairRate: withWilson(repairResolved, repairAttempted, confidence),
    repairRateOverOpportunities: withWilson(
      repairResolved,
      repairOpportunities,
      confidence,
    ),
    firstAttemptSuccess: withWilson(
      firstAttemptSuccesses,
      firstAttempts,
      confidence,
    ),
    turnsPerResolvedAmbiguity:
      resolvedAmbiguous === 0
        ? NaN
        : resolvedAmbiguousTurns / resolvedAmbiguous,
    resolvedAmbiguousEpisodes: resolvedAmbiguous,
    roleSymmetry: {
      perRole: { 'baby-a': rateA, 'baby-b': rateB },
      successGap:
        rateA === null || rateB === null
          ? NaN
          : rateA.summary.proportion - rateB.summary.proportion,
      cohensH:
        rateA === null || rateB === null
          ? NaN
          : cohensH(rateA.summary.proportion, rateB.summary.proportion),
      senderTurns: { ...senderTurns },
    },
    repairInitiation: {
      originalReceiver: originalReceiverRepairs,
      originalSender: originalSenderRepairs,
    },
    reuse: {
      repairAttemptsWithForm,
      distinctRepairForms: repairForms.size,
      reusedAttempts,
      reuseRate:
        repairAttemptsWithForm === 0
          ? NaN
          : reusedAttempts / repairAttemptsWithForm,
      repairSpecificForms: [...repairForms.keys()].filter(
        (form) => !firstAttemptForms.has(form),
      ).length,
    },
    heldOutRepairRate: withWilson(heldOutResolved, heldOutAttempted, confidence),
    seenRepairRate: withWilson(seenResolved, seenAttempted, confidence),
    violations,
    claimBoundary: 'software-readiness-only',
  };
}

/** Package the E14 readout as an `other`-kind bundle attachment. */
export function repairMetricsAttachment(result: RepairResult): AttachmentFile {
  return buildAttachment({
    kind: 'other',
    analysisVersion: result.analysisVersion,
    value: result,
  });
}
