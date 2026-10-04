/**
 * LV01 scheduled-case serving: the nursery serves the scheduled case to the
 * scheduled receiver at turn 0 (even baby-a, whom turn-0 role math would
 * never pick), never serves a scheduled turn past turn 0, and fails closed
 * when the engine cannot generate scheduled cases.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReferentialScenarioEngine,
  ScenarioBundleRegistry,
  readGroundTruth,
  registerGeneratorConfig,
} from '@ald/scenario';
import { fixedTokenInventory, type BabyRole, type RunConfig } from '@ald/types';

import { createLv01PairedCasePlan } from '../../src/experiments/ledger-value.js';
import { createHarness, testConfig, type Harness } from '../helpers.js';

const LEDGER_VALUE_PLAN = {
  version: 1 as const,
  designCommitmentHash: `sha256:${'a'.repeat(64)}`,
  analysisCommitmentHash: `sha256:${'b'.repeat(64)}`,
  seedResourceCommitmentHash: `sha256:${'c'.repeat(64)}`,
  predictionFunctionVersion: 'lv01-ledger-value-prediction/v1' as const,
  partitionContractVersion: 'lv01-within-support/v1' as const,
};

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function scheduledChild(
  runtime: Harness['runtime'],
  receiver: BabyRole,
): Promise<RunConfig> {
  const rootSeed = `sha256:${'7'.repeat(64)}`;
  // Run IDs pass through the prose hygiene scan, which splits kebab-case and
  // rejects stopwords, so the role segment is de-hyphenated (`babya`, not a
  // bare `a`). The receiver role itself is unchanged everywhere else.
  const receiverTag = receiver.replace('-', '');
  const parent = testConfig({
    runId: `lv01-scheduled-parent-${receiverTag}`,
    experimentId: 'LV01',
    randomSeed: rootSeed,
    seedBindings: {
      version: 1,
      scenario: rootSeed,
      babyA: `sha256:${'1'.repeat(64)}`,
      babyB: `sha256:${'2'.repeat(64)}`,
      gateway: `sha256:${'3'.repeat(64)}`,
      analysis: `sha256:${'4'.repeat(64)}`,
    },
    babyA: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'gru-actor-critic-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 3,
    evaluationTurns: 1,
    ledgerValuePlan: LEDGER_VALUE_PLAN,
  });
  await runtime.createRun(parent);
  await runtime.runToCompletion(parent.runId);
  const checkpoint = runtime.checkpoints(parent.runId).at(-1)?.checkpointHash as string;
  const slice = {
    selectedToken: 'S01',
    deliveredToken: 'S01',
    batchCommitment: `sha256:${'e'.repeat(64)}`,
    sourceCaseId: 'scheduled-serving',
  };
  const plan = createLv01PairedCasePlan({
    parent,
    parentCheckpointHash: checkpoint,
    babyAInitialPolicyRef: 'policies/baby-a-latest.json',
    babyBInitialPolicyRef: 'policies/baby-b-latest.json',
    childRunIdPrefix: `lv01-scheduled-${receiverTag}`,
    actionDrawScope: { stage: 'development', slotKind: 'primary', slotIndex: '0001', partition: 'dev' },
    slotSeeds: {
      scenario: `sha256:${'6'.repeat(64)}`,
      babyA: `sha256:${'1'.repeat(64)}`,
      babyB: `sha256:${'2'.repeat(64)}`,
      gateway: `sha256:${'3'.repeat(64)}`,
      analysis: `sha256:${'4'.repeat(64)}`,
    },
    scheduledCase: { partition: 'within-support-test', caseIndex: 0, receiverRole: receiver },
    ledgerTreatments: {
      'ledger-consistent': { ...slice },
      'ledger-shuffled': { ...slice },
    },
  });
  return plan.branches.find((entry) => entry.branch === 'normal')!.config;
}

/** The same engine the nursery builds for this run config. */
function mirrorEngine(config: RunConfig): ReferentialScenarioEngine {
  return new ReferentialScenarioEngine(
    {
      version: 1,
      symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
      interactionMode: config.interactionMode,
      heldOutTypeCodes: config.interventionPlan?.heldOutTypeCodes ?? [],
    },
    config.randomSeed,
  );
}

function predictionPayload(runId: string): {
  receiver: string;
  candidateTypeCodes: readonly number[];
  state: { scenarioStateHash: string };
} {
  const event = harness!.runtime.auditLog(runId).find(
    (entry) => (entry as { reasonCode?: string }).reasonCode === 'lv01-paired-pre-receiver-action-prediction-committed',
  ) as unknown as { details: { predictionPayload: {
    receiver: string;
    candidateTypeCodes: readonly number[];
    state: { scenarioStateHash: string };
  } } };
  return event.details.predictionPayload;
}

describe('LV01 scheduled-case serving', () => {
  it('serves the scheduled baby-a case at turn 0, matching direct generation', async () => {
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined
          ? undefined
          : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
    });
    const child = await scheduledChild(harness.runtime, 'baby-a');
    await harness.runtime.createRun(child);
    await harness.runtime.step(child.runId);

    const payload = predictionPayload(child.runId);
    expect(payload.receiver).toBe('baby-a');
    const expected = mirrorEngine(child).generateLv01Case(0, 'within-support-test', {
      sender: 'baby-b',
      receiver: 'baby-a',
    });
    expect(payload.state.scenarioStateHash).toBe(expected.scenario.stateHash);
    expect([...payload.candidateTypeCodes]).toEqual([
      ...readGroundTruth(expected.scenario.groundTruth).receiverOrder,
    ]);
    expect(harness.runtime.turnRecords(child.runId)).toHaveLength(1);
  });

  it('never serves a scheduled turn past turn 0', async () => {
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined
          ? undefined
          : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
    });
    const child = await scheduledChild(harness.runtime, 'baby-b');
    await harness.runtime.createRun(child);
    await harness.runtime.step(child.runId);
    await expect(harness.runtime.step(child.runId)).rejects.toThrow();
    expect(harness.runtime.turnRecords(child.runId)).toHaveLength(1);
  });

  it('fails closed when the engine cannot generate scheduled cases', async () => {
    const registry = new ScenarioBundleRegistry();
    harness = await createHarness({
      lv01PredictionFor: (config) =>
        config.lv01PairedCase === undefined
          ? undefined
          : { ordinaryId: 'uniform', ordinaryFit: { kind: 'uniform' } },
      scenarioBundleRegistry: registry,
      scenarioFactory: (config) => {
        const engine = new ReferentialScenarioEngine(
          {
            version: 1,
            symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
            interactionMode: config.interactionMode,
            heldOutTypeCodes: config.interventionPlan?.heldOutTypeCodes ?? [],
          },
          config.randomSeed,
        );
        registerGeneratorConfig({ ...engine.config }, { registry });
        return Object.assign(engine, { generateLv01Case: undefined });
      },
    });
    const child = await scheduledChild(harness.runtime, 'baby-b');
    await harness.runtime.createRun(child);
    await expect(harness.runtime.step(child.runId)).rejects.toThrow(/generateLv01Case/u);
  });
});
