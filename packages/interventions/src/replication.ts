/**
 * E50 multi-seed replication aggregation (EXPERIMENT-NOTEBOOK.md E50;
 * SPEC §15.3; BACKLOG ALD-072, ALD-077 acceptance criterion 2 — "`ALD-028`
 * derived-run support and `ALD-072`'s scaffold together launch the same
 * pre-registered configuration across independent seeds and aggregate
 * baseline statistics").
 *
 * E50's procedure fixes both what is aggregated and what must be said about
 * it: "Select independent seeds before viewing results", "Re-run all primary
 * comparisons", "Aggregate effect sizes and uncertainty", "Report failed and
 * partial replications". The last one is not optional here —
 * `negativeResultsIncluded` is a literal `true` in the result, and a finding
 * whose rule fails is reported with the same detail as one that passes. There
 * is no code path that drops a finding.
 *
 * A replication rule is pre-registered per finding and evaluated
 * mechanically:
 *
 * - `ci-excludes-null` — the replication's seed-level bootstrap interval
 *   excludes the null value *and* lies on the same side of it as the original
 *   effect. This is the strict rule: a significant effect in the opposite
 *   direction is a failed replication, not a successful one.
 * - `direction-and-alpha` — the replication's effect has the same sign as the
 *   original and its one-sided seed-level t test against the null is below
 *   `alpha`. Holm-Bonferroni across the findings of one experiment is
 *   reported alongside the raw p values (§15.3), so a family-adjusted reading
 *   is available without recomputation.
 *
 * `replicationStatus` distinguishes `replicated`, `partial` (the effect points
 * the same way but the rule did not fire), `failed` (opposite direction or a
 * rule violation), and `insufficient-seeds` (fewer seeds than the
 * pre-registered floor, where no status can honestly be assigned). None of
 * these is a scientific conclusion: they are the pre-registered rule applied
 * to the numbers (ALD-072 acceptance criterion 3).
 */
import {
  bootstrapMeanCi,
  cohensH,
  holmBonferroni,
  oneSampleTTest,
  summarize,
  type BootstrapCi,
  type OneSampleTTestResult,
} from '@ald/analysis';

import { buildAttachment, type AttachmentFile } from './attachment.js';
import { InterventionError, assertNonEmptyString } from './errors.js';

/** Analysis version of the E50 readout. */
export const REPLICATION_ANALYSIS_VERSION = 'replication-aggregate/v1';

/** §15.3: 10 seeds per condition for any publication-facing claim. */
export const PUBLICATION_MINIMUM_SEEDS = 10;

export type ReplicationRule =
  | { readonly type: 'ci-excludes-null' }
  | { readonly type: 'direction-and-alpha'; readonly alpha?: number };

/** One arm of a finding: the per-seed metric values, one per independent seed. */
export interface ReplicationArm {
  readonly label: string;
  /** One value per seed — a success proportion, an effect, a rate. */
  readonly perSeedValues: readonly number[];
  /** Optional per-seed episode counts, used only for the pooled Cohen's h. */
  readonly perSeedEpisodes?: readonly number[];
}

export interface ReplicationFindingInput {
  /** Stable id of the primary finding (E50's result table rows). */
  readonly findingId: string;
  /** What the metric is, e.g. `held-out success proportion`. */
  readonly metricLabel: string;
  readonly original: ReplicationArm;
  readonly replication: ReplicationArm;
  /** Value the effect is compared against, e.g. the E03 chance rate. */
  readonly nullValue: number;
  readonly rule: ReplicationRule;
  /** Seeds required before a status other than `insufficient-seeds`. */
  readonly minimumSeeds?: number;
  /**
   * Direction the pre-registration expected. `greater` and `less` require the
   * replication to move that way; `either` accepts the original's direction.
   */
  readonly expectedDirection?: 'greater' | 'less' | 'either';
}

export interface ReplicationInput {
  readonly findings: readonly ReplicationFindingInput[];
  /** Seed for every bootstrap in the aggregation. */
  readonly seed: string;
  readonly alpha?: number;
  readonly confidence?: number;
  readonly bootstrapIterations?: number;
}

export type ReplicationStatus =
  | 'replicated'
  | 'partial'
  | 'failed'
  | 'insufficient-seeds';

