/**
 * Effect sizes SPECIFICATION.md §15.3 makes mandatory alongside every
 * significance test: Cohen's h for proportions and the rank-biserial
 * correlation for ordinal comparisons.
 */
import {
  AnalysisError,
  assertProbability,
  assertSample,
} from './errors.js';

/**
 * Cohen's h — the arcsine-transformed difference between two proportions,
 * `2*asin(sqrt(p1)) - 2*asin(sqrt(p2))` (SPECIFICATION.md §15.3 "Cohen's h
 * for proportions"). Positive when `p1 > p2`; the conventional small/medium/
 * large landmarks are 0.2 / 0.5 / 0.8. Interpretation is the researcher's, not
 * this toolkit's.
 */
export function cohensH(p1: number, p2: number): number {
  assertProbability(p1, 'p1');
  assertProbability(p2, 'p2');
  return 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));
}

export interface RankBiserialResult {
  /** Rank-biserial correlation in [-1, 1]; positive when `a` tends to exceed `b`. */
  readonly r: number;
  /** Mann-Whitney U for sample `a` (ties counted as one half). */
  readonly u: number;
  readonly nA: number;
  readonly nB: number;
}

/**
 * Rank-biserial correlation from the Mann-Whitney U statistic
 * (SPECIFICATION.md §15.3 "rank-biserial for ordinal comparisons").
 *
 * `u` counts pairs `(a_i, b_j)` with `a_i > b_j`, adding one half per tie, and
 * `r = 2 * u / (nA * nB) - 1`, i.e. `P(a > b) - P(a < b)` with ties split.
 * Computed by direct pair enumeration, which is exact, tie-safe, and — at the
 * seed counts of Appendix D §D.7 (at most a few hundred per condition) — fast
 * enough that no rank-sum shortcut is needed.
 */
export function rankBiserial(
  a: readonly number[],
  b: readonly number[],
): RankBiserialResult {
  assertSample(a, 'a');
  assertSample(b, 'b');
  let u = 0;
  for (const left of a) {
    for (const right of b) {
      if (left > right) {
        u += 1;
      } else if (left === right) {
        u += 0.5;
      }
    }
  }
  const pairs = a.length * b.length;
  if (pairs === 0) {
    throw new AnalysisError('empty-sample', 'both samples must be non-empty');
  }
  return { r: (2 * u) / pairs - 1, u, nA: a.length, nB: b.length };
}
