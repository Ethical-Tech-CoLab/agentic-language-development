/** E22 runtime integration for the pre-registered fixed curriculum. */
import { afterEach, describe, expect, it } from 'vitest';

import { ReferentialScenarioEngine } from '@ald/scenario';
import { fixedTokenInventory, type RunConfig } from '@ald/types';

import {
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function selfSupervisedCurriculum(runId: string): RunConfig {
  return testConfig({
    runId,
    experimentId: 'E22',
    randomSeed: `seed-${runId}`,
    babyA: { track: 'self-supervised', modelRef: 'reference:self-supervised' },
    babyB: { track: 'self-supervised', modelRef: 'reference:self-supervised' },
    learningSignal: 'self-supervised',
    maxTurnsPerRun: 4,
    evaluationTurns: 1,
    interventionPlan: {
      version: 1,
      curriculum: {
        stages: [
          {
            stageIndex: 0,
            startTurn: 0,
            learnerOptions: { learningRate: 0.5 },
          },
          { stageIndex: 1, startTurn: 2, consolidation: true },
        ],
      },
    },
  });
}

describe('curriculum execution in NurseryRuntimeImpl', () => {
  it('applies each transition once before its turn and records policy hashes', async () => {
    harness = await createHarness();
    const config = selfSupervisedCurriculum('runtime-curriculum');
    await harness.runtime.createRun(config);

    expect(
      harness.runtime
        .auditLog(config.runId)
        .filter((event) => event.eventType === 'curriculum-transition'),
    ).toEqual([]);

    await harness.runtime.step(config.runId);
    await harness.runtime.step(config.runId);
    let transitions = harness.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'curriculum-transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.details).toMatchObject({
      stageIndex: 0,
      scheduledTurn: 0,
      appliedBeforeTurn: 0,
    });

    await harness.runtime.step(config.runId);
    transitions = harness.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'curriculum-transition');
    expect(transitions).toHaveLength(2);
    expect(transitions[1]?.details).toMatchObject({
      stageIndex: 1,
      scheduledTurn: 2,
      appliedBeforeTurn: 2,
      stage: { consolidation: true },
    });
    for (const event of transitions) {
      for (const field of ['policyHashesBefore', 'policyHashesAfter'] as const) {
        expect(event.details[field]).toMatchObject({
          'baby-a': expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          'baby-b': expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        });
      }
    }

    const restarted = harness.restart();
    harness = restarted;
    await restarted.runtime.recover(config.runId);
    const finalTrainingTurn = await restarted.runtime.step(config.runId);
    expect(finalTrainingTurn).toMatchObject({ turn: 3, state: 'evaluating' });
    const evaluationTurn = await restarted.runtime.step(config.runId);
    expect(evaluationTurn).toMatchObject({
      turn: 4,
      phase: 'evaluating',
      state: 'sealing',
    });
    const afterRestart = restarted.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'curriculum-transition');
    expect(afterRestart).toHaveLength(2);
    expect(
      restarted.runtime
        .auditLog(config.runId)
        .find((event) => event.reasonCode === 'restart-recovery')?.details,
    ).toMatchObject({ curriculumStageRestored: 1 });
  });

  it('rejects a curriculum before run registration when an adapter cannot apply stages', async () => {
    harness = await createHarness();
    const config = testConfig(
      noLearningOverrides({
        runId: 'runtime-curriculum-unsupported',
        experimentId: 'E22',
        randomSeed: 'seed-runtime-curriculum-unsupported',
        maxTurnsPerRun: 2,
        evaluationTurns: 1,
        interventionPlan: {
          version: 1,
          curriculum: {
            stages: [{ stageIndex: 0, startTurn: 0, consolidation: true }],
          },
        },
      }),
    );

    await expect(harness.runtime.createRun(config)).rejects.toMatchObject({
      code: 'invalid-configuration',
    });
    expect(harness.runtime.getRun(config.runId)).toBeUndefined();
  });

  it('binds held-out type codes into the frozen scenario bundle', async () => {
    harness = await createHarness();
    const config = testConfig(
      noLearningOverrides({
        runId: 'runtime-held-out',
        experimentId: 'E15',
        randomSeed: 'seed-runtime-held-out',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
        interventionPlan: { version: 1, heldOutTypeCodes: [3, 7] },
      }),
    );
    await harness.runtime.createRun(config);

    const expected = new ReferentialScenarioEngine(
      {
        version: 1,
        symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
        interactionMode: config.interactionMode,
        heldOutTypeCodes: [3, 7],
      },
      config.randomSeed,
    );
    const metadata = harness.runtime.writerFor(config.runId).readRunMetadata(
      config.runId,
    );
    const recordedConfig = JSON.parse(
      metadata?.configurationJson ?? '{}',
    ) as RunConfig;
    expect(recordedConfig.scenarioBundleHash).toBe(expected.bundleHash);
  });
});
