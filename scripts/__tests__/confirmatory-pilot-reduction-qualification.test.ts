import { describe, expect, it } from 'vitest';

import { runConfirmatoryPilotReductionQualification } from
  '../qualify-confirmatory-pilot-reduction.mjs';

describe('confirmatory pilot-reduction independent-R qualification', () => {
  it('checks all fourteen synthetic components and four negative controls', () => {
    const result = runConfirmatoryPilotReductionQualification();
    expect(result).toMatchObject({
      experiments: 7,
      slotsPerExperiment: 20,
      components: 14,
      componentObservations: 280,
      rejectedMutationCases: 4,
      selectionAdmitted: false,
      researchFinding: false,
    });
    expect(result.independentReference.comparisons).toBe(42);
    expect(result.independentReference.rows).toHaveLength(14);
    expect(result.independentReference.maximumAbsoluteDifference).toBeLessThan(1e-12);
  });
});
