import { describe, expect, it } from 'vitest';

import {
  AnalysisError,
  E03_HIGH_SEED_SHARE_LIMIT,
  E03_HIGH_SEED_THRESHOLD,
  E03_ORACLE_LOWER_BOUND,
  E03_SEPARATION_LOWER_BOUND,
  e03Analysis,
  type E03AnalysisInput,
} from '../src/index.js';
import { ratesAround } from './fixtures.js';

const SEEDS = 75;

/** RESEARCH.md Appendix D §D.5 non-oracle conditions, all at chance. */
function atChanceConditions(): Record<string, number[]> {
  return {
    disabled: ratesAround(0.25, 0.02, SEEDS),
    constant: ratesAround(0.248, 0.02, SEEDS),
    random: ratesAround(0.252, 0.02, SEEDS),
    shuffled: ratesAround(0.25, 0.019, SEEDS),
    'normal-no-learning': ratesAround(0.251, 0.021, SEEDS),
  };
}

function input(overrides: Partial<E03AnalysisInput> = {}): E03AnalysisInput {
  return {
    alpha: 0.05,
    equivalenceLower: 0.2,
    equivalenceUpper: 0.3,
    oracleLowerBound: E03_ORACLE_LOWER_BOUND,
    separationLowerBound: E03_SEPARATION_LOWER_BOUND,
    seed: 'ald-e03-v1',
    conditions: atChanceConditions(),
    oracle: ratesAround(0.98, 0.01, SEEDS),
    bootstrapIterations: 2000,
    ...overrides,
  };
}

describe('e03Analysis on a qualifying synthetic run', () => {
  const analysis = e03Analysis(input());

  it('qualifies with no unmet criteria', () => {
    expect(analysis.qualifies).toBe(true);
    expect(analysis.unmetCriteria).toEqual([]);
    expect(analysis.criteria).toEqual({
      allControlsEquivalent: true,
      oracleAdequate: true,
      allSeparationsMeet: true,
    });
  });

  it('declares every non-oracle condition equivalent after Holm correction', () => {
    expect(analysis.conditions).toHaveLength(5);
    for (const condition of analysis.conditions) {
      expect(condition.decision).toBe('equivalent');
      expect(condition.unadjustedDecision).toBe('equivalent');
      expect(condition.holmAdjustedP).toBeLessThan(0.05);
      expect(condition.holmAdjustedP).toBeGreaterThanOrEqual(condition.rawP);
      expect(condition.tost.pLower).toBeLessThan(0.05);
      expect(condition.tost.pUpper).toBeLessThan(0.05);
      expect(condition.n).toBe(SEEDS);
    }
  });

  it('meets oracle adequacy above 0.90', () => {
    expect(analysis.oracle.n).toBe(SEEDS);
    expect(analysis.oracle.adequacy.lower).toBeGreaterThan(0.9);
    expect(analysis.oracle.meetsAdequacy).toBe(true);
    expect(analysis.oracle.summary.mean).toBeGreaterThan(0.9);
  });

  it('meets oracle separation with Holm tests and simultaneous intervals', () => {
    const ranks = analysis.conditions
      .map((condition) => condition.separation.rank)
      .sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5]);
    for (const condition of analysis.conditions) {
      const { separation } = condition;
      expect(separation.meets).toBe(true);
      expect(separation.simultaneousInterval.lower).toBeGreaterThan(0.6);
      expect(separation.simultaneousInterval.level).toBeCloseTo(0.99, 12);
      expect(separation.holmAdjustedP).toBeLessThan(0.05);
      expect(separation.holmAdjustedP).toBeGreaterThanOrEqual(separation.rawP);
    }
  });

  it('audits the §D.10 high-seed share', () => {
    for (const condition of analysis.conditions) {
      expect(condition.highSeeds.threshold).toBe(E03_HIGH_SEED_THRESHOLD);
      expect(condition.highSeeds.shareLimit).toBe(E03_HIGH_SEED_SHARE_LIMIT);
      expect(condition.highSeeds.count).toBe(0);
      expect(condition.highSeeds.withinLimit).toBe(true);
    }
  });

  it('is deterministic for a seed and seed-sensitive otherwise', () => {
    const repeat = e03Analysis(input());
    expect(JSON.stringify(repeat)).toBe(JSON.stringify(analysis));
    const other = e03Analysis(input({ seed: 'ald-e03-v2' }));
    expect(other.oracle.adequacy.lower).not.toBe(
      analysis.oracle.adequacy.lower,
    );
    expect(other.qualifies).toBe(true);
  });
});

