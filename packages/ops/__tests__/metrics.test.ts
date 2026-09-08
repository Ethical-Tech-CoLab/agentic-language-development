/**
 * ALD-058 — the run-metric half of SPECIFICATION.md §14.1: "turns/minute,
 * rejection rate, affect-window utilization, checkpoint latency, and
 * anchor-confirmation latency", computed from a real evidence store.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { computeRunMetrics, windowsOpenedFor } from '@ald/ops';

import {
  createHarness,
  factoryFor,
  noLearningConfig,
  AlwaysRejectedAdapter,
  type Harness,
} from './support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('ALD-058: run metrics from the evidence store (SPEC §14.1)', () => {
  it('ALD-058: reports turns/minute, rejection rate and checkpoint latency for a real run', async () => {
    harness = await createHarness();
    const runId = 'metrics-run-1';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-metrics-1',
        maxTurnsPerRun: 4,
        evaluationTurns: 1,
        checkpointEventInterval: 4,
      }),
    );
    for (let index = 0; index < 4; index += 1) {
      await harness.runtime.step(runId);
    }

    const metrics = computeRunMetrics({
      evidence: harness.runtime.writerFor(runId),
      runId,
    });

    expect(metrics.version).toBe(1);
    expect(metrics.runId).toBe(runId);
    expect(metrics.turns).toBe(4);
    // The StepClock advances 1 s per read, so the span is positive and the
    // rate is a real measurement rather than a placeholder.
    expect(metrics.turnsPerMinute).not.toBeNull();
    expect(metrics.turnsPerMinute ?? 0).toBeGreaterThan(0);
    expect(metrics.channelEvents).toBeGreaterThan(0);
    expect(metrics.rejectionRate).toBe(0);
    expect(metrics.rejectedChannelEvents).toBe(0);
    expect(metrics.checkpointLatencyMs).not.toBeNull();
    expect(metrics.checkpointLatencyMs?.count ?? 0).toBeGreaterThan(0);
    expect(metrics.checkpointLatencyMs?.minMs ?? -1).toBeGreaterThanOrEqual(0);
    // No anchor publisher is wired in Mode P (SPEC §5.1/§13.4).
    expect(metrics.anchorConfirmationLatencyMs).toBeNull();
    // affectMode defaults to `none` (SPEC §9.3), so utilization is not a
    // measured 0 — it is not measurable, and is reported as such.
    expect(metrics.affectWindowUtilization).toBeNull();
    expect(metrics.affectWindowsOpened).toBeNull();
    expect(metrics.affectEvents).toBe(0);
  });

  it('ALD-058: rejection rate reflects §9.4 channel rejections', async () => {
    harness = await createHarness({
      adapterFactoryFor: () => factoryFor(() => new AlwaysRejectedAdapter()),
    });
    const runId = 'metrics-run-2';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-metrics-2',
        maxTurnsPerRun: 6,
        evaluationTurns: 1,
        maxConsecutiveRejections: 100,
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      await harness.runtime.step(runId);
    }

    const metrics = computeRunMetrics({
      evidence: harness.runtime.writerFor(runId),
      runId,
    });
    expect(metrics.channelEvents).toBe(3);
    expect(metrics.rejectedChannelEvents).toBe(3);
    expect(metrics.rejectionRate).toBe(1);
  });

  it('ALD-058: an empty run yields nulls, never fabricated zeroes', async () => {
    harness = await createHarness();
    const runId = 'metrics-run-3';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-metrics-3',
        maxTurnsPerRun: 2,
        evaluationTurns: 1,
      }),
    );

    const metrics = computeRunMetrics({
      evidence: harness.runtime.writerFor(runId),
      runId,
    });
    expect(metrics.turns).toBe(0);
    expect(metrics.turnsPerMinute).toBeNull();
    expect(metrics.rejectionRate).toBeNull();
    expect(metrics.affectWindowUtilization).toBeNull();
    expect(metrics.anchorConfirmationLatencyMs).toBeNull();
  });

  it('ALD-058: affect-window utilization follows the pre-registered schedule (SPEC §9.3 rule 2)', () => {
    expect(windowsOpenedFor('post-outcome', 12)).toBe(12);
    expect(windowsOpenedFor('post-outcome-every-4-turns', 12)).toBe(3);
    expect(windowsOpenedFor('post-outcome-every-5-turns', 12)).toBe(2);
    // An unrecognized schedule is never guessed at.
    expect(windowsOpenedFor('whenever-the-baby-likes', 12)).toBeUndefined();
    expect(windowsOpenedFor('post-outcome-every-0-turns', 12)).toBeUndefined();
  });

  it('ALD-058: affect-window utilization is computed when the channel is enabled', async () => {
    harness = await createHarness();
    const runId = 'metrics-run-4';
    const config = noLearningConfig({
      runId,
      experimentId: 'E03',
      randomSeed: 'seed-metrics-4',
      maxTurnsPerRun: 4,
      evaluationTurns: 1,
    });
    await harness.runtime.createRun(config);
    for (let index = 0; index < 2; index += 1) {
      await harness.runtime.step(runId);
    }

    // The affect channel is off in the stored config; asking for the metric
    // under a declared-affect config shows the ratio the runtime will report
    // once ALD-033 writes affect events (no affect event exists yet, so the
    // honest answer is 0 out of 2 windows).
    const metrics = computeRunMetrics({
      evidence: harness.runtime.writerFor(runId),
      runId,
      config: {
        ...config,
        affectMode: 'declared',
        affectWindowSchedule: 'post-outcome',
      },
    });
    expect(metrics.affectWindowsOpened).toBe(2);
    expect(metrics.affectWindowUtilization).toBe(0);
  });

  it('ALD-058: metrics are read-only — computing them twice changes nothing', async () => {
    harness = await createHarness();
    const runId = 'metrics-run-5';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-metrics-5',
        maxTurnsPerRun: 3,
        evaluationTurns: 1,
      }),
    );
    await harness.runtime.step(runId);
    await harness.runtime.step(runId);

    const writer = harness.runtime.writerFor(runId);
    const headBefore = writer.chainHead(runId, 'turns');
    const first = computeRunMetrics({ evidence: writer, runId });
    const second = computeRunMetrics({ evidence: writer, runId });
    expect(second).toEqual(first);
    expect(writer.chainHead(runId, 'turns')).toEqual(headBefore);
  });
});
