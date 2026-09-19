import { AnalysisError } from './errors.js';

export const CONFIRMATORY_PILOT_SUMMARY_VERSION = 'confirmatory-pilot-summary/v1';
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

export type ConfirmatoryMemberId = keyof typeof CONFIRMATORY_PILOT_COMPONENTS;

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
  readonly schemaVersion: 1;
  readonly analysisVersion: typeof CONFIRMATORY_PILOT_SUMMARY_VERSION;
  readonly stage: 'blinded-pilot';
  readonly status: 'not-collected' | 'incomplete' | 'complete';
  readonly plannedSlots: 20;
  readonly attemptedSlots: number;
  readonly completedSlots: number;
  readonly validSlots: number;
  readonly invalidSlots: number;
  readonly members: readonly ConfirmatoryPilotMemberSummary[];
  readonly researchFinding: false;
  readonly scientificDisposition: 'not-tested';
  readonly confirmatoryEstimateUse: false;
  readonly selectionEligible: boolean;
}

function count(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new AnalysisError('domain', `${label} must be a non-negative integer`);
}

/** Validate eligibility without calculating or interpreting any pilot outcome. */
export function validateConfirmatoryPilotSummary(summary: ConfirmatoryPilotSummary): void {
  if (summary.schemaVersion !== 1 || summary.analysisVersion !== CONFIRMATORY_PILOT_SUMMARY_VERSION ||
      summary.stage !== 'blinded-pilot' || summary.plannedSlots !== 20 ||
      summary.researchFinding !== false || summary.scientificDisposition !== 'not-tested' ||
      summary.confirmatoryEstimateUse !== false) {
    throw new AnalysisError('domain', 'pilot summary identity or claim boundary is invalid');
  }
  for (const field of ['attemptedSlots', 'completedSlots', 'validSlots', 'invalidSlots'] as const) {
    count(summary[field], field);
  }
  if (summary.completedSlots > summary.attemptedSlots || summary.validSlots + summary.invalidSlots !== summary.completedSlots ||
      summary.attemptedSlots > summary.plannedSlots) {
    throw new AnalysisError('domain', 'pilot slot accounting is inconsistent');
  }
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
      if (component.n > summary.validSlots) throw new AnalysisError('domain', 'component sample exceeds valid pilot slots');
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
  const complete = summary.status === 'complete';
  if (complete ? summary.attemptedSlots !== 20 || summary.completedSlots !== 20 ||
      summary.validSlots !== 20 || summary.invalidSlots !== 0 ||
      summary.members.some((member) => member.components.some((component) => component.n !== 20)) : false) {
    throw new AnalysisError('domain', 'complete pilot requires all twenty valid slots and component summaries');
  }
  if (summary.status === 'not-collected' && (summary.attemptedSlots !== 0 ||
      summary.members.some((member) => member.components.some((component) => component.n !== 0)))) {
    throw new AnalysisError('domain', 'not-collected pilot cannot contain attempts or statistics');
  }
  if (summary.selectionEligible !== complete) {
    throw new AnalysisError('domain', 'selection eligibility must exactly match complete pilot status');
  }
}
