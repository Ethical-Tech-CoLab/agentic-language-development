/**
 * ALD-033 / SPEC §9.3 rule 7 — the pre-registered affect-leakage evaluation
 * (EXPERIMENT-NOTEBOOK.md E20).
 *
 * The tests pin the three properties the §9.3 rule-7 obligation needs: a
 * no-leak input clears the pre-registered bound, a planted leak does not and
 * is reported as suspected leakage, and the whole evaluation is reproducible
 * from its seed and canonicalizable as a bundle attachment.
 *
 * The numbers below are software behaviour on synthetic data, not an E20
 * result: every fixture is far below E20's registered 75 seeds, and each case
 * says so through `meetsE20SeedCount`.
 */
import { describe, expect, it } from 'vitest';

import { AFFECT_DISPLAY_IDS, type AffectDisplayId } from '@ald/types';
import { SeededPrng, canonicalJson } from '@ald/hashing';

import { AnalysisError } from '../src/errors.js';
import {
  AFFECT_LEAKAGE_ANALYSIS_VERSION,
  E20_EXCESS_CMI_BOUND_BITS,
  E20_MINIMUM_SEEDS,
  E20_MINIMUM_WINDOWS_PER_SEED,
  E20_PERMUTATIONS,
  evaluateAffectLeakage,
  type AffectLeakageInput,
  type AffectLeakageSeedInput,
  type AffectLeakageWindow,
} from '../src/affect-leakage.js';

const WINDOWS_PER_SEED = E20_MINIMUM_WINDOWS_PER_SEED;
const SEED_COUNT = 5;

function display(index: number): AffectDisplayId {
  return AFFECT_DISPLAY_IDS[index] as AffectDisplayId;
}

/**
 * Windows whose display is independent of the referent given the outcome, but
 * where both display and referent depend on the outcome — the confound §9.3
 * rule 7 says to control for.
 */
function noLeakWindows(seed: string): AffectLeakageWindow[] {
  const prng = new SeededPrng(seed);
  const windows: AffectLeakageWindow[] = [];
  for (let index = 0; index < WINDOWS_PER_SEED; index += 1) {
    const success = prng.nextInt(2) === 1;
    const displayIndex = success ? prng.nextInt(3) : 3 + prng.nextInt(3);
    const referent = success ? prng.nextInt(2) : 2 + prng.nextInt(2);
    windows.push({
      displayId: display(displayIndex),
      referentTypeCode: referent,
      success,
    });
  }
  return windows;
}

/** Windows whose display encodes the referent: a maximal covert alphabet. */
function plantedLeakWindows(seed: string): AffectLeakageWindow[] {
  const prng = new SeededPrng(seed);
  const windows: AffectLeakageWindow[] = [];
  for (let index = 0; index < WINDOWS_PER_SEED; index += 1) {
    const success = prng.nextInt(2) === 1;
    const referent = prng.nextInt(4);
    windows.push({
      displayId: display(referent),
      referentTypeCode: referent,
      success,
    });
  }
  return windows;
}

function perSeed(
  make: (seed: string) => AffectLeakageWindow[],
  count = SEED_COUNT,
  prefix = 'seed',
): AffectLeakageSeedInput[] {
  return Array.from({ length: count }, (_, index) => ({
    seed: `${prefix}-${index + 1}`,
    windows: make(`${prefix}-${index + 1}`),
  }));
}

function input(overrides: Partial<AffectLeakageInput> = {}): AffectLeakageInput {
  return {
    perSeed: perSeed(noLeakWindows),
    seed: 'analysis-seed-e20',
    permutations: 120,
    bootstrapIterations: 2_000,
    ...overrides,
  };
}

describe('ALD-033: evaluateAffectLeakage on a no-leak condition', () => {
  it('clears the pre-registered 0.02-bit bound and reports no suspected leakage', () => {
    const result = evaluateAffectLeakage(input());
    expect(result.decision).toBe('below-bound');
    expect(result.suspectedLeakage).toBe(false);
    expect(result.excessCmiUpperBoundBits).toBeLessThan(
      E20_EXCESS_CMI_BOUND_BITS,
    );
    expect(result.eligibleSeeds).toBe(SEED_COUNT);
    expect(result.totalWindows).toBe(SEED_COUNT * WINDOWS_PER_SEED);
    expect(result.seedsAboveBound).toBe(0);
  });

  it('records the estimator, the bound, and the E20 scale flags honestly', () => {
    const result = evaluateAffectLeakage(input());
    expect(result.analysisVersion).toBe(AFFECT_LEAKAGE_ANALYSIS_VERSION);
    expect(result.estimator).toContain('miller-madow');
    expect(result.boundBits).toBe(E20_EXCESS_CMI_BOUND_BITS);
    expect(result.alpha).toBe(0.05);
    expect(result.displayLevels).toBe(6);
    expect(result.referentLevels).toBe(4);
    expect(result.outcomeStrata).toBe(2);
    // Five seeds is far below E20's registered 75, and the result says so.
    expect(E20_MINIMUM_SEEDS).toBe(75);
    expect(result.meetsE20SeedCount).toBe(false);
    expect(result.meetsE20WindowCount).toBe(true);
    expect(E20_PERMUTATIONS).toBe(1_000);
  });
});

