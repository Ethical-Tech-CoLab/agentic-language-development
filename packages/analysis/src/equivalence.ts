/**
 * Control-equivalence decision helper (SPECIFICATION.md §15.3 "Any conclusion
 * that performance is equivalent to chance ... MUST use a pre-registered
 * equivalence/non-inferiority bound"; RESEARCH.md Appendix D §D.6 item 1).
 */
import { tost, type TostResult } from './hypothesis.js';
import { assertSample } from './errors.js';

export type EquivalenceDecision =
  | 'equivalent'
  | 'not-equivalent'
  | 'insufficient-seeds';

/**
 * Minimum seeds this helper will run a TOST on. Two seeds give df = 1 and a
 * t interval so wide that the test is uninformative, and SPECIFICATION.md
 * §15.3 sets an engineering floor of five seeds per condition for E00-E03;
 * three is the point below which the toolkit refuses to produce a decision at
 * all and reports `insufficient-seeds` instead.
 */
export const MINIMUM_EQUIVALENCE_SEEDS = 3;

export interface ControlEquivalenceInput {
  /** Seed-level success proportions, one per valid seed (Appendix D §D.6). */
  readonly seedSuccessRates: readonly number[];
  readonly lower: number;
  readonly upper: number;
  readonly alpha: number;
}

export interface ControlEquivalenceResult {
  readonly tost: TostResult;
  readonly decision: EquivalenceDecision;
  readonly minimumSeeds: number;
}

/**
 * Run the TOST for one control condition and map it to a decision. The
 * decision is the mechanical result of the pre-registered rule: `equivalent`
 * iff both one-sided tests reject at `alpha`, `insufficient-seeds` when fewer
 * than `MINIMUM_EQUIVALENCE_SEEDS` seeds are supplied (never silently
 * `not-equivalent`, which would read as evidence of a difference).
 */
export function evaluateControlEquivalence(
  input: ControlEquivalenceInput,
): ControlEquivalenceResult {
  assertSample(input.seedSuccessRates, 'seedSuccessRates');
  const result = tost(
    input.seedSuccessRates,
    input.lower,
    input.upper,
    input.alpha,
  );
  if (input.seedSuccessRates.length < MINIMUM_EQUIVALENCE_SEEDS) {
    return {
      tost: result,
      decision: 'insufficient-seeds',
      minimumSeeds: MINIMUM_EQUIVALENCE_SEEDS,
    };
  }
  return {
    tost: result,
    decision: result.equivalent ? 'equivalent' : 'not-equivalent',
    minimumSeeds: MINIMUM_EQUIVALENCE_SEEDS,
  };
}
