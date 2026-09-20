import { AnalysisError } from './errors.js';
import { wilsonInterval } from './descriptive.js';

export const CONFIRMATORY_PILOT_SUMMARY_VERSION = 'confirmatory-pilot-summary/v2';
export const CONFIRMATORY_PILOT_COMPONENTS = {
  H1: ['disabled', 'constant', 'random', 'shuffled'],
  H2: ['target-action-probability'],
  H3: ['held-out-success'],
  H4: ['brier-improvement'],
  H5: ['stable-acquisition', 'first-stable-turn-ratio'],
  H6a: ['restricted-mean-turns'],
  H6b: ['excess-cmi-bits'],
  H7: ['replacement-degradation'],
  H8: ['informativeness-bits', 'normalized-ambiguity'],
} as const;

export const CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS = {
  E11: ['H1'],
  E13: ['H5'],
  E15: ['H3'],
  E16: ['H2', 'H4'],
  E20: ['H6a', 'H6b'],
  E30: ['H7'],
  E32: ['H8'],
} as const;

export type ConfirmatoryMemberId = keyof typeof CONFIRMATORY_PILOT_COMPONENTS;
export type ConfirmatoryPilotExperimentId = keyof typeof CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS;
export type ConfirmatoryPilotStatus = 'not-collected' | 'incomplete' | 'complete';

export interface ConfirmatoryPilotExperimentSummary {
  readonly id: ConfirmatoryPilotExperimentId;
  readonly memberIds: readonly ConfirmatoryMemberId[];
  readonly status: ConfirmatoryPilotStatus;
  readonly plannedSlots: 20;
  readonly attemptedSlots: number;
  readonly completedSlots: number;
  readonly validSlots: number;
  readonly invalidSlots: number;
  readonly invalidProbabilityUpper95: number | null;
  readonly invalidProbabilityUpper95Method: 'wilson-score-one-sided-95' | null;
}

export interface ConfirmatoryPilotComponentSummary {
  readonly id: string;
  readonly n: number;
  readonly mean: number | null;
  readonly sampleSd: number | null;
  readonly upper95Sd: number | null;
  readonly upper95SdMethod: string | null;
}

export interface ConfirmatoryPilotMemberSummary {
  readonly id: ConfirmatoryMemberId;
  readonly components: readonly ConfirmatoryPilotComponentSummary[];
}

export interface ConfirmatoryPilotSummary {
  readonly schemaVersion: 2;
  readonly analysisVersion: typeof CONFIRMATORY_PILOT_SUMMARY_VERSION;
  readonly stage: 'blinded-pilot';
  readonly status: ConfirmatoryPilotStatus;
  readonly experiments: readonly ConfirmatoryPilotExperimentSummary[];
  readonly members: readonly ConfirmatoryPilotMemberSummary[];
  readonly researchFinding: false;
  readonly scientificDisposition: 'not-tested';
  readonly confirmatoryEstimateUse: false;
  readonly selectionEligible: boolean;
}

function count(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new AnalysisError('domain', `${label} must be a non-negative integer`);
}

/** A two-sided 90% Wilson upper endpoint is the one-sided 95% score bound. */
export function confirmatoryPilotInvalidProbabilityUpper95(
  invalidSlots: number,
  completedSlots: number,
): number {
  count(invalidSlots, 'invalidSlots');
  count(completedSlots, 'completedSlots');
  if (completedSlots === 0 || invalidSlots > completedSlots) {
    throw new AnalysisError('domain', 'invalid-run bound requires at least one completed slot and a valid tally');
  }
  return wilsonInterval(invalidSlots, completedSlots, 0.90).upper;
}

