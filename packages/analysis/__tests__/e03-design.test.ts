import { describe, expect, it } from 'vitest';

import {
  E03_COMMUNICATION_CONDITIONS,
  E03_DESIGN_ROWS,
  E03_SEED_ROOT,
  buildE03SeedManifest,
  simulateE03DesignPower,
} from '../src/e03-design.js';
import { deriveSeedHex } from '@ald/hashing';

describe('E03 outcome-blind design simulation', () => {
  it('reproduces all four component rows above the 90% power floor', () => {
    const result = simulateE03DesignPower();
    expect(result.scope).toBe('single-control-equivalence-component');
    expect(result.registrationFacingReceipt).toBe(
      'reports/research/statistical-validation.tsv',
    );
    expect(result.repetitions).toBe(30_000);
    expect(result.rows).toHaveLength(E03_DESIGN_ROWS.length);
    expect(result.passes).toBe(true);
    expect(result.rows.every((row) => row.monteCarloLower95 >= 0.9)).toBe(true);
  });

  it('is byte-for-byte deterministic for a fixed seed', () => {
    const options = { repetitions: 500, seed: 'fixed-design-seed' } as const;
    expect(simulateE03DesignPower(options)).toEqual(
      simulateE03DesignPower(options),
    );
  });

  it('rejects malformed designs instead of emitting a power decision', () => {
    expect(() => simulateE03DesignPower({ repetitions: 0 })).toThrow(
      /positive integer/u,
    );
    expect(() =>
      simulateE03DesignPower({
        rows: [{ maximumBetweenSeedSd: 0.1, primarySeeds: 1 }],
      }),
    ).toThrow(/at least two seeds/u);
  });
});

describe('E03 primary and reserve seed manifest', () => {
  it('derives a zero-reserve twenty-slot pilot in the global stage domain', () => {
    const manifest = buildE03SeedManifest('blinded-pilot', 20);
    expect(manifest).toMatchObject({
      version: 2,
      claimBoundary: 'prospective-seed-allocation-only',
      seedRoot: E03_SEED_ROOT,
      stage: 'blinded-pilot',
      seedDomain: 'blinded-pilot',
      primarySeeds: 20,
      reserveSeeds: 0,
    });
    expect(manifest.entries).toHaveLength(20);
    expect(manifest.entries.every((entry) => entry.use === 'primary')).toBe(true);
  });

  it('allocates a disjoint prospective v2 pilot namespace without changing v1', () => {
    const original = buildE03SeedManifest('blinded-pilot', 20);
    const amended = buildE03SeedManifest('blinded-pilot', 20, 'v2');
    expect(amended.attemptVersion).toBe('v2');
    expect(amended.reserveSeeds).toBe(0);
    const allSeeds = (manifest: typeof original) => manifest.entries.flatMap((entry) =>
      [entry.scenarioSeed, ...Object.values(entry.conditionSeeds).flatMap(Object.values)]);
    expect(new Set([...allSeeds(original), ...allSeeds(amended)]).size).toBe(
      allSeeds(original).length + allSeeds(amended).length);
  });

  it('derives full component bindings and ten-percent ordered reserves', () => {
    const manifest = buildE03SeedManifest('full-qualification', 75);
    expect(manifest.primarySeeds).toBe(75);
    expect(manifest.reserveSeeds).toBe(8);
    expect(manifest.entries).toHaveLength(83);
    const first = manifest.entries[0]!;
    expect(first.scenarioSeed).toBe(
      deriveSeedHex(E03_SEED_ROOT, 'confirmatory', 'E03', '1', 'scenario'),
    );
    expect(Object.keys(first.conditionSeeds)).toEqual(E03_COMMUNICATION_CONDITIONS);
    expect(first.conditionSeeds.normal.babyA).toBe(
      deriveSeedHex(
        E03_SEED_ROOT,
        'confirmatory',
        'E03',
        'normal-no-learning',
        '1',
        'baby-a',
        'learner',
      ),
    );
    const allSeeds = [
      first.scenarioSeed,
      ...Object.values(first.conditionSeeds).flatMap(Object.values),
    ];
    expect(new Set(allSeeds).size).toBe(allSeeds.length);
    expect(manifest.entries[74]?.use).toBe('primary');
    expect(manifest.entries[75]?.use).toBe('reserve');
    expect(buildE03SeedManifest('full-qualification', 75)).toEqual(manifest);
  });

  it('keeps pilot and full-qualification seed domains disjoint', () => {
    const pilot = buildE03SeedManifest('blinded-pilot', 20);
    const full = buildE03SeedManifest('full-qualification', 25);
    const flatten = (manifest: typeof pilot) => manifest.entries.flatMap((entry) => [
      entry.scenarioSeed,
      ...Object.values(entry.conditionSeeds).flatMap(Object.values),
    ]);
    const pilotSeeds = new Set(flatten(pilot));
    expect(flatten(full).every((seed) => !pilotSeeds.has(seed))).toBe(true);
    expect(() => buildE03SeedManifest('blinded-pilot', 19)).toThrow(/exactly 20/u);
  });
});
