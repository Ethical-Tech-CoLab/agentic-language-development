/**
 * E31 longitudinal drift and stability readout (EXPERIMENT-NOTEBOOK.md E31;
 * SPECIFICATION.md §15.3; BACKLOG ALD-072, ALD-076 acceptance criterion 2 —
 * "the baseline/statistics scaffold can compare metrics across a long
 * sequence of turns/checkpoints for drift analysis").
 *
 * Input is one frozen-evaluation summary per checkpoint — E31's procedure
 * ("Run extended sessions with periodic frozen evaluations", "Anchor
 * checkpoints at the standard interval", "Measure ledger revisions, abandoned
 * meanings, and message entropy"). Output is E31's result table plus the two
 * things its checkboxes need: stability intervals, and the separation of
 * drift that spans a documented distribution shift from drift inside one
 * regime ("Drift and task-shift effects separated").
 *
 * The pre-registered drift score is the Jensen-Shannon divergence in bits
 * between the symbol-usage distributions of two checkpoints — bounded in
 * [0, 1] for base-2 logarithms, symmetric, and defined when one distribution
 * has zero mass where the other does not, which a KL divergence is not. When
 * a checkpoint carries no usage histogram the score is `NaN` and the pair is
 * reported as unscored rather than silently zero.
 *
 * Every function is pure; the only randomness is the seeded bootstrap of the
 * regime contrast, so a readout replays exactly from its seed (SPEC §14.3).
 */
import {
  bootstrapMeanCi,
  type BootstrapCi,
} from './bootstrap.js';
import {
  wilsonInterval,
  type WilsonInterval,
} from './descriptive.js';
import {
  AnalysisError,
  assertCount,
  assertLevel,
} from './errors.js';

/** Analysis version stamped on the E31 readout. */
export const DRIFT_ANALYSIS_VERSION = 'checkpoint-drift/v1';

/**
 * Default stability tolerance on the pair drift score: consecutive
 * checkpoints whose symbol-usage distributions differ by at most this many
 * bits of Jensen-Shannon divergence are treated as one stable interval. It is
 * a pre-registerable knob, not a finding; 0.05 bits is the value this
 * scaffold ships with and records in its output.
 */
export const DEFAULT_STABILITY_TOLERANCE_BITS = 0.05;

/** One periodic frozen evaluation (E31 "Run extended sessions with periodic frozen evaluations"). */
export interface CheckpointEvaluation {
  /** `CheckpointManifest.checkpointSequence` this evaluation follows. */
  readonly checkpointSequence: number;
  /** Turn at which the frozen evaluation ran. */
  readonly turn: number;
  /** Frozen-evaluation successes and episodes (learning disabled). */
  readonly success: { readonly successes: number; readonly n: number };
  /** Distinct forms in productive use at this checkpoint. */
  readonly vocabularySize: number;
  /** Ledger revisions/abandonments since the previous checkpoint. */
  readonly meaningChanges: number;
  /** Entropy of the message distribution in bits, as measured by the caller. */
  readonly messageEntropyBits: number;
  /**
   * Usage counts per form, in a stable form order shared by every
   * checkpoint of the run. Omit to leave the pair drift score unscored.
   */
  readonly symbolUsage?: readonly number[];
}

export interface DriftInput {
  readonly checkpoints: readonly CheckpointEvaluation[];
  /** Turns at which a documented distribution shift was introduced (E31). */
  readonly distributionShiftAt?: readonly number[];
  readonly confidence?: number;
  readonly stabilityToleranceBits?: number;
  /** Seed for the regime-contrast bootstrap; omit to skip that interval. */
  readonly seed?: string;
  readonly bootstrapIterations?: number;
}

export type PairUnscoredReasonCode =
  | 'missing-symbol-usage'
  | 'symbol-usage-length-mismatch'
  | 'empty-symbol-usage';

export interface CheckpointPairDrift {
  readonly fromCheckpointSequence: number;
  readonly toCheckpointSequence: number;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly turnsElapsed: number;
  /** Jensen-Shannon divergence in bits; `NaN` when unscored. */
  readonly driftScoreBits: number;
  readonly unscoredReasonCode: PairUnscoredReasonCode | null;
  /** Ledger revisions per turn over the interval. */
  readonly revisionRate: number;
  readonly successDelta: number;
  readonly vocabularyDelta: number;
  readonly messageEntropyDeltaBits: number;
  /** True when a documented distribution shift falls inside the interval. */
  readonly spansDistributionShift: boolean;
}

