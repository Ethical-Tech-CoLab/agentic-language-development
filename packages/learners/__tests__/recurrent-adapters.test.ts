import { HASH_DOMAINS } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import { runLearnerAdapterConformance } from '../src/conformance.js';
import { RECURRENT_ARCHITECTURE } from '../src/recurrent-model.js';
import {
  ExportedRecurrentScratchPolicySchema,
} from '../src/recurrent-scratch-policy.js';
import {
  ExportedSelfSupervisedPolicySchema,
  createRecurrentSelfSupervisedAdapterFactory,
} from '../src/self-supervised.js';
import { createRecurrentActorCriticAdapterFactory } from '../src/tabular-reinforce.js';

const recurrentOptions = {
  learningRate: 0.01,
  recurrent: { hiddenSize: 8, ppoEpochs: 4 },
} as const;

describe('recurrent scientific adapters (ALD-045, ALD-046)', () => {
  it('runs the scratch GRU actor-critic through the complete adapter contract', async () => {
    const result = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory(recurrentOptions),
      { episodes: 40, seed: 'recurrent-adapter-contract' },
    );

    expect(result.proposals).toBe(80);
    for (const role of ['baby-a', 'baby-b'] as const) {
      const policy = ExportedRecurrentScratchPolicySchema.parse(
        result.adapters[role].exportPolicy(),
      );
      expect(policy.architecture).toBe(RECURRENT_ARCHITECTURE);
      expect(policy.model.updateCount).toBe(40);
      expect(policy.model.parameterCount).toBeGreaterThan(0);
      expect(result.checkpoints[role]).toHaveLength(40);
      expect(result.ledgers[role].countOf('intention.recorded')).toBe(40);
      expect(result.ledgers[role].countOf('interpretation.recorded')).toBe(20);
    }
  });

  it('restores a recurrent policy exactly and keeps its exported weights frozen in evaluation', async () => {
    const trained = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory(recurrentOptions),
      { episodes: 24, seed: 'recurrent-restore-source' },
    );
    const initialPolicies = {
      'baby-a': trained.adapters['baby-a'].exportPolicy(),
      'baby-b': trained.adapters['baby-b'].exportPolicy(),
    };
    const evaluation = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory(recurrentOptions),
      {
        episodes: 12,
        seed: 'recurrent-restore-evaluation',
        updatePolicy: false,
        initialPolicies: JSON.parse(JSON.stringify(initialPolicies)),
      },
    );

    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(evaluation.adapters[role].exportPolicy()).toEqual(
        initialPolicies[role],
      );
      expect(new Set(evaluation.policyHashes[role])).toEqual(
        new Set([
          hashCanonical(HASH_DOMAINS.policyCheckpoint, initialPolicies[role]),
        ]),
      );
    }
  });

  it('keeps independently seeded Baby policies distinct', async () => {
    const result = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory(recurrentOptions),
      { episodes: 1, seed: 'recurrent-independent-init', updatePolicy: false },
    );

    const babyA = ExportedRecurrentScratchPolicySchema.parse(
      result.adapters['baby-a'].exportPolicy(),
    );
    const babyB = ExportedRecurrentScratchPolicySchema.parse(
      result.adapters['baby-b'].exportPolicy(),
    );
    expect(babyA.model.parameters).not.toEqual(babyB.model.parameters);
    expect(babyA.model.optimizer.step).toBe(0);
    expect(babyB.model.optimizer.step).toBe(0);
  });

  it('runs the reward-free GRU through the same adapter contract and capacity', async () => {
    const scratch = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory(recurrentOptions),
      { episodes: 8, seed: 'matched-scratch-capacity' },
    );
    const rewardFree = await runLearnerAdapterConformance(
      createRecurrentSelfSupervisedAdapterFactory(recurrentOptions),
      {
        episodes: 8,
        seed: 'matched-reward-free-capacity',
        learningSignal: 'self-supervised',
        rewardVisibility: 'forbidden',
      },
    );

    for (const role of ['baby-a', 'baby-b'] as const) {
      const scratchPolicy = ExportedRecurrentScratchPolicySchema.parse(
        scratch.adapters[role].exportPolicy(),
      );
      const rewardFreePolicy = ExportedSelfSupervisedPolicySchema.parse(
        rewardFree.adapters[role].exportPolicy(),
      );
      expect(rewardFreePolicy.version).toBe(2);
      if (rewardFreePolicy.version !== 2) throw new Error('expected recurrent policy');
      expect(rewardFreePolicy.model.kind).toBe(RECURRENT_ARCHITECTURE);
      expect(rewardFreePolicy.model.model.parameterCount).toBe(
        scratchPolicy.model.parameterCount,
      );
      expect(rewardFree.checkpoints[role]).toHaveLength(8);
      expect(rewardFree.ledgers[role].countOf('intention.recorded')).toBe(8);
      expect(rewardFree.ledgers[role].countOf('interpretation.recorded')).toBe(4);
    }
  });

  it('restores and freezes the recurrent reward-free policy', async () => {
    const source = await runLearnerAdapterConformance(
      createRecurrentSelfSupervisedAdapterFactory(recurrentOptions),
      {
        episodes: 12,
        seed: 'reward-free-restore-source',
        learningSignal: 'self-supervised',
        rewardVisibility: 'forbidden',
      },
    );
    const initialPolicies = {
      'baby-a': source.adapters['baby-a'].exportPolicy(),
      'baby-b': source.adapters['baby-b'].exportPolicy(),
    };
    const evaluation = await runLearnerAdapterConformance(
      createRecurrentSelfSupervisedAdapterFactory(recurrentOptions),
      {
        episodes: 8,
        seed: 'reward-free-restore-source',
        learningSignal: 'self-supervised',
        rewardVisibility: 'forbidden',
        updatePolicy: false,
        initialPolicies: JSON.parse(JSON.stringify(initialPolicies)),
      },
    );

    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(evaluation.adapters[role].exportPolicy()).toEqual(
        initialPolicies[role],
      );
      expect(new Set(evaluation.policyHashes[role]).size).toBe(1);
    }
  });
});
