import { describe, expect, it } from 'vitest';

import {
  E03_DESIGN_ROWS,
  buildE03SeedManifest,
  simulateE03DesignPower,
} from '../src/e03-design.js';

describe('E03 outcome-blind design simulation', () => {
  it('reproduces all four registered rows above the 90% power floor', () => {
    const result = simulateE03DesignPower();
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
  it('derives the registered slots and ten-percent reserve deterministically', () => {
    const manifest = buildE03SeedManifest(75);
    expect(manifest.primarySeeds).toBe(75);
    expect(manifest.reserveSeeds).toBe(8);
    expect(manifest.entries).toHaveLength(83);
    expect(manifest.entries[0]).toEqual({
      slot: 1,
      use: 'primary',
      scenarioSeed:
        '5a64e3d3b490b4d5f4dbb89d7f8801a3ec53f8815c6731a8bce7cb691474eadd',
      gatewaySeeds: {
        random:
          'd3b41fe5c9ea0807e97d589b561d11f0b91a83c65485f29f83d0b7f7b1e28563',
        shuffled:
          'bc4976f8f3111d97be5fc80badb0632b241e4204b78d04b863e630215d860423',
      },
    });
    expect(manifest.entries[74]?.use).toBe('primary');
    expect(manifest.entries[75]?.use).toBe('reserve');
    expect(buildE03SeedManifest(75)).toEqual(manifest);
  });
});
