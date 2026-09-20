/** Numerical reduction of complete, not-yet-admitted confirmatory pilot records. */
import { hashCanonical } from '@ald/hashing';

import { summarize } from './descriptive.js';
import { AnalysisError } from './errors.js';
import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  confirmatoryPilotInvalidProbabilityUpper95,
  validateConfirmatoryPilotSummary,
  type ConfirmatoryPilotExperimentId,
  type ConfirmatoryPilotSummary,
} from './confirmatory-pilot.js';

export const CONFIRMATORY_PILOT_REDUCTION_VERSION = 'confirmatory-pilot-reduction/v1';
export const CONFIRMATORY_PILOT_UPPER_SD_METHOD = 'normal-chi-square-one-sided-95-n20-v1';
/** sqrt(19 / qchisq(0.05, 19)) from independent R 4.6.1. */
export const CONFIRMATORY_PILOT_UPPER_SD_FACTOR = 1.3704103976822324;

export interface ConfirmatoryPilotSlotObservation {
  readonly slot: number;
  readonly runId: string;
  readonly seed: string;
  readonly evidenceSha256: string;
  readonly components: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ConfirmatoryPilotExperimentInput {
  readonly id: ConfirmatoryPilotExperimentId;
  readonly registrationSha256: string;
  readonly slots: readonly ConfirmatoryPilotSlotObservation[];
}

export interface ConfirmatoryPilotReduction {
  readonly schemaVersion: 1;
  readonly analysisVersion: typeof CONFIRMATORY_PILOT_REDUCTION_VERSION;
  readonly sourceInputSha256: string;
  readonly summary: ConfirmatoryPilotSummary;
  readonly originalEvidenceVerified: false;
  readonly registrationAncestryVerified: false;
  readonly selectionAdmitted: false;
  readonly researchFinding: false;
  readonly scientificDisposition: 'not-tested';
  readonly claimBoundary: string;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9._-]*$/u;

function requireExactKeys(actual: object, expected: readonly string[], label: string): void {
  if (Object.keys(actual).join(',') !== expected.join(',')) {
    throw new AnalysisError('domain', `${label} must contain the exact ordered registered keys`);
  }
}

/**
 * Reduce exactly 20 valid primary slots per experiment. This pure calculation
 * cannot verify original bundles, registration ancestry, or whether a value
 * came from the registered metric. Those are separate admission requirements.
 * Pilot means are retained by the existing v2 summary contract but must not be
 * used to tune margins, alternatives, models, outcomes, or stopping rules.
 */
export function reduceConfirmatoryPilot(
  inputs: readonly ConfirmatoryPilotExperimentInput[],
): ConfirmatoryPilotReduction {
  const expectedExperiments = Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS);
  if (inputs.length !== expectedExperiments.length) {
    throw new AnalysisError('domain', 'all seven confirmatory pilot experiments are required');
  }
  const runIds = new Set<string>();
  const seeds = new Set<string>();
  const evidenceHashes = new Set<string>();
  const registrations = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const [expectedId, memberIds] = expectedExperiments[index]!;
    if (input.id !== expectedId || !SHA256.test(input.registrationSha256) ||
        registrations.has(input.registrationSha256) || input.slots.length !== 20) {
      throw new AnalysisError('domain', 'pilot experiments require distinct registrations and all twenty valid primary slots');
    }
    registrations.add(input.registrationSha256);
    for (const [slotIndex, observation] of input.slots.entries()) {
      if (observation.slot !== slotIndex + 1 || !RUN_ID.test(observation.runId) ||
          observation.seed.length === 0 || !SHA256.test(observation.evidenceSha256) ||
          runIds.has(observation.runId) || seeds.has(observation.seed) ||
          evidenceHashes.has(observation.evidenceSha256)) {
        throw new AnalysisError('domain', `${input.id} has missing, reordered, or reused slot identities`);
      }
      runIds.add(observation.runId);
      seeds.add(observation.seed);
      evidenceHashes.add(observation.evidenceSha256);
      requireExactKeys(observation.components, memberIds, `${input.id}.${observation.slot}.members`);
      for (const memberId of memberIds) {
        const values = observation.components[memberId]!;
        requireExactKeys(values, CONFIRMATORY_PILOT_COMPONENTS[memberId],
          `${input.id}.${observation.slot}.${memberId}`);
        for (const [componentId, value] of Object.entries(values)) {
          if (!Number.isFinite(value) ||
              (memberId === 'H5' && value !== 0 && value !== 1)) {
            throw new AnalysisError('domain', `${input.id}.${observation.slot}.${memberId}.${componentId} is invalid`);
          }
        }
      }
    }
  }

  const members = Object.entries(CONFIRMATORY_PILOT_COMPONENTS).map(([id, components]) => {
    const input = inputs.find((entry) =>
      (CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS[entry.id] as readonly string[]).includes(id))!;
    return {
      id: id as keyof typeof CONFIRMATORY_PILOT_COMPONENTS,
      components: components.map((componentId) => {
        const values = input.slots.map((slot) => slot.components[id]![componentId]!);
        const stats = summarize(values);
        return {
          id: componentId,
          n: stats.n,
          mean: stats.mean,
          sampleSd: stats.sd,
          upper95Sd: stats.sd * CONFIRMATORY_PILOT_UPPER_SD_FACTOR,
          upper95SdMethod: CONFIRMATORY_PILOT_UPPER_SD_METHOD,
        };
      }),
    };
  });
  const summary: ConfirmatoryPilotSummary = {
    schemaVersion: 2,
    analysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    stage: 'blinded-pilot',
    status: 'complete',
    experiments: inputs.map((input) => ({
      id: input.id,
      memberIds: CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS[input.id],
      status: 'complete',
      plannedSlots: 20,
      attemptedSlots: 20,
      completedSlots: 20,
      validSlots: 20,
      invalidSlots: 0,
      invalidProbabilityUpper95: confirmatoryPilotInvalidProbabilityUpper95(0, 20),
      invalidProbabilityUpper95Method: 'wilson-score-one-sided-95',
    })),
    members,
    researchFinding: false,
    scientificDisposition: 'not-tested',
    confirmatoryEstimateUse: false,
    selectionEligible: true,
  };
  validateConfirmatoryPilotSummary(summary);
  return {
    schemaVersion: 1,
    analysisVersion: CONFIRMATORY_PILOT_REDUCTION_VERSION,
    sourceInputSha256: hashCanonical('ald-confirmatory-pilot-reduction-input-v1', inputs),
    summary,
    originalEvidenceVerified: false,
    registrationAncestryVerified: false,
    selectionAdmitted: false,
    researchFinding: false,
    scientificDisposition: 'not-tested',
    claimBoundary: 'Numerical reduction only: source bundles and registration ancestry are unverified. Pilot means are prohibited design inputs. Not an admitted pilot, campaign power result, selected N, resource authorization, or scientific finding.',
  };
}
