import { describe, expect, it } from 'vitest';

import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  validateConfirmatoryPilotSummary,
  type ConfirmatoryPilotSummary,
} from '../src/index.js';

function summary(status: ConfirmatoryPilotSummary['status'] = 'not-collected'): ConfirmatoryPilotSummary {
  const complete = status === 'complete';
  return {
    schemaVersion: 1, analysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    stage: 'blinded-pilot', status, plannedSlots: 20,
    attemptedSlots: complete ? 20 : 0, completedSlots: complete ? 20 : 0,
    validSlots: complete ? 20 : 0, invalidSlots: 0,
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
  });

  it('rejects partial data promoted to selection eligibility', () => {
    const partial = summary('complete') as unknown as { validSlots: number };
    partial.validSlots = 19;
    expect(() => validateConfirmatoryPilotSummary(partial as ConfirmatoryPilotSummary))
      .toThrow(/accounting|twenty/u);
  });

  it('rejects missing components, optimistic dispersion, and confirmatory reuse', () => {
    const missing = summary('complete');
    (missing.members[0]!.components as unknown as unknown[]).pop();
    expect(() => validateConfirmatoryPilotSummary(missing)).toThrow(/missing or reordered/u);
    const optimistic = summary('complete');
    (optimistic.members[1]!.components[0] as { upper95Sd: number }).upper95Sd = 0.1;
    expect(() => validateConfirmatoryPilotSummary(optimistic)).toThrow(/conservative dispersion/u);
    const reused = { ...summary('complete'), confirmatoryEstimateUse: true } as unknown as ConfirmatoryPilotSummary;
    expect(() => validateConfirmatoryPilotSummary(reused)).toThrow(/claim boundary/u);
  });
});