export interface StabilityInterval {
  readonly fromCheckpointSequence: number;
  readonly toCheckpointSequence: number;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly checkpoints: number;
  /** Largest pair drift score inside the interval; 0 for a single checkpoint. */
  readonly maxPairDriftBits: number;
}

export type RegimeSeparationDecision =
  | 'separated'
  | 'insufficient-shift-spanning-pairs'
  | 'insufficient-within-regime-pairs'
  | 'no-shifts-declared';

export interface RegimeSeparation {
  readonly withinRegime: {
    readonly pairs: number;
    readonly meanDriftBits: number;
    readonly bootstrap: BootstrapCi | null;
  };
  readonly shiftSpanning: {
    readonly pairs: number;
    readonly meanDriftBits: number;
    readonly bootstrap: BootstrapCi | null;
  };
  /** `shiftSpanning - withinRegime`; positive means shifts drift more. */
  readonly meanDifferenceBits: number;
  readonly decision: RegimeSeparationDecision;
}

export interface DriftResult {
  readonly analysisVersion: string;
  readonly checkpoints: readonly {
    readonly checkpointSequence: number;
    readonly turn: number;
    readonly successRate: number;
    readonly successWilson: WilsonInterval;
    readonly vocabularySize: number;
    readonly meaningChanges: number;
    readonly messageEntropyBits: number;
    /** Divergence from the first checkpoint's usage distribution, in bits. */
    readonly cumulativeDriftBits: number;
  }[];
  readonly pairs: readonly CheckpointPairDrift[];
  /** Mean of the scored consecutive-pair drift scores. */
  readonly meanPairDriftBits: number;
  /** Divergence between the first and last checkpoint's usage, in bits. */
  readonly endToEndDriftBits: number;
  readonly stabilityToleranceBits: number;
  readonly stabilityIntervals: readonly StabilityInterval[];
  readonly regimeSeparation: RegimeSeparation;
  readonly distributionShiftAt: readonly number[];
  readonly confidence: number;
}

/**
 * Wilson interval for a checkpoint's frozen evaluation. A checkpoint with no
 * episodes reports an all-`NaN` interval rather than an interval computed on
 * a substituted denominator.
 */
function successInterval(
  successes: number,
  n: number,
  confidence: number,
): WilsonInterval {
  if (n === 0) {
    return {
      lower: NaN,
      upper: NaN,
      center: NaN,
      level: confidence,
      successes,
      n,
      proportion: NaN,
    };
  }
  return wilsonInterval(successes, n, confidence);
}

/** Normalize non-negative counts to a probability vector. */
function distribution(counts: readonly number[]): number[] | null {
  let total = 0;
  for (const count of counts) {
    if (!Number.isFinite(count) || count < 0) {
      throw new AnalysisError(
        'domain',
        'symbolUsage counts must be non-negative finite numbers',
      );
    }
    total += count;
  }
  if (total === 0) {
    return null;
  }
  return counts.map((count) => count / total);
}

function shannonBits(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > 0) {
      total -= value * Math.log2(value);
    }
  }
  return total;
}

/**
 * Jensen-Shannon divergence in bits between two form-usage histograms:
 * `H(m) - (H(p) + H(q)) / 2` with `m` the mean distribution. Returns 0 for
 * identical histograms and 1 for disjoint support. `null` inputs (all-zero
 * histograms) yield `NaN`.
 */
export function symbolUsageDivergenceBits(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) {
    throw new AnalysisError(
      'length-mismatch',
      'symbolUsage histograms must have equal length',
    );
  }
  const p = distribution(left);
  const q = distribution(right);
  if (p === null || q === null) {
    return NaN;
  }
  const mixture = p.map((value, index) => (value + (q[index] as number)) / 2);
  return shannonBits(mixture) - (shannonBits(p) + shannonBits(q)) / 2;
}

