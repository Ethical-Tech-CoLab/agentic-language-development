import { ScriptedModelClient, formatModelRef } from '@ald/learners';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, testConfig, type Harness } from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('frozen-LLM runtime provenance evidence (ALD-044)', () => {
  it('selects the configured track and witnesses exact model and weight hashes', async () => {
    const client = new ScriptedModelClient();
    const model = client.describe();
    const modelRef = formatModelRef(model.modelId, model.weightsHash);
    harness = await createHarness({ learnerOptions: { shared: { client } } });
    const config = testConfig({
      runId: 'frozen-provenance-evidence',
      experimentId: 'E10',
      randomSeed: 'frozen-provenance-seed',
      babyA: { track: 'frozen-llm', modelRef },
      babyB: { track: 'frozen-llm', modelRef },
      learningSignal: 'none',
      maxTurnsPerRun: 1,
    });

    await harness.runtime.createRun(config);
    const initialization = harness.runtime
      .auditLog(config.runId)
      .find((event) => event.reasonCode === 'learner-initialization');
    const provenance = initialization?.details?.['provenance'] as Record<
      string,
      { modelRef: string; components: Array<{ hash: string; name: string }> }
    >;
    for (const role of ['baby-a', 'baby-b']) {
      expect(provenance[role]).toMatchObject({
        modelRef,
        components: [
          expect.objectContaining({ name: model.modelId, hash: model.weightsHash }),
        ],
      });
    }
    expect(
      harness.runtime.checkpoints(config.runId)[0]?.auxiliaryTrees['intervention']
        ?.treeSize,
    ).toBe(1);
  });
});
