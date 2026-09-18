import { E03_COMMUNICATION_CONDITIONS } from './e03-design.js';
import {
  E03_ORACLE_LOWER_BOUND,
  E03_SEPARATION_LOWER_BOUND,
  e03Analysis,
  type E03Analysis,
} from './e03.js';
import {
  reconcileE03FullPairedRuns,
  type E03FullAttemptedRun,
  type E03FullPairedReconciliation,
} from './e03-full.js';
import type { E03RegisteredRun } from './e03-registration.js';

export const E03_FULL_QUALIFICATION_ANALYSIS_VERSION = 1;
export const E03_FULL_EPISODES_PER_SEED = 200;
export const E03_FULL_PRIMARY_PAIRS = 25;
export const E03_FULL_ALPHA = 0.05;
export const E03_FULL_CHANCE_LOWER = 0.2;
export const E03_FULL_CHANCE_UPPER = 0.3;

export interface E03FullQualificationInput {
  readonly registered: readonly E03RegisteredRun[];
  readonly attempted: readonly E03FullAttemptedRun[];
  readonly analysisSeed: string;
  readonly bootstrapIterations?: number;
}

export interface E03FullQualificationAnalysis {
  readonly version: typeof E03_FULL_QUALIFICATION_ANALYSIS_VERSION;
  readonly reconciliation: E03FullPairedReconciliation;
  /** Null only when the registered primary/reserve matrix cannot form 25 pairs. */
  readonly numericAnalysis: E03Analysis | null;
  /** Numeric result only; evidence/leakage review remains a separate harness duty. */
  readonly numericDisposition: 'incomplete' | 'thresholds-met' | 'thresholds-not-met';
  readonly scientificDisposition: 'not-tested';
  readonly leakageReviewRunIds: readonly string[];
}

/**
 * Reduce verified full-stage attempts to the registered seed-level E03 statistic.
 * The caller must supply only original-bundle-derived attempts; this function
 * deliberately does not label any result as a scientific finding.
 */
export function analyzeE03FullQualification(
  input: E03FullQualificationInput,
): E03FullQualificationAnalysis {
  const reconciliation = reconcileE03FullPairedRuns(input.registered, input.attempted);
  if (reconciliation.status !== 'complete') {
    return {
      version: E03_FULL_QUALIFICATION_ANALYSIS_VERSION,
      reconciliation, numericAnalysis: null, numericDisposition: 'incomplete',
      scientificDisposition: 'not-tested', leakageReviewRunIds: [],
    };
  }
  if (reconciliation.includedPairs.length !== E03_FULL_PRIMARY_PAIRS) {
    throw new Error('complete E03 full reconciliation must contain exactly 25 paired scenarios');
  }
  const oracle = reconciliation.includedPairs.map((pair) => pair.rates.oracle);
  const conditions = Object.fromEntries(E03_COMMUNICATION_CONDITIONS
    .filter((condition) => condition !== 'oracle')
    .map((condition) => [condition,
      reconciliation.includedPairs.map((pair) => pair.rates[condition])])) as Record<string, number[]>;
  const numericAnalysis = e03Analysis({
    alpha: E03_FULL_ALPHA,
    equivalenceLower: E03_FULL_CHANCE_LOWER,
    equivalenceUpper: E03_FULL_CHANCE_UPPER,
    oracleLowerBound: E03_ORACLE_LOWER_BOUND,
    separationLowerBound: E03_SEPARATION_LOWER_BOUND,
    seed: input.analysisSeed,
    conditions,
    oracle,
    episodeCounts: Object.fromEntries([...E03_COMMUNICATION_CONDITIONS]
      .map((condition) => [condition, E03_FULL_EPISODES_PER_SEED])),
    ...(input.bootstrapIterations === undefined ? {} : { bootstrapIterations: input.bootstrapIterations }),
  });
  const leakageReviewRunIds = numericAnalysis.conditions.flatMap((condition) =>
    condition.highSeeds.auditRequired
      ? condition.highSeeds.seedIndices.flatMap((index) => {
        const pair = reconciliation.includedPairs[index]!;
        return [pair.runIds[condition.condition as keyof typeof pair.runIds]];
      }) : []);
  return {
    version: E03_FULL_QUALIFICATION_ANALYSIS_VERSION,
    reconciliation,
    numericAnalysis,
    numericDisposition: numericAnalysis.qualifies ? 'thresholds-met' : 'thresholds-not-met',
    scientificDisposition: 'not-tested', leakageReviewRunIds,
  };
}
