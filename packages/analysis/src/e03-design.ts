/**
 * Reproducible E03 design simulation and seed manifest (RESEARCH.md Appendix D
 * §D.4 and §D.7).
 *
 * The design check models seed-level success rates as normal with variance
 * equal to the registered between-seed variance plus the binomial sampling
 * variance from 200 episodes. For each Monte Carlo replicate it samples the
 * sufficient statistics of a normal sample directly: the sample mean and the
 * independent chi-square sample variance. The registered TOST interval then
 * determines whether equivalence to the [0.20, 0.30] bounds would be declared.
 *
 * This is an outcome-blind power calculation, not an experiment result.
 */
import { SeededPrng, deriveSeedHex } from '@ald/hashing';

import { AnalysisError, assertLevel, assertProbability } from './errors.js';
import { studentTQuantile } from './special.js';

export const E03_DESIGN_SIMULATION_VERSION = 1;
export const E03_DESIGN_REPETITIONS = 30_000;
export const E03_DESIGN_MINIMUM_POWER = 0.9;
export const E03_DESIGN_SEED = 'ald-e03-v1-design-check';
export const E03_SEED_LABEL = 'ald-e03-v1';

export const E03_DESIGN_ROWS = [
  { maximumBetweenSeedSd: 0.05, primarySeeds: 25 },
  { maximumBetweenSeedSd: 0.1, primarySeeds: 75 },
  { maximumBetweenSeedSd: 0.15, primarySeeds: 155 },
  { maximumBetweenSeedSd: 0.2, primarySeeds: 300 },
] as const;

export const E03_COMMUNICATION_CONDITIONS = [
  'disabled',
  'constant',
  'random',
  'shuffled',
  'normal',
  'oracle',
] as const;

export interface E03DesignSimulationOptions {
  readonly repetitions?: number;
  readonly mean?: number;
  readonly episodesPerSeed?: number;
  readonly equivalenceLower?: number;
  readonly equivalenceUpper?: number;
  readonly alpha?: number;
  readonly minimumPower?: number;
  readonly seed?: string;
  readonly rows?: readonly {
    readonly maximumBetweenSeedSd: number;
    readonly primarySeeds: number;
  }[];
}

export interface E03DesignPowerRow {
  readonly maximumBetweenSeedSd: number;
  readonly primarySeeds: number;
  readonly totalSeedRateSd: number;
  readonly equivalentReplicates: number;
  readonly repetitions: number;
  readonly estimatedPower: number;
  readonly monteCarloStandardError: number;
  readonly monteCarloLower95: number;
  readonly passesMinimumPower: boolean;
}

export interface E03DesignSimulation {
  readonly version: typeof E03_DESIGN_SIMULATION_VERSION;
  readonly claimBoundary: 'outcome-blind-design-simulation';
  readonly samplingModel: 'normal-seed-rate-with-binomial-episode-variance';
  readonly seed: string;
  readonly repetitions: number;
  readonly mean: number;
  readonly episodesPerSeed: number;
  readonly equivalenceBounds: readonly [number, number];
  readonly alpha: number;
  readonly minimumPower: number;
  readonly rows: E03DesignPowerRow[];
  readonly passes: boolean;
}

export interface E03SeedManifestEntry {
  readonly slot: number;
  readonly use: 'primary' | 'reserve';
  readonly scenarioSeed: string;
  readonly gatewaySeeds: {
    readonly random: string;
    readonly shuffled: string;
  };
}

export interface E03SeedManifest {
  readonly version: 1;
  readonly seedLabel: typeof E03_SEED_LABEL;
  readonly primarySeeds: number;
  readonly reserveSeeds: number;
  readonly conditions: typeof E03_COMMUNICATION_CONDITIONS;
  readonly entries: E03SeedManifestEntry[];
}

class NormalSampler {
  #spare: number | undefined;

  constructor(private readonly prng: SeededPrng) {}

  next(): number {
    if (this.#spare !== undefined) {
      const value = this.#spare;
      this.#spare = undefined;
      return value;
    }
    let first = 0;
    let second = 0;
    while (first === 0) first = this.prng.nextFloat();
    while (second === 0) second = this.prng.nextFloat();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    this.#spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
}

/** Marsaglia-Tsang gamma sampler, shape >= 1, scale 1. */
function sampleGamma(shape: number, prng: SeededPrng): number {
  const normal = new NormalSampler(prng);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = normal.next();
    const base = 1 + c * z;
    if (base <= 0) continue;
    const v = base * base * base;
    const u = prng.nextFloat();
    if (
      u < 1 - 0.0331 * z ** 4 ||
      Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))
    ) {
      return d * v;
    }
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new AnalysisError('domain', `${label} must be a positive integer`);
  }
}

