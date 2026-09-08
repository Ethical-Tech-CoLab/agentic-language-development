/**
 * ALD-039 criterion 1 — run registration consults the scenario quarantine
 * registry before it provisions run-owned state.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReferentialScenarioEngine,
  ScenarioBundleRegistry,
  registerGeneratorConfig,
  type ReferentialScenarioConfigInput,
} from '@ald/scenario';
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

function runConfig(runId: string): RunConfig {
  return testConfig(
    noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: `seed-${runId}`,
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
    }),
  );
}

function scenarioConfig(
  config: RunConfig,
  evaluationSeedLabel?: string,
): ReferentialScenarioConfigInput {
  return {
    version: 1,
    symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
    interactionMode: config.interactionMode,
    ...(evaluationSeedLabel === undefined ? {} : { evaluationSeedLabel }),
  };
}

describe('ALD-039 run-registration quarantine gate', () => {
  it('registers and approves the built-in text-free generator before use', async () => {
    const registry = new ScenarioBundleRegistry();
    harness = await createHarness({ scenarioBundleRegistry: registry });
    const config = runConfig('quarantine-built-in');

    await expect(harness.runtime.createRun(config)).resolves.toMatchObject({
      runId: config.runId,
      state: 'running',
    });
    expect(registry.entries()).toHaveLength(1);
    expect(registry.entries()[0]?.status).toBe('approved');
  });

  it('fails closed when a custom engine returns an unknown bundle hash', async () => {
    const registry = new ScenarioBundleRegistry();
    harness = await createHarness({
      scenarioBundleRegistry: registry,
      scenarioFactory: (config) =>
        new ReferentialScenarioEngine(scenarioConfig(config), config.randomSeed),
    });
    const config = runConfig('quarantine-unknown');

    await expect(harness.runtime.createRun(config)).rejects.toMatchObject({
      code: 'bundle-not-approved',
    });
    expect(harness.runtime.getRun(config.runId)).toBeUndefined();
  });

  it('refuses a quarantined custom bundle and permits the same factory only after approval', async () => {
    const rejectedConfig = runConfig('quarantine-rejected');
    const rejectedScenario = scenarioConfig(
      rejectedConfig,
      'the red target is the correct answer',
    );
    const resolvedRejectedScenario = new ReferentialScenarioEngine(
      rejectedScenario,
      rejectedConfig.randomSeed,
    ).config;
    const rejectedRegistry = new ScenarioBundleRegistry();
    const quarantine = registerGeneratorConfig({ ...resolvedRejectedScenario }, {
      registry: rejectedRegistry,
    });
    expect(quarantine.status).toBe('quarantined');

    harness = await createHarness({
      scenarioBundleRegistry: rejectedRegistry,
      scenarioFactory: (config) =>
        new ReferentialScenarioEngine(rejectedScenario, config.randomSeed),
    });
    await expect(
      harness.runtime.createRun(rejectedConfig),
    ).rejects.toMatchObject({ code: 'bundle-not-approved' });
    expect(harness.runtime.getRun(rejectedConfig.runId)).toBeUndefined();
    await harness.cleanup();

    const approvedConfig = runConfig('quarantine-approved');
    const approvedScenario = scenarioConfig(approvedConfig);
    const resolvedApprovedScenario = new ReferentialScenarioEngine(
      approvedScenario,
      approvedConfig.randomSeed,
    ).config;
    const approvedRegistry = new ScenarioBundleRegistry();
    expect(
      registerGeneratorConfig({ ...resolvedApprovedScenario }, {
        registry: approvedRegistry,
      }).status,
    ).toBe('approved');
    harness = await createHarness({
      scenarioBundleRegistry: approvedRegistry,
      scenarioFactory: (config) =>
        new ReferentialScenarioEngine(approvedScenario, config.randomSeed),
    });

    await expect(harness.runtime.createRun(approvedConfig)).resolves.toMatchObject({
      runId: approvedConfig.runId,
      state: 'running',
    });
  });
});