function pairDriftScore(
  from: CheckpointEvaluation,
  to: CheckpointEvaluation,
): { score: number; reason: PairUnscoredReasonCode | null } {
  if (from.symbolUsage === undefined || to.symbolUsage === undefined) {
    return { score: NaN, reason: 'missing-symbol-usage' };
  }
  if (from.symbolUsage.length !== to.symbolUsage.length) {
    return { score: NaN, reason: 'symbol-usage-length-mismatch' };
  }
  const score = symbolUsageDivergenceBits(from.symbolUsage, to.symbolUsage);
  if (Number.isNaN(score)) {
    return { score, reason: 'empty-symbol-usage' };
  }
  return { score, reason: null };
}

function assertCheckpoints(checkpoints: readonly CheckpointEvaluation[]): void {
  if (checkpoints.length === 0) {
    throw new AnalysisError('empty-sample', 'checkpoints must not be empty');
  }
  let previousTurn = -1;
  checkpoints.forEach((checkpoint, index) => {
    assertCount(
      checkpoint.checkpointSequence,
      `checkpoints[${index}].checkpointSequence`,
    );
    assertCount(checkpoint.turn, `checkpoints[${index}].turn`);
    assertCount(checkpoint.success.n, `checkpoints[${index}].success.n`);
    assertCount(
      checkpoint.success.successes,
      `checkpoints[${index}].success.successes`,
    );
    if (checkpoint.success.successes > checkpoint.success.n) {
      throw new AnalysisError(
        'domain',
        `checkpoints[${index}].success.successes must not exceed n`,
      );
    }
    if (checkpoint.turn <= previousTurn) {
      throw new AnalysisError(
        'domain',
        'checkpoints must be ordered by strictly increasing turn',
      );
    }
    previousTurn = checkpoint.turn;
  });
}

/**
 * The whole E31 readout: per-checkpoint metrics with cumulative drift,
 * consecutive-pair drift, stability intervals, and the within-regime versus
 * shift-spanning contrast.
 *
 * Nothing here decides that a run drifted: `decision` on the regime
 * separation says only whether the comparison had enough pairs on both sides
 * to be computed (ALD-072 acceptance criterion 3).
 */
