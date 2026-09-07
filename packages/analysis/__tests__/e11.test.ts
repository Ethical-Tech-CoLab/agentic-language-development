import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  E03_CHANCE_RATE,
  e11Summary,
  wilsonInterval,
} from '../src/index.js';
import { learningCurve } from './fixtures.js';

const TRAINING = learningCurve(400, 0.25, 0.9);
const EVALUATION = learningCurve(120, 0.85, 0.9);

describe('e11Summary training curve', () => {
  const summary = e11Summary({
    trainingSuccess: TRAINING,
    evaluationSuccess: EVALUATION,
    windowSize: 50,
  });

  it('partitions the turns into non-overlapping windows', () => {
    expect(summary.windowSize).toBe(50);
    expect(summary.trainingCurve).toHaveLength(8);
    summary.trainingCurve.forEach((window, index) => {
      expect(window.index).toBe(index);
      expect(window.startTurn).toBe(index * 50);
      expect(window.endTurn).toBe((index + 1) * 50);
      expect(window.n).toBe(50);
      expect(window.complete).toBe(true);
      expect(window.rate).toBeCloseTo(window.successes / window.n, 12);
      expect(window.wilson.n).toBe(50);
    });
    const covered = summary.trainingCurve.reduce(
      (total, window) => total + window.n,
      0,
    );
    expect(covered).toBe(TRAINING.length);
    const successes = summary.trainingCurve.reduce(
      (total, window) => total + window.successes,
      0,
    );
    expect(successes).toBe(summary.training.successes);
  });

  it('shows the rate rising across windows', () => {
    const rates = summary.trainingCurve.map((window) => window.rate);
    const first = rates[0] as number;
    const last = rates[rates.length - 1] as number;
    expect(first).toBeLessThan(last);
    for (let index = 1; index < rates.length; index += 1) {
      expect(rates[index] as number).toBeGreaterThanOrEqual(
        rates[index - 1] as number,
      );
    }
  });

  it('keeps a trailing partial window with its true n', () => {
    const partial = e11Summary({
      trainingSuccess: TRAINING,
      evaluationSuccess: EVALUATION,
      windowSize: 150,
    });
    expect(partial.trainingCurve).toHaveLength(3);
    const last = partial.trainingCurve[2];
    expect(last?.n).toBe(100);
    expect(last?.startTurn).toBe(300);
    expect(last?.endTurn).toBe(400);
    expect(last?.complete).toBe(false);
  });

  it('supports a window per turn', () => {
    const perTurn = e11Summary({
      trainingSuccess: [1, 0, 1],
      evaluationSuccess: [1, 1],
      windowSize: 1,
    });
    expect(perTurn.trainingCurve.map((window) => window.rate)).toEqual([
      1, 0, 1,
    ]);
  });
});

describe('e11Summary evaluation and chance comparison', () => {
  const summary = e11Summary({
    trainingSuccess: TRAINING,
    evaluationSuccess: EVALUATION,
    windowSize: 50,
  });

  it('reports the evaluation proportion with its Wilson interval', () => {
    expect(summary.evaluation.n).toBe(120);
    expect(summary.evaluation.proportion).toBeCloseTo(0.9, 6);
    expect(summary.evaluationWilson).toEqual(
      wilsonInterval(summary.evaluation.successes, summary.evaluation.n, 0.95),
    );
    expect(summary.evaluationWilson.lower).toBeGreaterThan(0.25);
  });

  it('compares against the E03 chance rate one-sided', () => {
    expect(summary.chanceRate).toBe(E03_CHANCE_RATE);
    expect(summary.chanceComparison.alternative).toBe('greater');
    expect(summary.chanceComparison.exactP).toBeLessThan(1e-20);
    expect(summary.chanceComparison.normalP).toBeLessThan(1e-10);
    expect(summary.chanceComparison.z).toBeGreaterThan(10);
    expect(summary.cohensHVersusChance).toBeGreaterThan(0.8);
  });

  it('does not claim an advantage for an at-chance evaluation', () => {
    const atChance = e11Summary({
      trainingSuccess: [0, 0, 1, 0],
      evaluationSuccess: Array.from({ length: 200 }, (_unused, index) =>
        index % 4 === 0 ? 1 : 0,
      ),
      windowSize: 2,
    });
    expect(atChance.evaluation.proportion).toBe(0.25);
    expect(atChance.chanceComparison.z).toBeCloseTo(0, 12);
    expect(atChance.chanceComparison.normalP).toBeCloseTo(0.5, 12);
    expect(atChance.chanceComparison.exactP).toBeGreaterThan(0.5);
    expect(atChance.cohensHVersusChance).toBe(0);
    expect(atChance.evaluationWilson.lower).toBeLessThan(0.25);
    expect(atChance.evaluationWilson.upper).toBeGreaterThan(0.25);
  });

  it('honours an overridden chance rate and confidence level', () => {
    const summaryAtHalf = e11Summary({
      trainingSuccess: TRAINING,
      evaluationSuccess: EVALUATION,
      windowSize: 50,
      chanceRate: 0.5,
      confidence: 0.99,
    });
    expect(summaryAtHalf.chanceRate).toBe(0.5);
    expect(summaryAtHalf.chanceComparison.chanceRate).toBe(0.5);
    expect(summaryAtHalf.chanceComparison.z).toBeLessThan(
      summary.chanceComparison.z,
    );
    expect(summaryAtHalf.evaluationWilson.level).toBe(0.99);
    expect(summaryAtHalf.evaluationWilson.lower).toBeLessThan(
      summary.evaluationWilson.lower,
    );
  });

  it('is inert data: a JSON round trip is lossless and repeated calls agree', () => {
    const repeat = e11Summary({
      trainingSuccess: TRAINING,
      evaluationSuccess: EVALUATION,
      windowSize: 50,
    });
    expect(JSON.stringify(repeat)).toBe(JSON.stringify(summary));
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});

describe('e11Summary input validation', () => {
  it('rejects a bad window size, empty vectors, or non-binary outcomes', () => {
    expect(() =>
      e11Summary({
        trainingSuccess: [1],
        evaluationSuccess: [1],
        windowSize: 0,
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      e11Summary({
        trainingSuccess: [],
        evaluationSuccess: [1],
        windowSize: 5,
      }),
    ).toThrow(AnalysisError);
    expect(() =>
      e11Summary({
        trainingSuccess: [1],
        evaluationSuccess: [],
        windowSize: 5,
      }),
    ).toThrow(AnalysisError);
    expect(() =>
      e11Summary({
        trainingSuccess: [1, 0.5],
        evaluationSuccess: [1],
        windowSize: 5,
      }),
    ).toThrow(/must be 0 or 1/);
    expect(() =>
      e11Summary({
        trainingSuccess: [1],
        evaluationSuccess: [1],
        windowSize: 5,
        chanceRate: 1.5,
      }),
    ).toThrow(AnalysisError);
  });
});