export interface ReplicationArmSummary {
  readonly label: string;
  readonly seeds: number;
  readonly mean: number;
  readonly sd: number;
  /** Mean minus `nullValue`: the effect the rule is evaluated on. */
  readonly effect: number;
  readonly bootstrap: BootstrapCi | null;
  readonly tTest: OneSampleTTestResult | null;
}

export interface ReplicationFindingResult {
  readonly findingId: string;
  readonly metricLabel: string;
  readonly nullValue: number;
  readonly rule: ReplicationRule;
  readonly minimumSeeds: number;
  readonly original: ReplicationArmSummary;
  readonly replication: ReplicationArmSummary;
  /** `replication.effect - original.effect`. */
  readonly effectDifference: number;
  /** §15.3 effect size when both arms are proportions in [0, 1]. */
  readonly cohensHOriginalVersusReplication: number;
  readonly sameDirection: boolean;
  readonly ruleMet: boolean;
  readonly replicationStatus: ReplicationStatus;
  /** Codes explaining the status; empty for a clean `replicated`. */
  readonly statusReasonCodes: readonly ReplicationStatusReasonCode[];
  /** Raw one-sided p of the replication arm, when the rule uses one. */
  readonly replicationP: number | null;
}

export type ReplicationStatusReasonCode =
  | 'below-seed-minimum-original'
  | 'below-seed-minimum-replication'
  | 'opposite-direction'
  | 'interval-includes-null'
  | 'p-at-or-above-alpha'
  | 'unexpected-direction'
  | 'degenerate-sample';

export interface ReplicationResult {
  readonly analysisVersion: string;
  readonly seed: string;
  readonly alpha: number;
  readonly confidence: number;
  readonly findings: readonly ReplicationFindingResult[];
  readonly summary: {
    readonly findings: number;
    readonly replicated: number;
    readonly partial: number;
    readonly failed: number;
    readonly insufficientSeeds: number;
  };
  /**
   * Holm-Bonferroni across the replication arms' one-sided p values, in
   * `findings` order (§15.3 "correction across the primary metrics of a
   * single experiment"). `null` when no finding produced a usable p.
   */
  readonly holmAcrossFindings: {
    readonly pValues: readonly number[];
    readonly adjusted: readonly number[];
    readonly rejected: readonly boolean[];
  } | null;
  /** E50 "Report failed and partial replications" — never conditional. */
  readonly negativeResultsIncluded: true;
  readonly claimBoundary: 'software-readiness-only';
}

function summarizeArm(
  arm: ReplicationArm,
  nullValue: number,
  seed: string,
  confidence: number,
  iterations: number,
): ReplicationArmSummary {
  if (arm.perSeedValues.length === 0) {
    throw new InterventionError(
      'insufficient-data',
      `arm ${arm.label} has no per-seed values`,
    );
  }
  const stats = summarize(arm.perSeedValues);
  const canInfer = arm.perSeedValues.length >= 2;
  return {
    label: arm.label,
    seeds: stats.n,
    mean: stats.mean,
    sd: stats.sd,
    effect: stats.mean - nullValue,
    bootstrap: canInfer
      ? bootstrapMeanCi(arm.perSeedValues, {
          seed: `${seed}/${arm.label}`,
          iterations,
          confidence,
        })
      : null,
    tTest: canInfer
      ? oneSampleTTest(
          arm.perSeedValues,
          nullValue,
          stats.mean >= nullValue ? 'greater' : 'less',
        )
      : null,
  };
}

