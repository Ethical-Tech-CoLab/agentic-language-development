/** E14 bounded repair-turn execution and recovery. */
import { afterEach, describe, expect, it } from 'vitest';

import { parseCanonicalJson } from '@ald/hashing';
import { TurnRecordSchema } from '@ald/types';

import {
  createHarness,
  misbehavingFactory,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('repair execution in NurseryRuntimeImpl', () => {
  it('runs at most one extra attempt per failed episode without consuming another episode', async () => {
    harness = await createHarness({
      adapterFactoryFor: () => misbehavingFactory,
    });
    const config = testConfig(
      noLearningOverrides({
        runId: 'runtime-repair',
        experimentId: 'E14',
        randomSeed: 'seed-runtime-repair',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
        maxConsecutiveRejections: 10,
        interventionPlan: {
          version: 1,
          repair: { enabled: true, maxExtraTurns: 1 },
        },
      }),
    );
    await harness.runtime.createRun(config);

    const first = await harness.runtime.step(config.runId);
    expect(first).toMatchObject({ turn: 0, phase: 'running', state: 'running' });
    const trainingRepair = await harness.runtime.step(config.runId);
    expect(trainingRepair).toMatchObject({
      turn: 1,
      phase: 'running',
      state: 'evaluating',
    });

    const evaluation = await harness.runtime.step(config.runId);
    expect(evaluation).toMatchObject({
      turn: 2,
      phase: 'evaluating',
      state: 'evaluating',
    });
    const restarted = harness.restart({
      adapterFactoryFor: () => misbehavingFactory,
    });
    harness = restarted;
    await restarted.runtime.recover(config.runId);
    const evaluationRepair = await restarted.runtime.step(config.runId);
    expect(evaluationRepair).toMatchObject({
      turn: 3,
      phase: 'evaluating',
      state: 'sealing',
    });

    const records = restarted.runtime
      .writerFor(config.runId)
      .readEvents(config.runId, 'turns')
      .map((event) =>
        TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)),
      );
    expect(records).toHaveLength(4);
    expect(records[1]?.repairAttempt).toEqual({
      episodeId: records[0]?.scenarioRef,
      attempt: 1,
      originalTurn: 0,
    });
    expect(records[1]?.scenarioRef).toBe(records[0]?.scenarioRef);
    expect(records[3]?.repairAttempt).toEqual({
      episodeId: records[2]?.scenarioRef,
      attempt: 1,
      originalTurn: 2,
    });
    expect(records[3]?.scenarioRef).toBe(records[2]?.scenarioRef);
    expect(
      restarted.runtime
        .auditLog(config.runId)
        .filter((event) => event.eventType === 'repair-turn'),
    ).toHaveLength(2);
  });

  it('rejects repair combined with schedules whose turn numbering would be ambiguous', async () => {
    harness = await createHarness();
    const config = testConfig(
      noLearningOverrides({
        runId: 'runtime-repair-conflict',
        experimentId: 'E14',
        randomSeed: 'seed-runtime-repair-conflict',
        interventionPlan: {
          version: 1,
          repair: { enabled: true, maxExtraTurns: 1 },
          evaluationSuite: {
            ablation: true,
            substitution: false,
            scramblingControl: false,
            probeShare: 0.5,
          },
        },
      }),
    );
    await expect(harness.runtime.createRun(config)).rejects.toMatchObject({
      code: 'invalid-configuration',
    });
  });
});