export function simulateE03DesignPower(
  options: E03DesignSimulationOptions = {},
): E03DesignSimulation {
  const repetitions = options.repetitions ?? E03_DESIGN_REPETITIONS;
  const mean = options.mean ?? 0.25;
  const episodesPerSeed = options.episodesPerSeed ?? 200;
  const lower = options.equivalenceLower ?? 0.2;
  const upper = options.equivalenceUpper ?? 0.3;
  const alpha = options.alpha ?? 0.01;
  const minimumPower = options.minimumPower ?? E03_DESIGN_MINIMUM_POWER;
  const seed = options.seed ?? E03_DESIGN_SEED;
  const rows = options.rows ?? E03_DESIGN_ROWS;

  positiveInteger(repetitions, 'repetitions');
  positiveInteger(episodesPerSeed, 'episodesPerSeed');
  assertProbability(mean, 'mean');
  assertLevel(alpha, 'alpha');
  assertProbability(minimumPower, 'minimumPower');
  if (!(lower < mean && mean < upper)) {
    throw new AnalysisError(
      'domain',
      'equivalence bounds must contain the simulated mean',
    );
  }

  const results = rows.map((row, rowIndex): E03DesignPowerRow => {
    positiveInteger(row.primarySeeds, `rows[${rowIndex}].primarySeeds`);
    if (!(row.maximumBetweenSeedSd > 0)) {
      throw new AnalysisError(
        'domain',
        `rows[${rowIndex}].maximumBetweenSeedSd must be positive`,
      );
    }
    const df = row.primarySeeds - 1;
    if (df < 1) {
      throw new AnalysisError('domain', 'each design row requires at least two seeds');
    }
    const totalVariance =
      row.maximumBetweenSeedSd ** 2 +
      (mean * (1 - mean)) / episodesPerSeed;
    const totalSeedRateSd = Math.sqrt(totalVariance);
    const critical = studentTQuantile(1 - alpha, df);
    const prng = new SeededPrng(`${seed}/row-${String(rowIndex + 1)}`);
    const normal = new NormalSampler(prng);
    let equivalentReplicates = 0;

    for (let replicate = 0; replicate < repetitions; replicate += 1) {
      const sampleMean =
        mean + (totalSeedRateSd / Math.sqrt(row.primarySeeds)) * normal.next();
      const chiSquare = 2 * sampleGamma(df / 2, prng);
      const sampleSd = totalSeedRateSd * Math.sqrt(chiSquare / df);
      const halfWidth = critical * (sampleSd / Math.sqrt(row.primarySeeds));
      if (sampleMean - halfWidth > lower && sampleMean + halfWidth < upper) {
        equivalentReplicates += 1;
      }
    }

    const estimatedPower = equivalentReplicates / repetitions;
    const monteCarloStandardError = Math.sqrt(
      (estimatedPower * (1 - estimatedPower)) / repetitions,
    );
    const monteCarloLower95 = estimatedPower - 1.96 * monteCarloStandardError;
    return {
      maximumBetweenSeedSd: row.maximumBetweenSeedSd,
      primarySeeds: row.primarySeeds,
      totalSeedRateSd,
      equivalentReplicates,
      repetitions,
      estimatedPower,
      monteCarloStandardError,
      monteCarloLower95,
      passesMinimumPower: monteCarloLower95 >= minimumPower,
    };
  });

  return {
    version: E03_DESIGN_SIMULATION_VERSION,
    claimBoundary: 'outcome-blind-design-simulation',
    samplingModel: 'normal-seed-rate-with-binomial-episode-variance',
    seed,
    repetitions,
    mean,
    episodesPerSeed,
    equivalenceBounds: [lower, upper],
    alpha,
    minimumPower,
    rows: results,
    passes: results.every((row) => row.passesMinimumPower),
  };
}

export function buildE03SeedManifest(primarySeeds: number): E03SeedManifest {
  positiveInteger(primarySeeds, 'primarySeeds');
  const reserveSeeds = Math.ceil(primarySeeds * 0.1);
  const entries = Array.from(
    { length: primarySeeds + reserveSeeds },
    (_, index): E03SeedManifestEntry => {
      const slot = index + 1;
      const scenarioSeed = deriveSeedHex(E03_SEED_LABEL, String(slot));
      return {
        slot,
        use: slot <= primarySeeds ? 'primary' : 'reserve',
        scenarioSeed,
        gatewaySeeds: {
          random: deriveSeedHex(scenarioSeed, 'random'),
          shuffled: deriveSeedHex(scenarioSeed, 'shuffled'),
        },
      };
    },
  );
  return {
    version: 1,
    seedLabel: E03_SEED_LABEL,
    primarySeeds,
    reserveSeeds,
    conditions: E03_COMMUNICATION_CONDITIONS,
    entries,
  };
}
