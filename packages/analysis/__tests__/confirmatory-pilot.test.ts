import { describe, expect, it } from 'vitest';

import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  confirmatoryPilotInvalidProbabilityUpper95,
  validateConfirmatoryPilotSummary,
  type ConfirmatoryPilotSummary,
} from '../src/index.js';

function summary(status: ConfirmatoryPilotSummary['status'] = 'not-collected'): ConfirmatoryPilotSummary {
  const complete = status === 'complete';
  return {
    schemaVersion: 2, analysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    stage: 'blinded-pilot', status,
    experiments: Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS).map(([id, memberIds]) => ({
      id: id as keyof typeof CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
      memberIds: [...memberIds], status, plannedSlots: 20,
      attemptedSlots: complete ? 20 : 0, completedSlots: complete ? 20 : 0,
      validSlots: complete ? 20 : 0, invalidSlots: 0,
      invalidProbabilityUpper95: complete ? confirmatoryPilotInvalidProbabilityUpper95(0, 20) : null,
      invalidProbabilityUpper95Method: complete ? 'wilson-score-one-sided-95' as const : null,
    })),
    members: Object.entries(CONFIRMATORY_PILOT_COMPONENTS).map(([id, components]) => ({
      id: id as keyof typeof CONFIRMATORY_PILOT_COMPONENTS,
      components: components.map((component) => ({ id: component, n: complete ? 20 : 0,
        mean: complete ? 0.1 : null, sampleSd: complete ? 0.2 : null,
        upper95Sd: complete ? 0.25 : null, upper95SdMethod: complete ? 'registered-fixture' : null })),
    })), researchFinding: false, scientificDisposition: 'not-tested',
    confirmatoryEstimateUse: false, selectionEligible: complete,
  };
}

describe('confirmatory pilot summary contract', () => {
  it('accepts a genuinely empty prospective summary and a complete 20-slot summary', () => {
    expect(() => validateConfirmatoryPilotSummary(summary())).not.toThrow();
    expect(() => validateConfirmatoryPilotSummary(summary('complete'))).not.toThrow();
    expect(confirmatoryPilotInvalidProbabilityUpper95(0, 20)).toBeCloseTo(0.11916, 5);
  });

  it('rejects partial data promoted to selection eligibility', () => {
    const partial = summary('complete');
    (partial.experiments[0] as { validSlots: number }).validSlots = 19;
    expect(() => validateConfirmatoryPilotSummary(partial as ConfirmatoryPilotSummary))
      .toThrow(/accounting|twenty/u);
  });

  it('rejects missing components, optimistic dispersion, validity bounds, and confirmatory reuse', () => {
    const missing = summary('complete');
    (missing.members[0]!.components as unknown as unknown[]).pop();
    expect(() => validateConfirmatoryPilotSummary(missing)).toThrow(/missing or reordered/u);
    const optimistic = summary('complete');
    (optimistic.members[1]!.components[0] as { upper95Sd: number }).upper95Sd = 0.1;
    expect(() => validateConfirmatoryPilotSummary(optimistic)).toThrow(/conservative dispersion/u);
    const invalidBound = summary('complete');
    (invalidBound.experiments[0] as { invalidProbabilityUpper95: number }).invalidProbabilityUpper95 = 0;
    expect(() => validateConfirmatoryPilotSummary(invalidBound)).toThrow(/missing or optimistic/u);
    const reused = { ...summary('complete'), confirmatoryEstimateUse: true } as unknown as ConfirmatoryPilotSummary;
    expect(() => validateConfirmatoryPilotSummary(reused)).toThrow(/claim boundary/u);
  });

  it('retains a failed experiment pilot without promoting the family', () => {
    const retained = summary('complete');
    const experiment = retained.experiments[0] as {
      status: 'incomplete'; validSlots: number; invalidSlots: number; invalidProbabilityUpper95: number;
    };
    experiment.status = 'incomplete'; experiment.validSlots = 19; experiment.invalidSlots = 1;
    experiment.invalidProbabilityUpper95 = confirmatoryPilotInvalidProbabilityUpper95(1, 20);
    (retained.members[0]!.components as Array<{ n: number }>).forEach((component) => { component.n = 19; });
    (retained as { status: string; selectionEligible: boolean }).status = 'incomplete';
    (retained as { status: string; selectionEligible: boolean }).selectionEligible = false;
    expect(() => validateConfirmatoryPilotSummary(retained)).not.toThrow();
  });
});
