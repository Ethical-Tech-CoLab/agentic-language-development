/**
 * Outcome-blind E03 pilot reduction.
 *
 * This module consumes only the five non-oracle conditions' per-seed episode
 * tallies. It estimates the latent beta-binomial seed-rate dispersion and
 * selects the pre-frozen Appendix D row. It deliberately does not evaluate
 * chance equivalence, oracle adequacy, separation, or any scientific claim.
 */
import { fitBetaBinomial, type BetaBinomialFit, type SeedAgreementCount } from './hierarchical.js';
import {
  E03_NON_ORACLE_CONDITIONS,
  selectE03PrimarySeeds,
  type E03CommunicationCondition,
} from './e03-design.js';
import { AnalysisError } from './errors.js';

export const E03_PILOT_ANALYSIS_VERSION = 1;
export const E03_PILOT_SLOTS = 20;
export const E03_PILOT_EPISODES = 200;

export interface E03PilotSlotTally extends SeedAgreementCount {
  readonly slot: number;
}

export interface E03PilotConditionInput {
  readonly condition: Exclude<E03CommunicationCondition, 'oracle'>;
  readonly tallies: readonly E03PilotSlotTally[];
}

export interface E03PilotConditionFit extends BetaBinomialFit {
  readonly condition: Exclude<E03CommunicationCondition, 'oracle'>;
  readonly latentBetweenSeedSd: number;
}

export interface E03PilotSampleSizeInput {
  readonly version: typeof E03_PILOT_ANALYSIS_VERSION;
  readonly classification: 'outcome-blind-pilot-sample-size-input';
  readonly researchFinding: false;
  readonly scientificDisposition: 'not-tested';
  readonly pilotSlots: typeof E03_PILOT_SLOTS;
  readonly episodesPerSlot: typeof E03_PILOT_EPISODES;
  readonly conditions: E03PilotConditionFit[];
  readonly largestLatentPilotSd: number;
  readonly selectedPrimarySeeds: number | null;
  readonly requiresProspectiveAmendment: boolean;
  readonly decisionRule: 'e03-appendix-d-four-row-selection-v1';
  readonly claimBoundary: string;
}

const CLAIM_BOUNDARY =
  'Outcome-blind pilot dispersion reduction only: this output selects an E03 ' +
  'design row and does not test chance equivalence, oracle adequacy, separation, ' +
  'language emergence, or any behavioral hypothesis.';

function validateCondition(input: E03PilotConditionInput): void {
  if (!E03_NON_ORACLE_CONDITIONS.includes(input.condition)) {
    throw new AnalysisError('domain', `unsupported E03 pilot condition: ${input.condition}`);
  }
  if (input.tallies.length !== E03_PILOT_SLOTS) {
    throw new AnalysisError(
      'domain',
      `E03 pilot condition ${input.condition} requires exactly ${String(E03_PILOT_SLOTS)} slots`,
    );
  }
  const slots = new Set<number>();
  const seeds = new Set<string>();
  for (const tally of input.tallies) {
    if (
      !Number.isInteger(tally.slot) ||
      tally.slot < 1 ||
      tally.slot > E03_PILOT_SLOTS ||
      typeof tally.seed !== 'string' ||
      tally.seed.length === 0 ||
      !Number.isInteger(tally.probes) ||
      tally.probes !== E03_PILOT_EPISODES ||
      !Number.isInteger(tally.agreements) ||
      tally.agreements < 0 ||
      tally.agreements > tally.probes
    ) {
      throw new AnalysisError('domain', `invalid E03 pilot tally for ${input.condition}`);
    }
    slots.add(tally.slot);
    seeds.add(tally.seed);
  }
  if (slots.size !== E03_PILOT_SLOTS || seeds.size !== E03_PILOT_SLOTS) {
    throw new AnalysisError(
      'domain',
      `E03 pilot condition ${input.condition} has duplicate slots or seeds`,
    );
  }
}

export function reduceE03Pilot(
  inputs: readonly E03PilotConditionInput[],
): E03PilotSampleSizeInput {
  if (inputs.length !== E03_NON_ORACLE_CONDITIONS.length) {
    throw new AnalysisError('domain', 'E03 pilot requires all five non-oracle conditions');
  }
  const names = new Set(inputs.map((input) => input.condition));
  if (
    names.size !== E03_NON_ORACLE_CONDITIONS.length ||
    !E03_NON_ORACLE_CONDITIONS.every((condition) => names.has(condition))
  ) {
    throw new AnalysisError('domain', 'E03 pilot conditions must be complete and unique');
  }

  const conditions = inputs.map((input): E03PilotConditionFit => {
    validateCondition(input);
    const fit = fitBetaBinomial(input.tallies);
    const latentBetweenSeedSd = Math.sqrt(
      (fit.mu * (1 - fit.mu)) / (fit.precision + 1),
    );
    return { condition: input.condition, latentBetweenSeedSd, ...fit };
  });
  const largestLatentPilotSd = Math.max(
    ...conditions.map((condition) => condition.latentBetweenSeedSd),
  );
  const selectedPrimarySeeds = selectE03PrimarySeeds(largestLatentPilotSd);

  return {
    version: E03_PILOT_ANALYSIS_VERSION,
    classification: 'outcome-blind-pilot-sample-size-input',
    researchFinding: false,
    scientificDisposition: 'not-tested',
    pilotSlots: E03_PILOT_SLOTS,
    episodesPerSlot: E03_PILOT_EPISODES,
    conditions,
    largestLatentPilotSd,
    selectedPrimarySeeds: selectedPrimarySeeds ?? null,
    requiresProspectiveAmendment: selectedPrimarySeeds === undefined,
    decisionRule: 'e03-appendix-d-four-row-selection-v1',
    claimBoundary: CLAIM_BOUNDARY,
  };
}
