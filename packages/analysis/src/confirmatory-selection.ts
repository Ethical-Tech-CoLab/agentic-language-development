/** Outcome-blind selection from complete component-power simulations and an eligible pilot. */
import { wilsonInterval } from './descriptive.js';
import { AnalysisError } from './errors.js';
import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  validateConfirmatoryPilotSummary,
  type ConfirmatoryMemberId,
  type ConfirmatoryPilotExperimentId,
  type ConfirmatoryPilotSummary,
} from './confirmatory-pilot.js';

export const CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS = [25, 50, 75, 100, 125, 150, 200, 300] as const;
export const CONFIRMATORY_MONTE_CARLO_REPETITIONS = 30_000;
export const CONFIRMATORY_MINIMUM_FAMILY_POWER_LOWER95 = 0.90;
export const CONFIRMATORY_MINIMUM_RESERVE_ADEQUACY = 0.95;
export const CONFIRMATORY_COMPONENT_POWER_WILSON_CONFIDENCE = 1 - 2 * (0.05 / 14);
export const CONFIRMATORY_MEMBER_IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6a', 'H6b', 'H7', 'H8'] as const;

export type ConfirmatoryComponentSuccesses = {
  readonly [Member in ConfirmatoryMemberId]: Readonly<Record<
    (typeof CONFIRMATORY_PILOT_COMPONENTS)[Member][number], number>>;
};

export interface ConfirmatoryFamilySimulationRow {
  readonly primarySeeds: number;
  readonly repetitions: 30_000;
  readonly componentDecisionSuccesses: ConfirmatoryComponentSuccesses;
  readonly diagnosticDependenceModel: 'independent-component-streams-diagnostic-only';
  readonly diagnosticJointDecisionSuccesses: number;
}

export interface ConfirmatoryFamilySelection {
  readonly selectedPrimarySeeds: number | null;
  readonly selectedReserveSeedsByExperiment: Readonly<Record<ConfirmatoryPilotExperimentId, number>> | null;
  readonly requiresPowerOrDesignAmendment: boolean;
  readonly resourceAuthorizationRequired: true;
  readonly rows: readonly {
    primarySeeds: number;
    members: readonly {
      id: ConfirmatoryMemberId;
      components: readonly {
        id: string;
        decisionSuccesses: number;
        estimatedPower: number;
        simultaneousLower95Power: number;
        simultaneousUpper95Power: number;
      }[];
      dependenceRobustLower95Power: number;
    }[];
    dependenceRobustFamilyLower95Power: number;
    diagnosticJointPower: number;
    diagnosticJointLower95Power: number;
    diagnosticJointUpper95Power: number;
    reserves: readonly {
      experimentId: ConfirmatoryPilotExperimentId;
      invalidProbabilityUpper95: number;
      reserveSeeds: number;
      adequacyProbability: number;
    }[];
    minimumReserveAdequacy: number;
    passesDependenceRobustPower: boolean;
    passesReserveAdequacy: boolean;
    selectionEligible: boolean;
  }[];
  readonly researchFinding: false;
  readonly claimBoundary: string;
}

/** Stable binomial probability that at most `reserves` of `attempts` are invalid. */
export function binomialInvalidAtMostProbability(
  reserves: number,
  attempts: number,
  invalidProbability: number,
): number {
  if (!Number.isInteger(reserves) || reserves < 0 || !Number.isInteger(attempts) ||
      attempts < 1 || reserves >= attempts || !Number.isFinite(invalidProbability) ||
      invalidProbability < 0 || invalidProbability > 1) {
    throw new AnalysisError('domain', 'invalid binomial reserve-adequacy inputs');
  }
  if (invalidProbability === 0) return 1;
  if (invalidProbability === 1) return 0;
  const logTerms: number[] = [];
  let logCombination = 0;
  for (let invalid = 0; invalid <= reserves; invalid += 1) {
    logTerms.push(logCombination + invalid * Math.log(invalidProbability) +
      (attempts - invalid) * Math.log1p(-invalidProbability));
    logCombination += Math.log(attempts - invalid) - Math.log(invalid + 1);
  }
  const maximum = Math.max(...logTerms);
  return Math.exp(maximum) * logTerms.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
}

export function minimumConfirmatoryReserveSeeds(
  primarySeeds: number,
  invalidProbabilityUpper95: number,
  minimumAdequacy = CONFIRMATORY_MINIMUM_RESERVE_ADEQUACY,
): { reserveSeeds: number; adequacyProbability: number } {
  if (!Number.isInteger(primarySeeds) || primarySeeds < 1 ||
      !Number.isFinite(invalidProbabilityUpper95) || invalidProbabilityUpper95 < 0 ||
      invalidProbabilityUpper95 >= 1 || !(minimumAdequacy > 0 && minimumAdequacy < 1)) {
    throw new AnalysisError('domain', 'invalid confirmatory reserve-selection inputs');
  }
  for (let reserveSeeds = 0; reserveSeeds <= 10_000; reserveSeeds += 1) {
    const adequacyProbability = binomialInvalidAtMostProbability(
      reserveSeeds, primarySeeds + reserveSeeds, invalidProbabilityUpper95,
    );
    if (adequacyProbability >= minimumAdequacy) return { reserveSeeds, adequacyProbability };
  }
  throw new AnalysisError('domain', 'confirmatory reserve requirement exceeds the bounded design space');
}

function successCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > CONFIRMATORY_MONTE_CARLO_REPETITIONS) {
    throw new AnalysisError('domain', `${label} must be a complete Monte Carlo success count`);
  }
}

export function selectConfirmatoryFamilySeeds(
  rows: readonly ConfirmatoryFamilySimulationRow[],
  pilot: ConfirmatoryPilotSummary,
): ConfirmatoryFamilySelection {
  validateConfirmatoryPilotSummary(pilot);
  if (pilot.analysisVersion !== CONFIRMATORY_PILOT_SUMMARY_VERSION || !pilot.selectionEligible) {
    throw new AnalysisError('domain', 'a complete selection-eligible confirmatory pilot is required');
  }
  if (rows.length !== CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS.length) {
    throw new AnalysisError('domain', 'all ordered confirmatory simulation candidates are required');
  }
  const evaluated = rows.map((row, rowIndex) => {
    if (row.primarySeeds !== CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS[rowIndex] ||
        row.repetitions !== CONFIRMATORY_MONTE_CARLO_REPETITIONS ||
        row.diagnosticDependenceModel !== 'independent-component-streams-diagnostic-only' ||
        Object.keys(row.componentDecisionSuccesses).join(',') !== CONFIRMATORY_MEMBER_IDS.join(',')) {
      throw new AnalysisError('domain', 'complete ordered confirmatory component simulations are required');
    }
    const members = CONFIRMATORY_MEMBER_IDS.map((id) => {
      const expectedComponents: readonly string[] = CONFIRMATORY_PILOT_COMPONENTS[id];
      const supplied = row.componentDecisionSuccesses[id] as Readonly<Record<string, number>>;
      if (Object.keys(supplied).join(',') !== expectedComponents.join(',')) {
        throw new AnalysisError('domain', 'complete ordered confirmatory component simulations are required');
      }
      const components = expectedComponents.map((componentId) => {
        const successes = supplied[componentId]!;
        successCount(successes, `${row.primarySeeds}.${id}.${componentId}`);
        const interval = wilsonInterval(successes, row.repetitions,
          CONFIRMATORY_COMPONENT_POWER_WILSON_CONFIDENCE);
        return { id: componentId, decisionSuccesses: successes, estimatedPower: interval.proportion,
          simultaneousLower95Power: interval.lower, simultaneousUpper95Power: interval.upper };
      });
      return { id, components, dependenceRobustLower95Power: Math.max(0,
        1 - components.reduce((sum, component) => sum + (1 - component.simultaneousLower95Power), 0)) };
    });
    successCount(row.diagnosticJointDecisionSuccesses, `${row.primarySeeds}.diagnosticJoint`);
    const diagnostic = wilsonInterval(row.diagnosticJointDecisionSuccesses, row.repetitions);
    const dependenceRobustFamilyLower95Power = Math.max(0, 1 - members.reduce((memberSum, member) =>
      memberSum + member.components.reduce((componentSum, component) =>
        componentSum + (1 - component.simultaneousLower95Power), 0), 0));
    const reserves = Object.keys(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS).map((id) => {
      const experimentId = id as ConfirmatoryPilotExperimentId;
      const experiment = pilot.experiments.find((entry) => entry.id === experimentId)!;
      const invalidProbabilityUpper95 = experiment.invalidProbabilityUpper95!;
      const reserve = minimumConfirmatoryReserveSeeds(row.primarySeeds, invalidProbabilityUpper95);
      return { experimentId, invalidProbabilityUpper95, ...reserve };
    });
    const minimumReserveAdequacy = Math.min(...reserves.map((entry) => entry.adequacyProbability));
    const passesDependenceRobustPower = dependenceRobustFamilyLower95Power >=
      CONFIRMATORY_MINIMUM_FAMILY_POWER_LOWER95;
    const passesReserveAdequacy = minimumReserveAdequacy >= CONFIRMATORY_MINIMUM_RESERVE_ADEQUACY;
    return {
      primarySeeds: row.primarySeeds, members, dependenceRobustFamilyLower95Power,
      diagnosticJointPower: diagnostic.proportion,
      diagnosticJointLower95Power: diagnostic.lower,
      diagnosticJointUpper95Power: diagnostic.upper,
      reserves, minimumReserveAdequacy, passesDependenceRobustPower, passesReserveAdequacy,
      selectionEligible: passesDependenceRobustPower && passesReserveAdequacy,
    };
  });
  const selected = evaluated.find((row) => row.selectionEligible) ?? null;
  return {
    selectedPrimarySeeds: selected?.primarySeeds ?? null,
    selectedReserveSeedsByExperiment: selected ? Object.fromEntries(
      selected.reserves.map((entry) => [entry.experimentId, entry.reserveSeeds]),
    ) as Record<ConfirmatoryPilotExperimentId, number> : null,
    requiresPowerOrDesignAmendment: selected === null,
    resourceAuthorizationRequired: true,
    rows: evaluated,
    researchFinding: false,
    claimBoundary: 'Outcome-blind dependence-robust power and reserve selection only; not a resource authorization, confirmatory outcome, or scientific finding.',
  };
}