describe('e03Analysis on a non-qualifying run', () => {
  it('names the above-chance condition and still qualifies the others', () => {
    const conditions = atChanceConditions();
    conditions['shuffled'] = ratesAround(0.4, 0.02, SEEDS);
    const analysis = e03Analysis(input({ conditions }));

    expect(analysis.qualifies).toBe(false);
    expect(analysis.unmetCriteria).toContain('equivalence:shuffled');
    // 0.4 is above the §D.10 audit threshold and 0.97 - 0.4 < 0.60.
    expect(analysis.auditTriggers).toContain('high-seed-review:shuffled');
    expect(analysis.unmetCriteria).toContain('separation:shuffled');
    expect(
      analysis.unmetCriteria.filter((code) => !code.endsWith(':shuffled')),
    ).toEqual([]);

    const failing = analysis.conditions.find(
      (condition) => condition.condition === 'shuffled',
    );
    expect(failing?.decision).toBe('not-equivalent');
    expect(failing?.tost.pUpper).toBeGreaterThan(0.05);
    expect(failing?.highSeeds.count).toBe(SEEDS);
    expect(failing?.highSeeds.share).toBe(1);
    // It has the weakest separation p value, so the others are unaffected.
    expect(failing?.separation.rank).toBe(5);
    for (const condition of analysis.conditions) {
      if (condition.condition !== 'shuffled') {
        expect(condition.decision).toBe('equivalent');
        expect(condition.separation.meets).toBe(true);
      }
    }
  });

  it('fails oracle adequacy when the oracle is weak', () => {
    const analysis = e03Analysis(
      input({ oracle: ratesAround(0.85, 0.02, SEEDS) }),
    );
    expect(analysis.criteria.oracleAdequate).toBe(false);
    expect(analysis.unmetCriteria).toContain('oracle-adequacy');
    expect(analysis.qualifies).toBe(false);
  });

  it('reports insufficient seeds instead of a decision', () => {
    const analysis = e03Analysis(
      input({
        conditions: { disabled: [0.25, 0.26] },
        oracle: [0.97, 0.98],
      }),
    );
    const condition = analysis.conditions[0];
    expect(condition?.decision).toBe('insufficient-seeds');
    expect(condition?.holmAdjustedP).toBeNaN();
    expect(analysis.qualifies).toBe(false);
    expect(analysis.unmetCriteria).toContain('equivalence:disabled');
  });

  it('enforces the five-seed qualification floor', () => {
    const analysis = e03Analysis(
      input({
        conditions: { disabled: [0.24, 0.25, 0.26, 0.25] },
        oracle: [0.97, 0.98, 0.99, 0.98],
      }),
    );
    expect(analysis.minimumSeeds).toBe(5);
    expect(analysis.conditions[0]?.decision).toBe('insufficient-seeds');
    expect(analysis.oracle.meetsAdequacy).toBe(false);
    expect(analysis.qualifies).toBe(false);
  });

  it('routes high seeds to leakage review without treating an arbitrary share as a test', () => {
    const conditions = atChanceConditions();
    conditions['disabled'] = ratesAround(0.25, 0.02, SEEDS);
    conditions['disabled'][0] = 0.35;
    const analysis = e03Analysis(input({ conditions }));
    expect(analysis.auditTriggers).toContain('high-seed-review:disabled');
    expect(analysis.conditions[0]?.highSeeds.auditRequired).toBe(true);
  });
});

describe('e03Analysis pooled-episode descriptives', () => {
  it('adds Wilson intervals only when episode counts are supplied', () => {
    const withoutCounts = e03Analysis(input());
    expect(withoutCounts.conditions[0]?.pooledEpisodes).toBeUndefined();
    expect(withoutCounts.oracle.pooledEpisodes).toBeUndefined();

    const analysis = e03Analysis(
      input({
        episodeCounts: {
          disabled: 200,
          constant: new Array<number>(SEEDS).fill(200),
          oracle: 200,
        },
      }),
    );
    const disabled = analysis.conditions.find(
      (condition) => condition.condition === 'disabled',
    );
    expect(disabled?.pooledEpisodes?.n).toBe(200 * SEEDS);
    expect(disabled?.pooledEpisodes?.proportion).toBeCloseTo(0.25, 3);
    expect(disabled?.pooledEpisodes?.lower).toBeLessThan(0.25);
    expect(disabled?.pooledEpisodes?.upper).toBeGreaterThan(0.25);
    expect(analysis.oracle.pooledEpisodes?.lower).toBeGreaterThan(0.9);
    // Conditions without a count keep no interval.
    expect(
      analysis.conditions.find(
        (condition) => condition.condition === 'random',
      )?.pooledEpisodes,
    ).toBeUndefined();
  });

  it('rejects malformed episode counts', () => {
    expect(() =>
      e03Analysis(input({ episodeCounts: { disabled: [200, 200] } })),
    ).toThrow(/one count per seed/);
    expect(() =>
      e03Analysis(input({ episodeCounts: { disabled: 0 } })),
    ).toThrow(AnalysisError);
  });
});

