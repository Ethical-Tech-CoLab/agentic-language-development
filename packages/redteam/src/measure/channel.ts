/**
 * Reusable side-channel measurement (ALD-040 criterion 2 and criterion 3;
 * SPECIFICATION.md §10.3).
 *
 * The measurement is always the same shape whatever the channel: label every
 * observation with the condition that produced it (`accepted`, `rejected`,
 * `timeout`, …), then ask whether the labels are distinguishable. So one
 * generic core, `measureLabeledChannel`, computes per-label summaries and
 * every pairwise comparison, and the timing and size entry points are thin
 * wrappers that name the metric.
 *
 * ALD-040 criterion 3 requires the ALD-067 harness to reuse this tooling
 * rather than duplicate it, which fixes two design constraints: the module
 * imports nothing from the Gateway, the runtime, or the isolation layer (a
 * harness that measures those must be able to import this), and the input is
 * plain labeled numbers, so an active exploit that gathers samples any way it
 * likes can hand them straight over.
 *
 * `withinTolerance` turns a measurement into a pass/fail decision against an
 * explicit tolerance — ALD-067 criterion 2 requires "an automated pass/fail
 * check, not manual judgment". The decision is engineering-grade: it states
 * that the measured samples are within the stated envelope, not that no
 * channel exists.
 */
import { RedTeamError, assertFiniteSample } from '../errors.js';
import {
  cohensD,
  ksDistance,
  ksTwoSampleP,
  mean,
  standardDeviation,
  variance,
  welchT,
} from './stats.js';

export type ChannelMetric = 'timing-ms' | 'size-bytes';

export interface LabeledDuration {
  label: string;
  durationMs: number;
}

export interface LabeledSize {
  label: string;
  sizeBytes: number;
}

export interface LabelSummary {
  label: string;
  count: number;
  mean: number;
  variance: number;
  standardDeviation: number;
  min: number;
  max: number;
}

export interface PairComparison {
  labelA: string;
  labelB: string;
  meanDifference: number;
  /** Absolute mean difference, the quantity a tolerance bounds directly. */
  absoluteMeanDifference: number;
  welchT: number;
  degreesOfFreedom: number;
  welchP: number;
  cohensD: number;
  ksDistance: number;
  ksP: number;
}

export interface ChannelMeasurement {
  metric: ChannelMetric;
  labels: LabelSummary[];
  pairs: PairComparison[];
  totalSamples: number;
}