export function evaluateCheckpointDrift(input: DriftInput): DriftResult {
  assertCheckpoints(input.checkpoints);
  const confidence = input.confidence ?? 0.95;
  assertLevel(confidence, 'confidence');
  const tolerance =
    input.stabilityToleranceBits ?? DEFAULT_STABILITY_TOLERANCE_BITS;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new AnalysisError(
      'domain',
      'stabilityToleranceBits must be a non-negative finite number',
    );
  }
  const shifts = [...(input.distributionShiftAt ?? [])].sort(
    (left, right) => left - right,
  );

  const first = input.checkpoints[0] as CheckpointEvaluation;
  const checkpoints = input.checkpoints.map((checkpoint) => {
    const rate =
      checkpoint.success.n === 0
        ? NaN
        : checkpoint.success.successes / checkpoint.success.n;
    const cumulative =
      checkpoint === first
        ? 0
        : pairDriftScore(first, checkpoint).score;
    return {
      checkpointSequence: checkpoint.checkpointSequence,
      turn: checkpoint.turn,
      successRate: rate,
      successWilson: successInterval(
        checkpoint.success.successes,
        checkpoint.success.n,
        confidence,
      ),
      vocabularySize: checkpoint.vocabularySize,
      meaningChanges: checkpoint.meaningChanges,
      messageEntropyBits: checkpoint.messageEntropyBits,
      cumulativeDriftBits: cumulative,
    };
  });

  const pairs: CheckpointPairDrift[] = [];
  for (let index = 1; index < input.checkpoints.length; index += 1) {
    const from = input.checkpoints[index - 1] as CheckpointEvaluation;
    const to = input.checkpoints[index] as CheckpointEvaluation;
    const { score, reason } = pairDriftScore(from, to);
    const turnsElapsed = to.turn - from.turn;
    const fromRate =
      from.success.n === 0 ? NaN : from.success.successes / from.success.n;
    const toRate = to.success.n === 0 ? NaN : to.success.successes / to.success.n;
    pairs.push({
      fromCheckpointSequence: from.checkpointSequence,
      toCheckpointSequence: to.checkpointSequence,
      fromTurn: from.turn,
      toTurn: to.turn,
      turnsElapsed,
      driftScoreBits: score,
      unscoredReasonCode: reason,
      revisionRate: turnsElapsed === 0 ? NaN : to.meaningChanges / turnsElapsed,
      successDelta: toRate - fromRate,
      vocabularyDelta: to.vocabularySize - from.vocabularySize,
      messageEntropyDeltaBits: to.messageEntropyBits - from.messageEntropyBits,
      spansDistributionShift: shifts.some(
        (shiftTurn) => shiftTurn > from.turn && shiftTurn <= to.turn,
      ),
    });
  }

  const scoredPairs = pairs.filter((pair) => !Number.isNaN(pair.driftScoreBits));
  const meanPairDrift =
    scoredPairs.length === 0
      ? NaN
      : scoredPairs.reduce((total, pair) => total + pair.driftScoreBits, 0) /
        scoredPairs.length;

  const last = input.checkpoints[
    input.checkpoints.length - 1
  ] as CheckpointEvaluation;
  const endToEnd =
    input.checkpoints.length < 2 ? 0 : pairDriftScore(first, last).score;

  // Stability intervals: maximal runs of consecutive checkpoints whose pair
  // drift never exceeds the tolerance. An unscored pair breaks the run, so an
  // interval never claims stability across a checkpoint with no histogram.
  const intervals: StabilityInterval[] = [];
  let startIndex = 0;
  let maxInside = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index] as CheckpointPairDrift;
    const stable =
      !Number.isNaN(pair.driftScoreBits) && pair.driftScoreBits <= tolerance;
    if (stable) {
      maxInside = Math.max(maxInside, pair.driftScoreBits);
      continue;
    }
    const from = input.checkpoints[startIndex] as CheckpointEvaluation;
    const to = input.checkpoints[index] as CheckpointEvaluation;
    intervals.push({
      fromCheckpointSequence: from.checkpointSequence,
      toCheckpointSequence: to.checkpointSequence,
      fromTurn: from.turn,
      toTurn: to.turn,
      checkpoints: index - startIndex + 1,
      maxPairDriftBits: maxInside,
    });
    startIndex = index + 1;
    maxInside = 0;
  }
  {
    const from = input.checkpoints[startIndex] as
      | CheckpointEvaluation
      | undefined;
    if (from !== undefined) {
      intervals.push({
        fromCheckpointSequence: from.checkpointSequence,
        toCheckpointSequence: last.checkpointSequence,
        fromTurn: from.turn,
        toTurn: last.turn,
        checkpoints: input.checkpoints.length - startIndex,
        maxPairDriftBits: maxInside,
      });
    }
  }

  const within = scoredPairs
    .filter((pair) => !pair.spansDistributionShift)
    .map((pair) => pair.driftScoreBits);
  const spanning = scoredPairs
    .filter((pair) => pair.spansDistributionShift)
    .map((pair) => pair.driftScoreBits);
  const meanOf = (values: readonly number[]): number =>
    values.length === 0
      ? NaN
      : values.reduce((total, value) => total + value, 0) / values.length;
  const bootstrapOf = (values: readonly number[], label: string): BootstrapCi | null =>
    input.seed === undefined || values.length < 2
      ? null
      : bootstrapMeanCi(values, {
          seed: `${input.seed}/${label}`,
          iterations: input.bootstrapIterations ?? 2_000,
          confidence,
        });

  let decision: RegimeSeparationDecision;
  if (shifts.length === 0) {
    decision = 'no-shifts-declared';
  } else if (spanning.length < 1) {
    decision = 'insufficient-shift-spanning-pairs';
  } else if (within.length < 1) {
    decision = 'insufficient-within-regime-pairs';
  } else {
    decision = 'separated';
  }

  return {
    analysisVersion: DRIFT_ANALYSIS_VERSION,
    checkpoints,
    pairs,
    meanPairDriftBits: meanPairDrift,
    endToEndDriftBits: endToEnd,
    stabilityToleranceBits: tolerance,
    stabilityIntervals: intervals,
    regimeSeparation: {
      withinRegime: {
        pairs: within.length,
        meanDriftBits: meanOf(within),
        bootstrap: bootstrapOf(within, 'within-regime'),
      },
      shiftSpanning: {
        pairs: spanning.length,
        meanDriftBits: meanOf(spanning),
        bootstrap: bootstrapOf(spanning, 'shift-spanning'),
      },
      meanDifferenceBits: meanOf(spanning) - meanOf(within),
      decision,
    },
    distributionShiftAt: shifts,
    confidence,
  };
}