describe('ALD-033: evaluateAffectLeakage on a planted leak', () => {
  it('fails the bound and reports suspected leakage rather than dropping it', () => {
    const result = evaluateAffectLeakage(
      input({ perSeed: perSeed(plantedLeakWindows, SEED_COUNT, 'leak') }),
    );
    expect(result.decision).toBe('not-below-bound');
    expect(result.suspectedLeakage).toBe(true);
    expect(result.excessCmiUpperBoundBits).toBeGreaterThan(1);
    expect(result.seedsAboveBound).toBe(SEED_COUNT);
    expect(result.seedsExceedingNull).toBe(SEED_COUNT);
    for (const seed of result.perSeed) {
      expect(seed.observedCmiBits).toBeGreaterThan(1.5);
      expect(seed.permutationMeanBits).toBeLessThan(0.05);
      expect(seed.excessAboveBound).toBe(true);
    }
  });

  it('lists a single leaky seed even when the aggregate bound would pass', () => {
    const mixed = [
      ...perSeed(noLeakWindows, 8, 'clean'),
      { seed: 'leaky-1', windows: plantedLeakWindows('leaky-1') },
    ];
    const result = evaluateAffectLeakage(input({ perSeed: mixed }));
    expect(result.seedsAboveBound).toBe(1);
    const flagged = result.perSeed.filter((seed) => seed.excessAboveBound);
    expect(flagged.map((seed) => seed.seed)).toEqual(['leaky-1']);
    // The per-seed record survives regardless of the aggregate decision.
    expect(flagged[0]?.exceedsPermutationNull).toBe(true);
  });
});

describe('ALD-033: eligibility and reproducibility', () => {
  it('reports insufficient windows instead of deciding on too little data', () => {
    const result = evaluateAffectLeakage(
      input({
        perSeed: [
          { seed: 'short-1', windows: noLeakWindows('short-1').slice(0, 40) },
          { seed: 'short-2', windows: [] },
        ],
        permutations: 20,
      }),
    );
    expect(result.decision).toBe('insufficient-windows');
    expect(result.suspectedLeakage).toBe(true);
    expect(result.eligibleSeeds).toBe(0);
    expect(result.meetsE20WindowCount).toBe(false);
    expect(result.excessCmiUpperBoundBits).toBe(0);
    expect(result.perSeed[1]?.windows).toBe(0);
    expect(result.perSeed[1]?.eligible).toBe(false);
  });

  it('excludes an ineligible seed from the bound but still reports it', () => {
    const result = evaluateAffectLeakage(
      input({
        perSeed: [
          ...perSeed(noLeakWindows, 3, 'ok'),
          { seed: 'short', windows: noLeakWindows('short').slice(0, 25) },
        ],
      }),
    );
    expect(result.seeds).toBe(4);
    expect(result.eligibleSeeds).toBe(3);
    expect(result.perSeed.map((seed) => seed.eligible)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(result.decision).toBe('below-bound');
  });

  it('is exactly reproducible from its seed and sensitive to it', () => {
    const first = evaluateAffectLeakage(input());
    const again = evaluateAffectLeakage(input());
    expect(canonicalJson(again)).toBe(canonicalJson(first));
    const other = evaluateAffectLeakage(input({ seed: 'analysis-seed-other' }));
    expect(canonicalJson(other)).not.toBe(canonicalJson(first));
    // A different analysis seed must not flip a no-leak condition's decision.
    expect(other.decision).toBe('below-bound');
  });

  it('produces a canonicalizable attachment payload with only finite numbers', () => {
    const result = evaluateAffectLeakage(input());
    const parsed: unknown = JSON.parse(canonicalJson(result));
    expect(parsed).toEqual(result);
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'number') {
        numbers.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(result);
    expect(numbers.length).toBeGreaterThan(20);
    for (const value of numbers) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(canonicalJson(result)).toContain(AFFECT_LEAKAGE_ANALYSIS_VERSION);
  });

  it('never mutates the input windows', () => {
    const original = input();
    const snapshot = canonicalJson(original.perSeed);
    evaluateAffectLeakage(original);
    expect(canonicalJson(original.perSeed)).toBe(snapshot);
  });
});

describe('ALD-033: evaluateAffectLeakage input domain', () => {
  it('refuses malformed inputs rather than coercing them', () => {
    expect(() => evaluateAffectLeakage(input({ perSeed: [] }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ seed: '' }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ permutations: 0 }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ alpha: 0 }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ alpha: 1.2 }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ bound: -1 }))).toThrow(
      AnalysisError,
    );
    expect(() => evaluateAffectLeakage(input({ referentLevels: 1 }))).toThrow(
      AnalysisError,
    );
    expect(() =>
      evaluateAffectLeakage(input({ minimumWindowsPerSeed: 0 })),
    ).toThrow(AnalysisError);
  });

  it('refuses duplicate seed labels and out-of-range window fields', () => {
    const windows = noLeakWindows('dup').slice(0, 10);
    expect(() =>
      evaluateAffectLeakage(
        input({
          perSeed: [
            { seed: 'same', windows },
            { seed: 'same', windows },
          ],
          minimumWindowsPerSeed: 5,
          permutations: 5,
        }),
      ),
    ).toThrow(AnalysisError);

    const bad: AffectLeakageWindow[] = [
      { displayId: 'A9' as AffectDisplayId, referentTypeCode: 0, success: true },
    ];
    expect(() =>
      evaluateAffectLeakage(
        input({ perSeed: [{ seed: 's', windows: bad }], permutations: 5 }),
      ),
    ).toThrow(AnalysisError);

    expect(() =>
      evaluateAffectLeakage(
        input({
          perSeed: [
            {
              seed: 's',
              windows: [{ displayId: 'A1', referentTypeCode: 4, success: true }],
            },
          ],
          permutations: 5,
        }),
      ),
    ).toThrow(AnalysisError);

    expect(() =>
      evaluateAffectLeakage(
        input({
          perSeed: [
            {
              seed: 's',
              windows: [
                {
                  displayId: 'A1',
                  referentTypeCode: 0,
                  success: 1 as unknown as boolean,
                },
              ],
            },
          ],
          permutations: 5,
        }),
      ),
    ).toThrow(AnalysisError);
  });
});
