import { describe, expect, it } from 'vitest';

import { selectConfirmatoryFamilySeeds } from '../src/confirmatory-selection.js';

const rule = { candidatePrimarySeeds: [75, 100, 125],
  monteCarloRepetitionsPerCandidate: 30_000, minimumLower95JointPower: 0.90 };
const row = (primarySeeds: number, completeJointDecisionSuccesses: number) => ({
  primarySeeds, repetitions: 30_000, completeJointDecisionSuccesses,
});

describe('prospective complete-family seed selection', () => {
  it('chooses the smallest shared candidate whose joint Wilson lower bound passes', () => {
    const selection = selectConfirmatoryFamilySeeds([
      row(75, 21_000), row(100, 27_300), row(125, 28_000),
    ], rule);
    expect(selection.selectedPrimarySeeds).toBe(100);
    expect(selection.requiresProspectiveAmendment).toBe(false);
    expect(selection.researchFinding).toBe(false);
  });

  it('does not substitute a member-specific minimum for underpowered joint power', () => {
    const selection = selectConfirmatoryFamilySeeds([
      row(75, 21_000), row(100, 26_700), row(125, 28_000),
    ], rule);
    expect(selection.rows[1]?.lower95JointPower).toBeLessThan(0.90);
    expect(selection.selectedPrimarySeeds).toBe(125);
  });

  it('blocks registration when no candidate passes', () => {
    const selection = selectConfirmatoryFamilySeeds([
      row(75, 20_000), row(100, 23_000), row(125, 26_000),
    ], rule);
    expect(selection.selectedPrimarySeeds).toBeNull();
    expect(selection.requiresProspectiveAmendment).toBe(true);
  });

  it('rejects incomplete, out-of-order, or fabricated repetition counts', () => {
    expect(() => selectConfirmatoryFamilySeeds([row(75, 30_000)], rule)).toThrow(/complete ordered/u);
    expect(() => selectConfirmatoryFamilySeeds([
      row(100, 27_300), row(75, 21_000), row(125, 28_000),
    ], rule)).toThrow(/complete ordered/u);
    expect(() => selectConfirmatoryFamilySeeds([
      row(75, 21_000), { ...row(100, 27_300), repetitions: 10_000 }, row(125, 28_000),
    ], rule)).toThrow(/complete ordered/u);
  });
});
