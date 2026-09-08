/** E16 live causal-probe execution through the Nursery and Gateway. */
import { afterEach, describe, expect, it } from 'vitest';

import { parseCanonicalJson } from '@ald/hashing';
import { TurnRecordSchema, type RunConfig } from '@ald/types';

import { createHarness, testConfig, type Harness } from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function probeConfig(runId: string): RunConfig {
  return testConfig({
    runId,
    experimentId: 'E16',
    randomSeed: `seed-${runId}`,
    babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 16,
    evaluationTurns: 4,
    interventionPlan: {
      version: 1,
      evaluationSuite: {
        ablation: true,
        substitution: true,
        scramblingControl: true,
        probeShare: 1,
      },
    },
  });
}

describe('causal probes in NurseryRuntimeImpl', () => {
  it('freezes the ledger-derived schedule before evaluation and records applied probes', async () => {
    harness = await createHarness();
    const config = probeConfig('runtime-causal-probes');
    await harness.runtime.createRun(config);

    for (let turn = 0; turn < config.maxTurnsPerRun; turn += 1) {
      await harness.runtime.step(config.runId);
    }
    expect(harness.runtime.getRun(config.runId)?.state).toBe('evaluating');

    const frozen = harness.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'probe-schedule');
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.details).toMatchObject({
      frozenBeforeTurn: config.maxTurnsPerRun,
      schedule: {
        scheduleVersion: 'intervention-probe-schedule/v1',
        targetProbeCount: 4,
      },
    });

    for (let offset = 0; offset < 2; offset += 1) {
      await harness.runtime.step(config.runId);
    }
    const restarted = harness.restart();
    harness = restarted;
    await restarted.runtime.recover(config.runId);
    expect(
      restarted.runtime
        .auditLog(config.runId)
        .filter((event) => event.eventType === 'probe-schedule'),
    ).toHaveLength(1);
    expect(
      restarted.runtime
        .auditLog(config.runId)
        .find((event) => event.reasonCode === 'restart-recovery')?.details,
    ).toMatchObject({ probeScheduleRestored: true });
    for (let offset = 2; offset < (config.evaluationTurns ?? 0); offset += 1) {
      await restarted.runtime.step(config.runId);
    }

    const probeEvents = restarted.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'causal-probe');
    expect(probeEvents.length).toBeGreaterThan(0);
    expect(probeEvents.some((event) => event.reasonCode === 'live-probe-applied')).toBe(
      true,
    );
    const appliedHashes = new Set(
      probeEvents
        .filter((event) => event.reasonCode === 'live-probe-applied')
        .map((event) => event.details['application'])
        .map((application) =>
          (application as { probeHash?: unknown }).probeHash,
        ),
    );
    const turnRecords = restarted.runtime
      .writerFor(config.runId)
      .readEvents(config.runId, 'turns')
      .map((event) =>
        TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)),
      );
    expect(
      turnRecords
        .filter((record) => record.phase === 'evaluating')
        .filter((record) => record.probeHash !== undefined)
        .every((record) => appliedHashes.has(record.probeHash)),
    ).toBe(true);
  });

  it('rejects live probes on a non-symbolic carrier before registering the run', async () => {
    harness = await createHarness();
    const config = {
      ...probeConfig('runtime-causal-probes-bitmap'),
      carrierMode: 'generative-bitmap' as const,
    };
    await expect(harness.runtime.createRun(config)).rejects.toMatchObject({
      code: 'invalid-configuration',
    });
    expect(harness.runtime.getRun(config.runId)).toBeUndefined();
  });
});
