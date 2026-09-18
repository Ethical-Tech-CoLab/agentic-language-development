import { describe, expect, it } from 'vitest';

import { runE03FullCollectorQualificationFixtures } from '../check-e03-full-collector-qualification.mjs';

describe('E03 full collector and analysis software qualification', () => {
  it('exercises a pass, normal numeric failure, paired replacement, and exhaustion', () => {
    expect(runE03FullCollectorQualificationFixtures()).toEqual({
      qualifyingNumericFixture: { disposition: 'thresholds-met', pairs: 25 },
      numericFailureFixture: { disposition: 'thresholds-not-met', pairs: 25 },
      pairedReserveFixture: {
        disposition: 'thresholds-met',
        replacements: 1,
        validButExcludedCompanions: 5,
      },
      exhaustionFixture: { disposition: 'incomplete', pairs: 24 },
    });
  });
});
