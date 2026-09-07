/**
 * ALD-025 with a learning track: an E11-style `scratch-rl` naming-game run
 * through the full runtime. The point of this test is not the learning curve
 * itself (that is `@ald/learners`' own conformance test) but that the
 * orchestrator drives the §8.1 phases in an order the track can learn from,
 * and that §7.2 really does disable `updatePolicy` once evaluation starts.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HASH_DOMAINS, type TurnRecord } from '@ald/types';
import { hashCanonical } from '@ald/hashing';

import { bundleDir, createHarness, successRate, testConfig, type Harness } from './helpers.js';

const RUN_ID = 'run-e11-scratch-rl';
const TRAINING_TURNS = 1200;
const EVALUATION_TURNS = 100;

interface PolicySample {
  phase: TurnRecord['phase'];
  babyA: string;
  babyB: string;
}

describe('E11 scratch-rl run (ALD-025)', () => {
  let harness: Harness;
  let records: TurnRecord[];
  const samples: PolicySample[] = [];

  beforeAll(async () => {
    harness = await createHarness({
      learnerOptions: { shared: { learningRate: 1, temperature: 0.5 } },
    });
    const config = testConfig({
      runId: RUN_ID,
      experimentId: 'E11',
      randomSeed: 'ald-e11-orchestrator',
      babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      learningSignal: 'extrinsic-task',
      maxTurnsPerRun: TRAINING_TURNS,
      evaluationTurns: EVALUATION_TURNS,
      // Keeps the number of full Merkle rebuilds in this long run bounded.
      checkpointEventInterval: 512,
    });

    await harness.runtime.createRun(config);
    await harness.runtime.runToCompletion(RUN_ID, {
      onTurn: (result) => {
        const adapters = harness.runtime.adaptersFor(RUN_ID);
        samples.push({
          phase: result.phase,
          babyA: hashCanonical(
            HASH_DOMAINS.policyCheckpoint,
            adapters['baby-a'].exportPolicy(),
          ),
          babyB: hashCanonical(
            HASH_DOMAINS.policyCheckpoint,
            adapters['baby-b'].exportPolicy(),
          ),
        });
      },
    });
    records = harness.runtime.turnRecords(RUN_ID);
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('executes the whole training and evaluation budget', () => {
    expect(records).toHaveLength(TRAINING_TURNS + EVALUATION_TURNS);
    expect(harness.runtime.getRun(RUN_ID)?.state).toBe('aborted-sealed');
  });

  it('learns above chance by the end of training', () => {
    const training = records.filter((record) => record.phase === 'running');
    const tail = training.slice(-100);
    const rate = successRate(
      tail.map((record) => ({ success: record.outcome.success === true })),
    );
    expect(rate).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps the learned policy above chance on the evaluation split', () => {
    const evaluation = records.filter((record) => record.phase === 'evaluating');
    expect(evaluation).toHaveLength(EVALUATION_TURNS);
    const rate = successRate(
      evaluation.map((record) => ({ success: record.outcome.success === true })),
    );
    expect(rate).toBeGreaterThanOrEqual(0.5);
  });

  it('freezes both policies for the whole evaluation phase', () => {
    const evaluationSamples = samples.filter(
      (sample) => sample.phase === 'evaluating',
    );
    expect(evaluationSamples).toHaveLength(EVALUATION_TURNS);
    const first = evaluationSamples[0];
    expect(first).toBeDefined();
    for (const sample of evaluationSamples) {
      expect(sample.babyA).toBe(first?.babyA);
      expect(sample.babyB).toBe(first?.babyB);
    }
    // The policy also moved during training, so the freeze is not vacuous.
    const training = samples.filter((sample) => sample.phase === 'running');
    expect(new Set(training.map((sample) => sample.babyA)).size).toBeGreaterThan(1);
  });

  it('leaves the exported latest policy equal to the final in-memory policy', async () => {
    const adapters = harness.runtime.adaptersFor(RUN_ID);
    for (const role of ['baby-a', 'baby-b'] as const) {
      const text = await readFile(
        join(bundleDir(harness, RUN_ID), 'policies', `${role}-latest.json`),
        'utf8',
      );
      expect(JSON.parse(text)).toEqual(adapters[role].exportPolicy());
    }
  });

  it('records the learner event types LEDGER §5 names', () => {
    const ledgers = harness.runtime.ledgers(RUN_ID);
    for (const ledger of [ledgers.babyA, ledgers.babyB]) {
      const types = new Set(ledger.map((event) => event.eventType));
      expect(types.has('intention.recorded')).toBe(true);
      expect(types.has('interpretation.recorded')).toBe(true);
      expect(types.has('term.first_emitted')).toBe(true);
      expect(types.has('policy.checkpointed')).toBe(true);
      expect(types.has('run.sealed')).toBe(true);
      expect(
        [...types].some((type) => type.startsWith('hypothesis.')),
      ).toBe(true);
    }
  });

  it('writes a policy checkpoint file for a mid-run checkpoint turn', () => {
    const checkpoints = harness.runtime.checkpoints(RUN_ID);
    expect(
      checkpoints.some((manifest) => manifest.reason === 'policy-checkpoint'),
    ).toBe(true);
    expect(
      checkpoints.some((manifest) => manifest.reason === 'event-interval'),
    ).toBe(true);
  });
});