function summarize(label: string, values: readonly number[]): LabelSummary {
  return {
    label,
    count: values.length,
    mean: mean(values),
    variance: variance(values),
    standardDeviation: standardDeviation(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Core measurement. Labels are compared in sorted order and every unordered
 * pair appears exactly once, so the result is deterministic and canonical
 * regardless of sample order.
 */
export function measureLabeledChannel(
  metric: ChannelMetric,
  samples: readonly { label: string; value: number }[],
): ChannelMeasurement {
  if (samples.length === 0) {
    throw new RedTeamError('empty-sample', 'a channel measurement needs samples');
  }
  const byLabel = new Map<string, number[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) {
      throw new RedTeamError('domain', `sample for ${sample.label} is not finite`);
    }
    const bucket = byLabel.get(sample.label);
    if (bucket === undefined) {
      byLabel.set(sample.label, [sample.value]);
    } else {
      bucket.push(sample.value);
    }
  }
  const labels = [...byLabel.keys()].sort();
  if (labels.length < 2) {
    throw new RedTeamError(
      'insufficient-labels',
      'distinguishability needs at least two labels',
    );
  }
  const summaries = labels.map((label) => {
    const values = byLabel.get(label) ?? [];
    assertFiniteSample(values, label);
    return summarize(label, values);
  });
  const pairs: PairComparison[] = [];
  for (let indexA = 0; indexA < labels.length; indexA += 1) {
    for (let indexB = indexA + 1; indexB < labels.length; indexB += 1) {
      const labelA = labels[indexA] ?? '';
      const labelB = labels[indexB] ?? '';
      const left = byLabel.get(labelA) ?? [];
      const right = byLabel.get(labelB) ?? [];
      const welch = welchT(left, right);
      const distance = ksDistance(left, right);
      const meanDifference = mean(left) - mean(right);
      pairs.push({
        labelA,
        labelB,
        meanDifference,
        absoluteMeanDifference: Math.abs(meanDifference),
        welchT: welch.t,
        degreesOfFreedom: welch.degreesOfFreedom,
        welchP: welch.pValue,
        cohensD: cohensD(left, right),
        ksDistance: distance,
        ksP: ksTwoSampleP(distance, left.length, right.length),
      });
    }
  }
  return { metric, labels: summaries, pairs, totalSamples: samples.length };
}

/**
 * Timing channel (§10.3 "fixed turn schedule and response deadline",
 * "normalized … error behavior"). Durations must be non-negative; a negative
 * duration is a measurement bug, not a fast response.
 */
export function measureTimingChannel(
  samples: readonly LabeledDuration[],
): ChannelMeasurement {
  for (const sample of samples) {
    if (sample.durationMs < 0) {
      throw new RedTeamError('domain', 'durationMs must be non-negative');
    }
  }
  return measureLabeledChannel(
    'timing-ms',
    samples.map((sample) => ({ label: sample.label, value: sample.durationMs })),
  );
}

/** Response-size channel (§10.3 "normalized message envelope size"). */
export function measureSizeChannel(samples: readonly LabeledSize[]): ChannelMeasurement {
  for (const sample of samples) {
    if (sample.sizeBytes < 0 || !Number.isInteger(sample.sizeBytes)) {
      throw new RedTeamError('domain', 'sizeBytes must be a non-negative integer');
    }
  }
  return measureLabeledChannel(
    'size-bytes',
    samples.map((sample) => ({ label: sample.label, value: sample.sizeBytes })),
  );
}

export interface ChannelTolerance {
  /** Largest absolute mean difference accepted, in the metric's own unit. */
  maxAbsoluteMeanDifference?: number;
  /** Largest |Cohen's d| accepted. The primary criterion: effect size. */
  maxAbsoluteCohensD?: number;
  /** Largest KS distance accepted, bounding a difference in distribution shape. */
  maxKsDistance?: number;
  /**
   * Smallest acceptable p-value. A *low* p means the labels are
   * distinguishable, so the tolerance requires p to be at or above this.
   * Optional and secondary: with enough samples any real difference becomes
   * significant, which is why effect size is the primary criterion.
   */
  minPValue?: number;
}

export interface ToleranceViolation {
  labelA: string;
  labelB: string;
  criterion: 'mean-difference' | 'cohens-d' | 'ks-distance' | 'p-value';
  observed: number;
  limit: number;
}

export interface ToleranceDecision {
  withinTolerance: boolean;
  metric: ChannelMetric;
  tolerance: ChannelTolerance;
  violations: ToleranceViolation[];
}

/**
 * Automated pass/fail against an explicit tolerance (ALD-067 criterion 2).
 * A tolerance with no criteria set is refused: an empty tolerance would pass
 * everything and read like a green result.
 */
export function withinTolerance(
  measurement: ChannelMeasurement,
  tolerance: ChannelTolerance,
): ToleranceDecision {
  const criteria = [
    tolerance.maxAbsoluteMeanDifference,
    tolerance.maxAbsoluteCohensD,
    tolerance.maxKsDistance,
    tolerance.minPValue,
  ].filter((value) => value !== undefined);
  if (criteria.length === 0) {
    throw new RedTeamError('domain', 'a tolerance must set at least one criterion');
  }
  const violations: ToleranceViolation[] = [];
  for (const pair of measurement.pairs) {
    if (
      tolerance.maxAbsoluteMeanDifference !== undefined &&
      pair.absoluteMeanDifference > tolerance.maxAbsoluteMeanDifference
    ) {
      violations.push({
        labelA: pair.labelA,
        labelB: pair.labelB,
        criterion: 'mean-difference',
        observed: pair.absoluteMeanDifference,
        limit: tolerance.maxAbsoluteMeanDifference,
      });
    }
    if (
      tolerance.maxAbsoluteCohensD !== undefined &&
      Math.abs(pair.cohensD) > tolerance.maxAbsoluteCohensD
    ) {
      violations.push({
        labelA: pair.labelA,
        labelB: pair.labelB,
        criterion: 'cohens-d',
        observed: Math.abs(pair.cohensD),
        limit: tolerance.maxAbsoluteCohensD,
      });
    }
    if (tolerance.maxKsDistance !== undefined && pair.ksDistance > tolerance.maxKsDistance) {
      violations.push({
        labelA: pair.labelA,
        labelB: pair.labelB,
        criterion: 'ks-distance',
        observed: pair.ksDistance,
        limit: tolerance.maxKsDistance,
      });
    }
    if (tolerance.minPValue !== undefined && pair.welchP < tolerance.minPValue) {
      violations.push({
        labelA: pair.labelA,
        labelB: pair.labelB,
        criterion: 'p-value',
        observed: pair.welchP,
        limit: tolerance.minPValue,
      });
    }
  }
  return {
    withinTolerance: violations.length === 0,
    metric: measurement.metric,
    tolerance,
    violations,
  };
}
