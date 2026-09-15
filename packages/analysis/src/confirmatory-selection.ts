/** Outcome-blind selection from complete, externally simulated joint-family rows. */
import { wilsonInterval } from './descriptive.js';
import { AnalysisError } from './errors.js';

export interface ConfirmatoryFamilySelectionRule {
  readonly candidatePrimarySeeds: readonly number[];
  readonly monteCarloRepetitionsPerCandidate: number;
  readonly minimumLower95JointPower: number;
}

export interface ConfirmatoryFamilySimulationRow {
  readonly primarySeeds: number;
  readonly repetitions: number;
  readonly completeJointDecisionSuccesses: number;
}

export interface ConfirmatoryFamilySelection {
  readonly selectedPrimarySeeds: number | null;
  readonly requiresProspectiveAmendment: boolean;
  readonly rows: readonly {
    primarySeeds: number;
    completeJointDecisionSuccesses: number;
    estimatedJointPower: number;
    lower95JointPower: number;
    upper95JointPower: number;
  }[];
  readonly researchFinding: false;
  readonly claimBoundary: string;
}

export function selectConfirmatoryFamilySeeds(
  rows: readonly ConfirmatoryFamilySimulationRow[],
  rule: ConfirmatoryFamilySelectionRule,
): ConfirmatoryFamilySelection {
  const candidates = rule.candidatePrimarySeeds;
  if (candidates.length === 0 || candidates.some((n, index) =>
    !Number.isInteger(n) || n < 1 || (index > 0 && n <= candidates[index - 1]!)) ||
    !Number.isInteger(rule.monteCarloRepetitionsPerCandidate) ||
    rule.monteCarloRepetitionsPerCandidate < 1 ||
    !(rule.minimumLower95JointPower > 0 && rule.minimumLower95JointPower < 1)) {
    throw new AnalysisError('domain', 'invalid prospective confirmatory-family selection rule');
  }
  if (rows.length !== candidates.length || rows.some((row, index) =>
    row.primarySeeds !== candidates[index] ||
    row.repetitions !== rule.monteCarloRepetitionsPerCandidate ||
    !Number.isInteger(row.completeJointDecisionSuccesses) ||
    row.completeJointDecisionSuccesses < 0 ||
    row.completeJointDecisionSuccesses > row.repetitions)) {
    throw new AnalysisError('domain', 'complete ordered joint-family simulation rows are required');
  }
  const evaluated = rows.map((row) => {
    const interval = wilsonInterval(row.completeJointDecisionSuccesses, row.repetitions);
    return {
      primarySeeds: row.primarySeeds,
      completeJointDecisionSuccesses: row.completeJointDecisionSuccesses,
      estimatedJointPower: interval.proportion,
      lower95JointPower: interval.lower,
      upper95JointPower: interval.upper,
    };
  });
  const selectedPrimarySeeds = evaluated.find((row) =>
    row.lower95JointPower >= rule.minimumLower95JointPower)?.primarySeeds ?? null;
  return {
    selectedPrimarySeeds, requiresProspectiveAmendment: selectedPrimarySeeds === null,
    rows: evaluated, researchFinding: false,
    claimBoundary: 'Outcome-blind nine-member joint-power selection only; not a pilot result, confirmatory outcome, or scientific finding.',
  };
}
