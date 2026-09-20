import { describe, expect, it } from 'vitest';

import {
  CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS,
  CONFIRMATORY_MEMBER_IDS,
  CONFIRMATORY_MONTE_CARLO_REPETITIONS,
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  confirmatoryPilotInvalidProbabilityUpper95,
  minimumConfirmatoryReserveSeeds,
  selectConfirmatoryFamilySeeds,
  type ConfirmatoryComponentSuccesses,
  type ConfirmatoryFamilySimulationRow,
  type ConfirmatoryPilotSummary,
} from '../src/index.js';

function pilot(): ConfirmatoryPilotSummary {
  return {
    schemaVersion: 2, analysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    stage: 'blinded-pilot', status: 'complete',
    experiments: Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS).map(([id, memberIds]) => ({
      id: id as keyof typeof CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
      memberIds: [...memberIds], status: 'complete', plannedSlots: 20,
      attemptedSlots: 20, completedSlots: 20, validSlots: 20, invalidSlots: 0,
      invalidProbabilityUpper95: confirmatoryPilotInvalidProbabilityUpper95(0, 20),
      invalidProbabilityUpper95Method: 'wilson-score-one-sided-95',
    })),
    members: Object.entries(CONFIRMATORY_PILOT_COMPONENTS).map(([id, components]) => ({
      id: id as keyof typeof CONFIRMATORY_PILOT_COMPONENTS,
      components: components.map((component) => ({ id: component, n: 20, mean: 0,
        sampleSd: 0.2, upper95Sd: 0.25, upper95SdMethod: 'test-fixture' })),
    })), researchFinding: false, scientificDisposition: 'not-tested',
    confirmatoryEstimateUse: false, selectionEligible: true,
  };
}

function rows(firstPassingIndex: number | null): ConfirmatoryFamilySimulationRow[] {
  return CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS.map((primarySeeds, index) => {
    const successes = firstPassingIndex !== null && index >= firstPassingIndex ? 30_000 : 27_000;
    return {
      primarySeeds, repetitions: CONFIRMATORY_MONTE_CARLO_REPETITIONS,
      componentDecisionSuccesses: Object.fromEntries(
        CONFIRMATORY_MEMBER_IDS.map((id) => [id, Object.fromEntries(
          CONFIRMATORY_PILOT_COMPONENTS[id].map((component) => [component, successes]),
        )]),
      ) as ConfirmatoryComponentSuccesses,
      diagnosticDependenceModel: 'independent-component-streams-diagnostic-only',
      diagnosticJointDecisionSuccesses: 30_000,
    };
  });
}

describe('dependence-robust confirmatory-family seed selection', () => {
  it('chooses the first robust candidate and returns corrected experiment reserves', () => {
    const selection = selectConfirmatoryFamilySeeds(rows(1), pilot());
    expect(selection.selectedPrimarySeeds).toBe(50);
    expect(selection.selectedReserveSeedsByExperiment?.E11).toBe(12);
    expect(selection.rows[0]?.diagnosticJointLower95Power).toBeGreaterThan(0.99);
    expect(selection.rows[0]?.passesDependenceRobustPower).toBe(false);
    expect(selection.resourceAuthorizationRequired).toBe(true);
    expect(selection.researchFinding).toBe(false);
  });

  it('blocks selection when no dependence-robust candidate passes', () => {
    const selection = selectConfirmatoryFamilySeeds(rows(null), pilot());
    expect(selection.selectedPrimarySeeds).toBeNull();
    expect(selection.requiresPowerOrDesignAmendment).toBe(true);
  });

  it('rejects an incomplete pilot and incomplete member simulations', () => {
    const incomplete = pilot();
    (incomplete as { status: string; selectionEligible: boolean }).status = 'incomplete';
    (incomplete as { status: string; selectionEligible: boolean }).selectionEligible = false;
    expect(() => selectConfirmatoryFamilySeeds(rows(1), incomplete)).toThrow(/status contradicts|eligible/u);
    const malformed = rows(1);
    delete (malformed[0]!.componentDecisionSuccesses as Partial<Record<string, unknown>>).H8;
    expect(() => selectConfirmatoryFamilySeeds(malformed, pilot())).toThrow(/complete ordered/u);
    const unidentified = rows(1);
    (unidentified[0] as { diagnosticDependenceModel: string }).diagnosticDependenceModel = 'unspecified';
    expect(() => selectConfirmatoryFamilySeeds(unidentified, pilot())).toThrow(/complete ordered/u);
  });

  it('reproduces the prospective minimal reserve endpoints', () => {
    const invalidUpper = confirmatoryPilotInvalidProbabilityUpper95(0, 20);
    expect(minimumConfirmatoryReserveSeeds(25, invalidUpper).reserveSeeds).toBe(7);
    expect(minimumConfirmatoryReserveSeeds(300, invalidUpper).reserveSeeds).toBe(52);
  });
});