describe('e03Analysis input validation', () => {
  it('requires conditions paired with the oracle by seed slot', () => {
    expect(() =>
      e03Analysis(input({ oracle: ratesAround(0.98, 0.01, SEEDS - 1) })),
    ).toThrow(/paired with oracle/);
  });

  it('rejects rates outside [0, 1], empty families, and bad bounds', () => {
    expect(() =>
      e03Analysis(input({ conditions: { disabled: [0.2, 1.5, 0.3] } })),
    ).toThrow(AnalysisError);
    expect(() => e03Analysis(input({ conditions: {} }))).toThrow(
      /at least one non-oracle condition/,
    );
    expect(() =>
      e03Analysis(input({ equivalenceLower: 0.3, equivalenceUpper: 0.2 })),
    ).toThrow(/equivalenceLower/);
    expect(() => e03Analysis(input({ seed: '' }))).toThrow(AnalysisError);
    expect(() => e03Analysis(input({ alpha: 0 }))).toThrow(AnalysisError);
  });
});

describe('ALD-072 acceptance criteria', () => {
  const analysis = e03Analysis(
    input({ episodeCounts: { disabled: 200, oracle: 200 } }),
  );

  it('criterion 2: computes every baseline statistic named in SPEC §15.3', () => {
    const condition = analysis.conditions[0];
    if (condition === undefined) {
      throw new Error('expected at least one condition');
    }
    // Pre-registered alpha per primary hypothesis.
    expect(analysis.alpha).toBe(0.05);
    // Holm-Bonferroni across the primary metrics of the experiment.
    expect(Number.isFinite(condition.holmAdjustedP)).toBe(true);
    expect(condition.separation.simultaneousInterval.level).toBeGreaterThan(0);
    // Mandatory effect sizes: Cohen's h for proportions, rank-biserial ordinal.
    expect(Number.isFinite(condition.cohensHVersusMidpoint)).toBe(true);
    expect(Number.isFinite(condition.rankBiserialOracleOverCondition)).toBe(
      true,
    );
    // Confidence intervals: t-based primary intervals, bootstrap sensitivity,
    // and descriptive Wilson.
    expect(condition.tost.interval.level).toBeCloseTo(0.9, 12);
    expect(condition.separation.interval.level).toBe(0.95);
    expect(condition.separation.simultaneousInterval.level).toBeCloseTo(0.99, 12);
    expect(analysis.oracle.adequacy.level).toBe(0.95);
    expect(analysis.oracle.simultaneousInterval.level).toBe(0.95);
    expect(condition.pooledEpisodes?.level).toBe(0.95);
    // Equivalence bound rather than a non-significant difference.
    expect(condition.tost.equivalenceLower).toBe(0.2);
    expect(condition.tost.equivalenceUpper).toBe(0.3);
    // Descriptive summary of the seed-level unit of analysis.
    expect(condition.summary.n).toBe(SEEDS);
    expect(condition.summary.sd).toBeGreaterThan(0);
    // Minimum-seed accounting for the §15.3 five-seed floor.
    expect(condition.n).toBeGreaterThanOrEqual(5);
  });

  it('criterion 3: the output is inert data with no stored conclusion', () => {
    const clone: unknown = JSON.parse(JSON.stringify(analysis));
    expect(clone).toEqual(analysis);
    const values = Object.values(analysis as Record<string, unknown>);
    expect(values.some((value) => typeof value === 'function')).toBe(false);
    // The qualification flag is traceable to the registered rule and to the
    // per-clause criteria, and excludes the harness-supplied clauses.
    expect(analysis.decisionRule).toContain('§D.10');
    expect(analysis.decisionRule).toContain('harness');
    expect(analysis.qualifies).toBe(
      analysis.criteria.allControlsEquivalent &&
        analysis.criteria.oracleAdequate &&
        analysis.criteria.allSeparationsMeet,
    );
  });
});
