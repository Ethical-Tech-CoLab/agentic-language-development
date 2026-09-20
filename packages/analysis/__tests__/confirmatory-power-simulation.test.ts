import { describe, expect, it } from 'vitest';

import {
  CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS,
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  CONFIRMATORY_POWER_SIMULATION_VERSION,
  confirmatoryPilotInvalidProbabilityUpper95,
  simulateConfirmatoryComponentPower,
  type ConfirmatoryPilotSummary,
} from '../src/index.js';

function pilot(sd = 0.08): ConfirmatoryPilotSummary {
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
        sampleSd: sd, upper95Sd: sd, upper95SdMethod: 'software-fixture-only' })),
    })), researchFinding: false, scientificDisposition: 'not-tested',
    confirmatoryEstimateUse: false, selectionEligible: true,
  };
}

describe('confirmatory component-power simulation', () => {
  it('replays all exact candidates and labels the unidentified joint model diagnostic-only', () => {
    const first = simulateConfirmatoryComponentPower(pilot(), 'software-fixture-seed/v1');
    const second = simulateConfirmatoryComponentPower(pilot(), 'software-fixture-seed/v1');
    expect(first).toEqual(second);
    expect(first.analysisVersion).toBe(CONFIRMATORY_POWER_SIMULATION_VERSION);
    expect(first.rows.map((row) => row.primarySeeds)).toEqual(CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS);
    expect(first.rows.every((row) => row.repetitions === 30_000)).toBe(true);
    expect(first.rows.every((row) =>
      row.diagnosticDependenceModel === 'independent-component-streams-diagnostic-only')).toBe(true);
    expect(first.rows[0]?.componentDecisionSuccesses.H5['stable-acquisition']).toBeGreaterThan(0);
    expect(first.rows[7]?.componentDecisionSuccesses.H1.disabled).toBeGreaterThan(
      first.rows[0]?.componentDecisionSuccesses.H1.disabled ?? Infinity);
    expect(first.researchFinding).toBe(false);
  });

  it('uses the registered alternative exactly for deterministic continuous fixtures', () => {
    const result = simulateConfirmatoryComponentPower(pilot(0), 'zero-dispersion-fixture/v1');
    expect(result.rows.every((row) => row.componentDecisionSuccesses.H1.disabled === 30_000)).toBe(true);
    expect(result.rows.every((row) => row.componentDecisionSuccesses.H6b['excess-cmi-bits'] === 30_000)).toBe(true);
  });

  it('rejects empty seeds and incomplete pilots', () => {
    expect(() => simulateConfirmatoryComponentPower(pilot(), '')).toThrow(/seed/u);
    const incomplete = pilot();
    (incomplete as { selectionEligible: boolean }).selectionEligible = false;
    expect(() => simulateConfirmatoryComponentPower(incomplete, 'fixture')).toThrow(/eligib/u);
  });
});