function isProportion(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Aggregate the primary findings of a replication against their
 * pre-registered rules.
 *
 * Every finding is evaluated and returned, including the ones that fail: E50
 * requires failed and partial replications in the report, so dropping them
 * here would make the aggregate unusable for its own experiment record.
 */
export function aggregateAcrossSeeds(
  input: ReplicationInput,
): ReplicationResult {
  assertNonEmptyString(input.seed, 'seed');
  if (input.findings.length === 0) {
    throw new InterventionError('invalid-input', 'findings must not be empty');
  }
  const alpha = input.alpha ?? 0.05;
  const confidence = input.confidence ?? 0.95;
  const iterations = input.bootstrapIterations ?? 2_000;

  const findings = input.findings.map((finding) => {
    const minimumSeeds = finding.minimumSeeds ?? PUBLICATION_MINIMUM_SEEDS;
    const original = summarizeArm(
      finding.original,
      finding.nullValue,
      `${input.seed}/${finding.findingId}/original`,
      confidence,
      iterations,
    );
    const replication = summarizeArm(
      finding.replication,
      finding.nullValue,
      `${input.seed}/${finding.findingId}/replication`,
      confidence,
      iterations,
    );
    const reasons: ReplicationStatusReasonCode[] = [];
    if (original.seeds < minimumSeeds) {
      reasons.push('below-seed-minimum-original');
    }
    if (replication.seeds < minimumSeeds) {
      reasons.push('below-seed-minimum-replication');
    }

    const sameDirection =
      Math.sign(original.effect) === Math.sign(replication.effect) &&
      original.effect !== 0 &&
      replication.effect !== 0;
    if (!sameDirection) {
      reasons.push('opposite-direction');
    }
    const expected = finding.expectedDirection ?? 'either';
    const directionOk =
      expected === 'either'
        ? true
        : expected === 'greater'
          ? replication.effect > 0
          : replication.effect < 0;
    if (!directionOk) {
      reasons.push('unexpected-direction');
    }

    let ruleMet = false;
    let replicationP: number | null = null;
    if (finding.rule.type === 'ci-excludes-null') {
      const interval = replication.bootstrap;
      if (interval === null) {
        reasons.push('degenerate-sample');
      } else {
        const excludesNull =
          interval.lower > finding.nullValue || interval.upper < finding.nullValue;
        if (!excludesNull) {
          reasons.push('interval-includes-null');
        }
        ruleMet = excludesNull && sameDirection && directionOk;
      }
    } else {
      const ruleAlpha = finding.rule.alpha ?? alpha;
      const test = replication.tTest;
      if (test === null || Number.isNaN(test.p)) {
        reasons.push('degenerate-sample');
      } else {
        replicationP = test.p;
        if (!(test.p < ruleAlpha)) {
          reasons.push('p-at-or-above-alpha');
        }
        ruleMet = test.p < ruleAlpha && sameDirection && directionOk;
      }
    }

    let status: ReplicationStatus;
    if (
      reasons.includes('below-seed-minimum-original') ||
      reasons.includes('below-seed-minimum-replication')
    ) {
      status = 'insufficient-seeds';
    } else if (ruleMet) {
      status = 'replicated';
    } else if (sameDirection && directionOk) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    return {
      findingId: finding.findingId,
      metricLabel: finding.metricLabel,
      nullValue: finding.nullValue,
      rule: finding.rule,
      minimumSeeds,
      original,
      replication,
      effectDifference: replication.effect - original.effect,
      cohensHOriginalVersusReplication:
        isProportion(original.mean) && isProportion(replication.mean)
          ? cohensH(original.mean, replication.mean)
          : NaN,
      sameDirection,
      ruleMet,
      replicationStatus: status,
      statusReasonCodes: reasons,
      replicationP,
    } satisfies ReplicationFindingResult;
  });

  const usableP = findings
    .map((finding) => finding.replicationP)
    .filter((value): value is number => value !== null);
  const holm =
    usableP.length === 0
      ? null
      : (() => {
          const result = holmBonferroni(usableP, alpha);
          return {
            pValues: usableP,
            adjusted: result.adjusted,
            rejected: result.rejected,
          };
        })();

  return {
    analysisVersion: REPLICATION_ANALYSIS_VERSION,
    seed: input.seed,
    alpha,
    confidence,
    findings,
    summary: {
      findings: findings.length,
      replicated: findings.filter(
        (finding) => finding.replicationStatus === 'replicated',
      ).length,
      partial: findings.filter(
        (finding) => finding.replicationStatus === 'partial',
      ).length,
      failed: findings.filter((finding) => finding.replicationStatus === 'failed')
        .length,
      insufficientSeeds: findings.filter(
        (finding) => finding.replicationStatus === 'insufficient-seeds',
      ).length,
    },
    holmAcrossFindings: holm,
    negativeResultsIncluded: true,
    claimBoundary: 'software-readiness-only',
  };
}

/** Package the E50 aggregate as an `other`-kind bundle attachment. */
export function replicationAttachment(
  result: ReplicationResult,
): AttachmentFile {
  return buildAttachment({
    kind: 'other',
    analysisVersion: result.analysisVersion,
    value: result,
  });
}