/** Validate eligibility without calculating or interpreting any pilot outcome. */
export function validateConfirmatoryPilotSummary(summary: ConfirmatoryPilotSummary): void {
  if (summary.schemaVersion !== 2 || summary.analysisVersion !== CONFIRMATORY_PILOT_SUMMARY_VERSION ||
      summary.stage !== 'blinded-pilot' ||
      summary.researchFinding !== false || summary.scientificDisposition !== 'not-tested' ||
      summary.confirmatoryEstimateUse !== false) {
    throw new AnalysisError('domain', 'pilot summary identity or claim boundary is invalid');
  }
  const expectedExperiments = Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS);
  if (summary.experiments.length !== expectedExperiments.length) {
    throw new AnalysisError('domain', 'all seven pilot experiments are required');
  }
  summary.experiments.forEach((experiment, experimentIndex) => {
    const [expectedId, expectedMembers] = expectedExperiments[experimentIndex]!;
    if (experiment.id !== expectedId || experiment.plannedSlots !== 20 ||
        experiment.memberIds.length !== expectedMembers.length ||
        experiment.memberIds.some((id, index) => id !== expectedMembers[index])) {
      throw new AnalysisError('domain', 'pilot experiments or member mappings are missing or reordered');
    }
    for (const field of ['attemptedSlots', 'completedSlots', 'validSlots', 'invalidSlots'] as const) {
      count(experiment[field], `${experiment.id}.${field}`);
    }
    if (experiment.completedSlots > experiment.attemptedSlots ||
        experiment.validSlots + experiment.invalidSlots !== experiment.completedSlots ||
        experiment.attemptedSlots > experiment.plannedSlots) {
      throw new AnalysisError('domain', 'pilot experiment slot accounting is inconsistent');
    }
    if (experiment.completedSlots === 0) {
      if (experiment.invalidProbabilityUpper95 !== null || experiment.invalidProbabilityUpper95Method !== null) {
        throw new AnalysisError('domain', 'unobserved pilot validity cannot carry an invalid-run bound');
      }
    } else {
      const expectedUpper = confirmatoryPilotInvalidProbabilityUpper95(
        experiment.invalidSlots, experiment.completedSlots,
      );
      if (experiment.invalidProbabilityUpper95Method !== 'wilson-score-one-sided-95' ||
          experiment.invalidProbabilityUpper95 === null ||
          !Number.isFinite(experiment.invalidProbabilityUpper95) ||
          Math.abs(experiment.invalidProbabilityUpper95 - expectedUpper) > 1e-12) {
        throw new AnalysisError('domain', 'pilot invalid-run upper bound is missing or optimistic');
      }
    }
    const complete = experiment.status === 'complete';
    if (complete ? experiment.attemptedSlots !== 20 || experiment.completedSlots !== 20 ||
        experiment.validSlots !== 20 || experiment.invalidSlots !== 0 : false) {
      throw new AnalysisError('domain', 'complete experiment pilot requires all twenty primary slots to be valid');
    }
    if (experiment.status === 'not-collected' && experiment.attemptedSlots !== 0) {
      throw new AnalysisError('domain', 'not-collected experiment pilot cannot contain attempts');
    }
  });
  const expectedMembers = Object.entries(CONFIRMATORY_PILOT_COMPONENTS);
  if (summary.members.length !== expectedMembers.length) throw new AnalysisError('domain', 'all nine pilot members are required');
  summary.members.forEach((member, memberIndex) => {
    const [expectedId, expectedComponents] = expectedMembers[memberIndex]!;
    if (member.id !== expectedId || member.components.length !== expectedComponents.length) {
      throw new AnalysisError('domain', 'pilot members or components are missing or reordered');
    }
    member.components.forEach((component, componentIndex) => {
      if (component.id !== expectedComponents[componentIndex]) throw new AnalysisError('domain', 'pilot components are missing or reordered');
      count(component.n, `${member.id}.${component.id}.n`);
      const experiment = summary.experiments.find((entry) => entry.memberIds.includes(member.id));
      if (!experiment || component.n > experiment.validSlots) {
        throw new AnalysisError('domain', 'component sample exceeds its experiment valid pilot slots');
      }
      const values = [component.mean, component.sampleSd, component.upper95Sd];
      if (component.n === 0) {
        if (values.some((value) => value !== null) || component.upper95SdMethod !== null) {
          throw new AnalysisError('domain', 'empty pilot components cannot carry statistics');
        }
      } else if (values.some((value) => value === null || !Number.isFinite(value)) ||
          component.sampleSd! < 0 || component.upper95Sd! < component.sampleSd! ||
          !component.upper95SdMethod) {
        throw new AnalysisError('domain', 'observed pilot components require finite conservative dispersion');
      }
    });
  });
  const allComplete = summary.experiments.every((experiment) => experiment.status === 'complete') &&
    summary.members.every((member) => member.components.every((component) => component.n === 20));
  const allNotCollected = summary.experiments.every((experiment) => experiment.status === 'not-collected') &&
    summary.members.every((member) => member.components.every((component) => component.n === 0));
  const expectedStatus: ConfirmatoryPilotStatus = allComplete ? 'complete' : allNotCollected ? 'not-collected' : 'incomplete';
  if (summary.status !== expectedStatus) {
    throw new AnalysisError('domain', 'aggregate pilot status contradicts experiment and component evidence');
  }
  if (summary.status === 'not-collected' &&
      summary.members.some((member) => member.components.some((component) => component.n !== 0))) {
    throw new AnalysisError('domain', 'not-collected pilot cannot contain attempts or statistics');
  }
  if (summary.selectionEligible !== allComplete) {
    throw new AnalysisError('domain', 'selection eligibility must exactly match complete pilot status');
  }
}
