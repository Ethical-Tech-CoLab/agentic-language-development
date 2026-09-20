/** Deterministic prospective power simulation for the confirmatory family. */
import { SeededPrng } from '@ald/hashing';

import { AnalysisError } from './errors.js';
import { binomialTest } from './hypothesis.js';
import {
  CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS,
  CONFIRMATORY_MEMBER_IDS,
  CONFIRMATORY_MONTE_CARLO_REPETITIONS,
  type ConfirmatoryComponentSuccesses,
  type ConfirmatoryFamilySimulationRow,
} from './confirmatory-selection.js';
import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  validateConfirmatoryPilotSummary,
  type ConfirmatoryMemberId,
  type ConfirmatoryPilotSummary,
} from './confirmatory-pilot.js';
import { studentTQuantile } from './special.js';

export const CONFIRMATORY_POWER_SIMULATION_VERSION = 'confirmatory-power-simulation/v1';
export const CONFIRMATORY_COMPONENT_TEST_ALPHA = 0.05 / 9;
export const CONFIRMATORY_POWER_WORKING_MODEL =
  'normal-sufficient-statistics-with-exact-binomial-h5/v1' as const;
export const CONFIRMATORY_DIAGNOSTIC_DEPENDENCE_MODEL =
  'independent-component-streams-diagnostic-only' as const;

type Direction = 'greater' | 'less';

interface ContinuousComponentModel {
  readonly kind: 'continuous';
  readonly alternativeMean: number;
  readonly nullBoundary: number;
  readonly direction: Direction;
}

interface BinaryComponentModel {
  readonly kind: 'binary';
  readonly alternativeProbability: number;
  readonly nullProbability: number;
  readonly direction: 'greater';
}

type ComponentModel = ContinuousComponentModel | BinaryComponentModel;

