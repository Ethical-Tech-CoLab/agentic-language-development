import { describe, expect, it } from 'vitest';

import {
  E03_NON_ORACLE_CONDITIONS,
  reduceE03Pilot,
  type E03PilotConditionInput,
} from '../src/index.js';

function pilot(successes: (condition: string, slot: number) => number): E03PilotConditionInput[] {
  return E03_NON_ORACLE_CONDITIONS.map((condition) => ({
    condition,
    tallies: Array.from({ length: 20 }, (_unused, index) => ({
      slot: index + 1,
      seed: `pilot-${String(index + 1)}`,
      agreements: successes(condition, index + 1),
      probes: 200,
    })),
  }));
}

describe('E03 outcome-blind pilot reduction', () => {
  it('selects the frozen row without evaluating the E03 hypothesis', () => {
    const result = reduceE03Pilot(pilot((_condition, slot) => 48 + (slot % 5)));
    expect(result.selectedPrimarySeeds).toBe(25);
    expect(result.requiresProspectiveAmendment).toBe(false);
    expect(result.conditions).toHaveLength(5);
    expect(result.scientificDisposition).toBe('not-tested');
    expect(result.researchFinding).toBe(false);
    expect(result).not.toHaveProperty('qualifies');
    expect(result).not.toHaveProperty('oracle');
    expect(reduceE03Pilot(pilot((_condition, slot) => 48 + (slot % 5)))).toEqual(result);
  });

  it('blocks the fixed table when pilot dispersion exceeds its ceiling', () => {
    const result = reduceE03Pilot(
      pilot((_condition, slot) => (slot % 2 === 0 ? 5 : 195)),
    );
    expect(result.largestLatentPilotSd).toBeGreaterThan(0.2);
    expect(result.selectedPrimarySeeds).toBeNull();
    expect(result.requiresProspectiveAmendment).toBe(true);
  });

  it('requires exactly twenty valid paired slots in every unique control', () => {
    const missing = pilot(() => 50);
    missing[0] = { ...missing[0]!, tallies: missing[0]!.tallies.slice(1) };
    expect(() => reduceE03Pilot(missing)).toThrow(/exactly 20/u);

    const duplicate = pilot(() => 50);
    duplicate[1] = { ...duplicate[0]! };
    expect(() => reduceE03Pilot(duplicate)).toThrow(/complete and unique/u);

    const malformed = pilot(() => 50);
    malformed[0] = {
      ...malformed[0]!,
      tallies: [{ ...malformed[0]!.tallies[0]!, agreements: 201 }, ...malformed[0]!.tallies.slice(1)],
    };
    expect(() => reduceE03Pilot(malformed)).toThrow(/invalid E03 pilot tally/u);
  });
});
