/** Active timing/size/error-channel measurement for SPEC §10.3 (ALD-067). */
import type { RunConfig } from '@ald/types';

import {
  measureSizeChannel,
  measureTimingChannel,
  withinTolerance,
  type ChannelMeasurement,
  type ChannelTolerance,
  type ToleranceDecision,
} from '../measure/channel.js';
import {
  errorShapeWithinTolerance,
  measureErrorShape,
  type ErrorShapeDecision,
  type ErrorShapeMeasurement,
  type ErrorShapeTolerance,
} from '../measure/error-shape.js';

export interface TransportAttackObservation {
  /** Bytes visible to the peer, after transport framing. */
  sizeBytes: number;
  /** Response bytes visible to the peer. Discarded after hashing. */
  responseBody: string | Uint8Array;
}

export interface TransportAttackCondition {
  label: string;
  execute(): Promise<TransportAttackObservation>;
}

export interface ActiveTransportAttackOptions {
  deploymentMode: RunConfig['deploymentMode'];
  conditions: readonly TransportAttackCondition[];
  samplesPerCondition: number;
  timingTolerance: ChannelTolerance;
  sizeTolerance: ChannelTolerance;
  errorTolerance?: ErrorShapeTolerance;
}

export interface ActiveTransportAttackReport {
  version: 1;
  deploymentMode: RunConfig['deploymentMode'];
  samplesPerCondition: number;
  timing: ChannelMeasurement;
  timingDecision: ToleranceDecision;
  size: ChannelMeasurement;
  sizeDecision: ToleranceDecision;
  errorShape: ErrorShapeMeasurement;
  errorDecision: ErrorShapeDecision;
  passed: boolean;
}

/** Execute every condition repeatedly and decide all three channels. */
export async function runActiveTransportAttacks(
  options: ActiveTransportAttackOptions,
): Promise<ActiveTransportAttackReport> {
  if (options.conditions.length < 2) {
    throw new Error('transport attacks require at least two labeled conditions');
  }
  if (!Number.isInteger(options.samplesPerCondition) || options.samplesPerCondition < 2) {
    throw new Error('samplesPerCondition must be an integer of at least 2');
  }
  const labels = new Set(options.conditions.map((condition) => condition.label));
  if (labels.size !== options.conditions.length) {
    throw new Error('transport attack condition labels must be unique');
  }

  const durations: Array<{ label: string; durationMs: number }> = [];
  const sizes: Array<{ label: string; sizeBytes: number }> = [];
  const responses: Array<{ label: string; body: string | Uint8Array }> = [];
  for (let sample = 0; sample < options.samplesPerCondition; sample += 1) {
    for (const condition of options.conditions) {
      const startedAt = performance.now();
      const observation = await condition.execute();
      durations.push({
        label: condition.label,
        durationMs: performance.now() - startedAt,
      });
      sizes.push({ label: condition.label, sizeBytes: observation.sizeBytes });
      responses.push({ label: condition.label, body: observation.responseBody });
    }
  }

  const timing = measureTimingChannel(durations);
  const size = measureSizeChannel(sizes);
  const errorShape = measureErrorShape(responses);
  const timingDecision = withinTolerance(timing, options.timingTolerance);
  const sizeDecision = withinTolerance(size, options.sizeTolerance);
  const errorDecision = errorShapeWithinTolerance(
    errorShape,
    options.errorTolerance,
  );
  return {
    version: 1,
    deploymentMode: options.deploymentMode,
    samplesPerCondition: options.samplesPerCondition,
    timing,
    timingDecision,
    size,
    sizeDecision,
    errorShape,
    errorDecision,
    passed:
      timingDecision.withinTolerance &&
      sizeDecision.withinTolerance &&
      errorDecision.withinTolerance,
  };
}
