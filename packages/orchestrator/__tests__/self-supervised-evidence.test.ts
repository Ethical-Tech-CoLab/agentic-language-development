import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UpdateBatchSchema } from '@ald/isolation';
import { verifyBundleDetailed } from '@ald/verifier';
import { afterEach, describe, expect, it } from 'vitest';

import { bundleDir, createHarness, testConfig, type Harness } from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('self-supervised update evidence (ALD-046)', () => {
  it('witnesses the loss and the strict outcome-free update schema', async () => {
    harness = await createHarness();
    const config = testConfig({
      runId: 'self-supervised-update-evidence',
      experimentId: 'E12',
      randomSeed: 'self-supervised-evidence-seed',
      babyA: { track: 'self-supervised' },
      babyB: { track: 'self-supervised' },
      learningSignal: 'self-supervised',
      maxTurnsPerRun: 1,
    });
    await harness.runtime.createRun(config);

    const initialization = harness.runtime
      .auditLog(config.runId)
      .find((event) => event.reasonCode === 'learner-initialization');
    const policies = initialization?.details?.['initialPolicies'] as Record<
      string,
      Record<string, unknown>
    >;
    for (const role of ['baby-a', 'baby-b']) {
      expect(policies[role]).toMatchObject({
        lossDefinition:
          'predictive-cross-entropy:message|candidate-features:v1',
        updateBatchFields: ['runId', 'turns', 'learningSignal'],
        outcomeLabelsIncluded: false,
      });
      const policy = JSON.parse(
        await readFile(
          join(bundleDir(harness, config.runId), String(policies[role]?.['policyFile'])),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(policy['lossDefinition']).toBe(policies[role]?.['lossDefinition']);
    }

    expect(
      UpdateBatchSchema.safeParse({
        runId: config.runId,
        turns: [0],
        learningSignal: 'self-supervised',
        outcomeLabels: [1],
      }).success,
    ).toBe(false);

    await harness.runtime.exportBundle(config.runId, bundleDir(harness, config.runId));
    const verified = await verifyBundleDetailed(bundleDir(harness, config.runId), {
      verifierVersion: 'self-supervised-evidence-test',
      now: () => '2026-09-09T00:00:00.000Z',
      allowUnanchored: true,
      writeReport: false,
    });
    expect(
      verified.report.gaps.filter(
        (gap) =>
          gap.startsWith('initial-policy-') ||
          gap.startsWith('self-supervised-update-contract-'),
      ),
    ).toEqual([]);
  });
});
