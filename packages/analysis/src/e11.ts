/**
 * E11 summary: the from-scratch RL naming-game readout of
 * EXPERIMENT-NOTEBOOK.md E11 ("Training success", "Held-out success",
 * "Compare against E03 controls"), using the SPECIFICATION.md §15.3 statistics
 * and the E03 chance baseline.
 *
 * Like `e03Analysis` this is a calculator: it returns a windowed training
 * curve, the evaluation proportion with its Wilson interval, and a one-sided
 * chance comparison. It attaches no verdict — E11's acceptance checkboxes are
 * the researcher's to tick (ALD-072 acceptance criterion 3).
 */
import {
  proportion,
  wilsonInterval,
  type ProportionSummary,
  type WilsonInterval,
} from './descriptive.js';
import { cohensH } from './effects.js';
import { AnalysisError, assertLevel, assertProbability } from './errors.js';
import { binomialTest, type BinomialTestResult } from './hypothesis.js';

/**
 * Appendix D §D.3 chance success for the four-candidate referential task; the
 * default null rate for the E11 above-chance comparison.
 */
export const E03_CHANCE_RATE = 0.25;

export interface E11SummaryInput {
  /** Per-turn training outcomes, 0 or 1, in turn order. */
  readonly trainingSuccess: readonly number[];
  /** Per-turn evaluation outcomes (learning disabled), 0 or 1. */
  readonly evaluationSuccess: readonly number[];
  /** Turns per training-curve window; the last window may be shorter. */
  readonly windowSize: number;
  /** Null success probability for the chance comparison (default 0.25). */
  readonly chanceRate?: number;
  /** Wilson/interval coverage (default 0.95). */
  readonly confidence?: number;
}

export interface E11TrainingWindow {
  /** Zero-based window index. */
  readonly index: number;
  /** Inclusive first turn of the window. */
  readonly startTurn: number;
  /** Exclusive last turn of the window. */
  readonly endTurn: number;
  readonly n: number;
  readonly successes: number;
  readonly rate: number;
  /** False for a trailing window shorter than `windowSize`. */
  readonly complete: boolean;
  readonly wilson: WilsonInterval;
}

export interface E11Summary {
  readonly windowSize: number;
  readonly confidence: number;
  readonly chanceRate: number;
  /** Pooled training outcome across every turn. */
  readonly training: ProportionSummary;
  /** Non-overlapping training windows in turn order. */
  readonly trainingCurve: E11TrainingWindow[];
  readonly evaluation: ProportionSummary;
  readonly evaluationWilson: WilsonInterval;
  /**
   * One-sided (`greater`) comparison of the evaluation proportion against
   * `chanceRate`, with both the exact binomial tail and the normal
   * approximation.
   */
  readonly chanceComparison: BinomialTestResult;
  /** Cohen's h of the evaluation proportion against `chanceRate` (§15.3). */
  readonly cohensHVersusChance: number;
}

function countSuccesses(
  outcomes: readonly number[],
  label: string,
  from: number,
  to: number,
): number {
  let successes = 0;
  for (let index = from; index < to; index += 1) {
    const outcome = outcomes[index] as number;
    if (outcome !== 0 && outcome !== 1) {
      throw new AnalysisError('domain', `${label}[${index}] must be 0 or 1`);
    }
    successes += outcome;
  }
  return successes;
}

/**
 * Windowed training curve plus the evaluation readout and chance comparison.
 *
 * Windows are non-overlapping and taken in turn order; a trailing partial
 * window is reported with its true `n` and `complete: false` rather than
 * dropped, so no turn silently disappears from the curve. Each window carries
 * its own Wilson interval, which is descriptive (turns within a run are not
 * independent seeds — RESEARCH.md §7.3, Appendix D §D.6).
 */
export function e11Summary(input: E11SummaryInput): E11Summary {
  const { trainingSuccess, evaluationSuccess } = input;
  if (!Number.isInteger(input.windowSize) || input.windowSize < 1) {
    throw new AnalysisError(
      'domain',
      'windowSize must be a positive integer',
    );
  }
  if (trainingSuccess.length === 0) {
    throw new AnalysisError('empty-sample', 'trainingSuccess must not be empty');
  }
  if (evaluationSuccess.length === 0) {
    throw new AnalysisError(
      'empty-sample',
      'evaluationSuccess must not be empty',
    );
  }
  const confidence = input.confidence ?? 0.95;
  assertLevel(confidence, 'confidence');
  const chanceRate = input.chanceRate ?? E03_CHANCE_RATE;
  assertProbability(chanceRate, 'chanceRate');

  const trainingCurve: E11TrainingWindow[] = [];
  for (
    let start = 0, index = 0;
    start < trainingSuccess.length;
    start += input.windowSize, index += 1
  ) {
    const end = Math.min(start + input.windowSize, trainingSuccess.length);
    const successes = countSuccesses(
      trainingSuccess,
      'trainingSuccess',
      start,
      end,
    );
    const n = end - start;
    trainingCurve.push({
      index,
      startTurn: start,
      endTurn: end,
      n,
      successes,
      rate: successes / n,
      complete: n === input.windowSize,
      wilson: wilsonInterval(successes, n, confidence),
    });
  }

  const trainingSuccesses = countSuccesses(
    trainingSuccess,
    'trainingSuccess',
    0,
    trainingSuccess.length,
  );
  const evaluationSuccesses = countSuccesses(
    evaluationSuccess,
    'evaluationSuccess',
    0,
    evaluationSuccess.length,
  );
  const evaluation = proportion(evaluationSuccesses, evaluationSuccess.length);
  return {
    windowSize: input.windowSize,
    confidence,
    chanceRate,
    training: proportion(trainingSuccesses, trainingSuccess.length),
    trainingCurve,
    evaluation,
    evaluationWilson: wilsonInterval(
      evaluation.successes,
      evaluation.n,
      confidence,
    ),
    chanceComparison: binomialTest(
      evaluation.successes,
      evaluation.n,
      chanceRate,
      'greater',
    ),
    cohensHVersusChance: cohensH(evaluation.proportion, chanceRate),
  };
}