const COMPONENT_MODELS: Readonly<Record<ConfirmatoryMemberId, Readonly<Record<string, ComponentModel>>>> = {
  H1: {
    disabled: { kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater' },
    constant: { kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater' },
    random: { kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater' },
    shuffled: { kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater' },
  },
  H2: {
    'target-action-probability': {
      kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater',
    },
  },
  H3: {
    'held-out-success': {
      kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater',
    },
  },
  H4: {
    'brier-improvement': {
      kind: 'continuous', alternativeMean: 0.04, nullBoundary: 0.02, direction: 'greater',
    },
  },
  H5: {
    'stable-acquisition': {
      kind: 'binary', alternativeProbability: 0.75, nullProbability: 0.50, direction: 'greater',
    },
    'first-stable-turn-ratio': {
      kind: 'binary', alternativeProbability: 0.75, nullProbability: 0.50, direction: 'greater',
    },
  },
  H6a: {
    'restricted-mean-turns': {
      kind: 'continuous', alternativeMean: -0.20, nullBoundary: -0.10, direction: 'less',
    },
  },
  H6b: {
    'excess-cmi-bits': {
      kind: 'continuous', alternativeMean: 0, nullBoundary: 0.02, direction: 'less',
    },
  },
  H7: {
    'replacement-degradation': {
      kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater',
    },
  },
  H8: {
    'informativeness-bits': {
      kind: 'continuous', alternativeMean: 0.10, nullBoundary: 0.05, direction: 'greater',
    },
    'normalized-ambiguity': {
      kind: 'continuous', alternativeMean: 0.20, nullBoundary: 0.10, direction: 'greater',
    },
  },
};

export interface ConfirmatoryPowerSimulation {
  readonly schemaVersion: 1;
  readonly analysisVersion: typeof CONFIRMATORY_POWER_SIMULATION_VERSION;
  readonly pilotAnalysisVersion: typeof CONFIRMATORY_PILOT_SUMMARY_VERSION;
  readonly seed: string;
  readonly workingModel: typeof CONFIRMATORY_POWER_WORKING_MODEL;
  readonly rows: readonly ConfirmatoryFamilySimulationRow[];
  readonly researchFinding: false;
  readonly scientificDisposition: 'not-tested';
  readonly claimBoundary: string;
}

class NormalSampler {
  private spare: number | null = null;

  constructor(private readonly prng: SeededPrng) {}

  next(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    let radiusSquared = 0;
    let x = 0;
    let y = 0;
    do {
      x = 2 * this.prng.nextFloat() - 1;
      y = 2 * this.prng.nextFloat() - 1;
      radiusSquared = x * x + y * y;
    } while (radiusSquared === 0 || radiusSquared >= 1);
    const scale = Math.sqrt(-2 * Math.log(radiusSquared) / radiusSquared);
    this.spare = y * scale;
    return x * scale;
  }
}

/** Marsaglia-Tsang gamma draw. Confirmatory df/2 is always at least 12. */
function gamma(shape: number, prng: SeededPrng, normal: NormalSampler): number {
  if (!(shape >= 1)) throw new AnalysisError('domain', 'gamma shape must be at least one');
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = normal.next();
    const factor = 1 + c * z;
    if (factor <= 0) continue;
    const cubed = factor * factor * factor;
    const uniform = prng.nextFloat();
    if (uniform < 1 - 0.0331 * z ** 4 ||
        Math.log(uniform) < 0.5 * z * z + d * (1 - cubed + Math.log(cubed))) {
      return d * cubed;
    }
  }
}

function simulateContinuous(
  model: ContinuousComponentModel,
  upper95Sd: number,
  primarySeeds: number,
  prng: SeededPrng,
  jointPasses: Uint8Array,
): number {
  if (!Number.isFinite(upper95Sd) || upper95Sd < 0) {
    throw new AnalysisError('domain', 'continuous power simulation requires a finite non-negative upper SD');
  }
  const deterministicPass = model.direction === 'greater'
    ? model.alternativeMean > model.nullBoundary
    : model.alternativeMean < model.nullBoundary;
  if (upper95Sd === 0) {
    if (!deterministicPass) jointPasses.fill(0);
    return deterministicPass ? CONFIRMATORY_MONTE_CARLO_REPETITIONS : 0;
  }
  const df = primarySeeds - 1;
  const critical = studentTQuantile(1 - CONFIRMATORY_COMPONENT_TEST_ALPHA, df);
  const rootN = Math.sqrt(primarySeeds);
  const normal = new NormalSampler(prng);
  let successes = 0;
  for (let repetition = 0; repetition < CONFIRMATORY_MONTE_CARLO_REPETITIONS; repetition += 1) {
    const sampleMean = model.alternativeMean + upper95Sd * normal.next() / rootN;
    const chiSquared = 2 * gamma(df / 2, prng, normal);
    const sampleSd = upper95Sd * Math.sqrt(chiSquared / df);
    const statistic = (sampleMean - model.nullBoundary) / (sampleSd / rootN);
    const passed = model.direction === 'greater' ? statistic > critical : statistic < -critical;
    if (passed) successes += 1;
    else jointPasses[repetition] = 0;
  }
  return successes;
}

function simulateBinary(
  model: BinaryComponentModel,
  primarySeeds: number,
  prng: SeededPrng,
  jointPasses: Uint8Array,
): number {
  let criticalSuccesses: number | null = null;
  for (let successes = 0; successes <= primarySeeds; successes += 1) {
    if (binomialTest(successes, primarySeeds, model.nullProbability, model.direction).exactP <
        CONFIRMATORY_COMPONENT_TEST_ALPHA) {
      criticalSuccesses = successes;
      break;
    }
  }
  const decisionProbability = criticalSuccesses === null ? 0 :
    binomialTest(criticalSuccesses, primarySeeds, model.alternativeProbability, model.direction).exactP;
  let successes = 0;
  for (let repetition = 0; repetition < CONFIRMATORY_MONTE_CARLO_REPETITIONS; repetition += 1) {
    const passed = prng.nextFloat() < decisionProbability;
    if (passed) successes += 1;
    else jointPasses[repetition] = 0;
  }
  return successes;
}

/**
 * Simulate all frozen candidates from an eligible blinded-pilot summary.
 * The Normal model is a declared parametric working model, not an observed
 * distributional finding. Joint outcomes use independent component streams
 * and are diagnostic only; selection remains dependence-robust.
 */
export function simulateConfirmatoryComponentPower(
  pilot: ConfirmatoryPilotSummary,
  seed: string,
): ConfirmatoryPowerSimulation {
  validateConfirmatoryPilotSummary(pilot);
  if (!pilot.selectionEligible || pilot.analysisVersion !== CONFIRMATORY_PILOT_SUMMARY_VERSION) {
    throw new AnalysisError('domain', 'a complete selection-eligible confirmatory pilot is required');
  }
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new AnalysisError('domain', 'confirmatory power simulation seed must be non-empty');
  }
  const root = new SeededPrng(seed);
  const rows = CONFIRMATORY_CANDIDATE_PRIMARY_SEEDS.map((primarySeeds) => {
    const jointPasses = new Uint8Array(CONFIRMATORY_MONTE_CARLO_REPETITIONS);
    jointPasses.fill(1);
    const componentDecisionSuccesses = Object.fromEntries(CONFIRMATORY_MEMBER_IDS.map((memberId) => {
      const pilotMember = pilot.members.find((entry) => entry.id === memberId)!;
      const components = CONFIRMATORY_PILOT_COMPONENTS[memberId].map((componentId) => {
        const model = COMPONENT_MODELS[memberId][componentId]!;
        const pilotComponent = pilotMember.components.find((entry) => entry.id === componentId)!;
        const prng = root.derive(`${primarySeeds}/${memberId}/${componentId}`);
        const successes = model.kind === 'binary'
          ? simulateBinary(model, primarySeeds, prng, jointPasses)
          : simulateContinuous(model, pilotComponent.upper95Sd!, primarySeeds, prng, jointPasses);
        return [componentId, successes];
      });
      return [memberId, Object.fromEntries(components)];
    })) as ConfirmatoryComponentSuccesses;
    let diagnosticJointDecisionSuccesses = 0;
    for (const passed of jointPasses) diagnosticJointDecisionSuccesses += passed;
    return {
      primarySeeds,
      repetitions: CONFIRMATORY_MONTE_CARLO_REPETITIONS,
      componentDecisionSuccesses,
      diagnosticDependenceModel: CONFIRMATORY_DIAGNOSTIC_DEPENDENCE_MODEL,
      diagnosticJointDecisionSuccesses,
    } satisfies ConfirmatoryFamilySimulationRow;
  });
  return {
    schemaVersion: 1,
    analysisVersion: CONFIRMATORY_POWER_SIMULATION_VERSION,
    pilotAnalysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    seed,
    workingModel: CONFIRMATORY_POWER_WORKING_MODEL,
    rows,
    researchFinding: false,
    scientificDisposition: 'not-tested',
    claimBoundary: 'Prospective parametric power simulation only; not a pilot result, selected sample size, resource authorization, study outcome, or scientific finding.',
  };
}
