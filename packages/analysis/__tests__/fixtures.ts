/**
 * Deterministic synthetic samples for the @ald/analysis tests. No PRNG: seed
 * rates are placed on the normal quantile grid, so a sample of `n` values has
 * the requested mean (to floating-point) and very nearly the requested SD, and
 * every test input is reproducible without a fixture file.
 */
import { normalQuantile } from '../src/index.js';

/** `n` values centred on `mean`, spread by `sd`, clamped to [0, 1]. */
export function ratesAround(mean: number, sd: number, n: number): number[] {
  return Array.from({ length: n }, (_unused, index) =>
    Math.min(1, Math.max(0, mean + sd * normalQuantile((index + 0.5) / n))),
  );
}

/**
 * A synthetic 0/1 learning curve rising linearly from `chanceRate` to
 * `finalRate`. The Bernoulli draw is replaced by a fixed-phase sawtooth
 * crossing the instantaneous rate, so the curve is deterministic and its
 * windowed success rate increases with the turn index.
 */
export function learningCurve(
  turns: number,
  chanceRate: number,
  finalRate: number,
): number[] {
  return Array.from({ length: turns }, (_unused, index) => {
    const progress = turns === 1 ? 1 : index / (turns - 1);
    const rate = chanceRate + progress * (finalRate - chanceRate);
    const phase = ((index * 7) % 20) / 20;
    return phase < rate ? 1 : 0;
  });
}
