/**
 * ALD-044 criterion 2 and criterion 3 (conformance half): the `frozen-llm`
 * adapter completes full turns in both roles, over several seeds, through the
 * shared `runLearnerAdapterConformance` harness — the same harness the
 * `no-learning` and `scratch-rl` reference tracks pass — and satisfies the
 * SPEC §6.2 rule that `updatePolicy` is absent for this track.
 *
 * Prototype Mode. The model is a deterministic `ScriptedModelClient`: this
 * machine has no 3B-8B open-weight model and no GPU. Everything asserted here
 * is software readiness of the adapter and its seams. The success rates the
 * scripted convention produces are a property of the double and are not a
 * finding about any model's behavior.
 */
import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import { runLearnerAdapterConformance } from '../src/conformance.js';
import { createFrozenLlmAdapterFactory } from '../src/frozen-llm.js';
import { ScriptedModelClient } from '../src/llm-scripted-client.js';

const INVENTORY_SIZE = 32;
const INVENTORY = fixedTokenInventory(INVENTORY_SIZE);
const SEEDS = ['ald-e10-seed-1', 'ald-e10-seed-2', 'ald-e10-seed-3'];

function factory(
  overrides: { behaviors?: Parameters<typeof ScriptedModelClient>[0] } = {},
): ReturnType<typeof createFrozenLlmAdapterFactory> {
  void overrides;
  return createFrozenLlmAdapterFactory({
    client: new ScriptedModelClient({ symbolInventory: INVENTORY }),
    valuesPerAttribute: 4,
    attributeCount: 2,
    messageLength: 1,
  });
}

describe('ALD-044 criterion 2: full turns through the conformance harness', () => {
  it.each(SEEDS)(
    'completes 16 episodes in both roles under seed %s',
    async (seed) => {
      const result = await runLearnerAdapterConformance(factory(), {
        episodes: 16,
        seed,
        symbolInventorySize: INVENTORY_SIZE,
      });

      expect(result.episodes).toBe(16);
      // One sender proposal and one receiver proposal per episode.
      expect(result.proposals).toBe(32);
      for (const role of ['baby-a', 'baby-b'] as const) {
        const ledger = result.ledgers[role];
        expect(ledger.countOf('intention.recorded')).toBeGreaterThan(0);
        expect(ledger.countOf('interpretation.recorded')).toBeGreaterThan(0);
        expect(ledger.countOf('term.first_emitted')).toBeGreaterThan(0);
        expect(ledger.countOf('term.first_received')).toBeGreaterThan(0);
        expect(ledger.countOf('hypothesis.created')).toBeGreaterThan(0);
        expect(ledger.countOf('policy.checkpointed')).toBe(0);
      }
    },
  );

  it('never reads OutcomeEvent.reward: this track consumes no learning signal', async () => {
    // `rewardVisibility: 'forbidden'` makes reading `outcome.reward` throw.
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 8,
      seed: SEEDS[0],
      symbolInventorySize: INVENTORY_SIZE,
      rewardVisibility: 'forbidden',
    });
    expect(result.episodes).toBe(8);
  });

  it('exposes no updatePolicy, so the harness records no checkpoints', async () => {
    const built = factory();
    const adapter = built.create();
    expect(adapter.updatePolicy).toBeUndefined();

    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 4,
      seed: SEEDS[1],
      symbolInventorySize: INVENTORY_SIZE,
    });
    expect(result.checkpoints['baby-a']).toHaveLength(0);
    expect(result.checkpoints['baby-b']).toHaveLength(0);
  });

  it('reports provenance and an exported policy for every adapter it built', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 4,
      seed: SEEDS[2],
      symbolInventorySize: INVENTORY_SIZE,
    });
    for (const role of ['baby-a', 'baby-b'] as const) {
      const adapter = result.adapters[role];
      expect(adapter.describeProvenance?.()).toMatchObject({
        track: 'frozen-llm',
        weightUpdatePath: 'none',
      });
      expect(adapter.exportPolicy()).toMatchObject({
        track: 'frozen-llm',
        contractVersion: '1',
      });
    }
  });
});

describe('ALD-044 determinism (SPEC §14.3)', () => {
  it.each(SEEDS)(
    'reproduces identical policy hashes and ledger drafts under seed %s',
    async (seed) => {
      const options = {
        episodes: 10,
        seed,
        symbolInventorySize: INVENTORY_SIZE,
      } as const;
      const first = await runLearnerAdapterConformance(factory(), options);
      const second = await runLearnerAdapterConformance(factory(), options);

      expect(second.policyHashes).toEqual(first.policyHashes);
      expect(second.successFlags).toEqual(first.successFlags);
      for (const role of ['baby-a', 'baby-b'] as const) {
        expect(second.ledgers[role].drafts).toEqual(
          first.ledgers[role].drafts,
        );
        expect(
          hashCanonical(
            HASH_DOMAINS.policyCheckpoint,
            second.adapters[role].exportPolicy(),
          ),
        ).toBe(
          hashCanonical(
            HASH_DOMAINS.policyCheckpoint,
            first.adapters[role].exportPolicy(),
          ),
        );
      }
    },
  );

  it('gives different seeds different private conventions', async () => {
    const first = await runLearnerAdapterConformance(factory(), {
      episodes: 8,
      seed: SEEDS[0],
      symbolInventorySize: INVENTORY_SIZE,
    });
    const second = await runLearnerAdapterConformance(factory(), {
      episodes: 8,
      seed: SEEDS[1],
      symbolInventorySize: INVENTORY_SIZE,
    });
    // The episodes themselves are seeded, so the two runs differ somewhere in
    // the private ledgers even though the model is the same double.
    expect(second.ledgers['baby-a'].drafts).not.toEqual(
      first.ledgers['baby-a'].drafts,
    );
  });

  it('is a scripted convention, not a result: the success rate is recorded, not tuned', async () => {
    const rates = await Promise.all(
      SEEDS.map(async (seed) => {
        const result = await runLearnerAdapterConformance(factory(), {
          episodes: 16,
          seed,
          symbolInventorySize: INVENTORY_SIZE,
        });
        return result.successRate;
      }),
    );
    // The only assertions are that the rate is well defined and reproducible.
    // No threshold is claimed: the double's shared naming function, not any
    // model or any learning, is what determines it.
    for (const rate of rates) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
    const repeat = await runLearnerAdapterConformance(factory(), {
      episodes: 16,
      seed: SEEDS[0],
      symbolInventorySize: INVENTORY_SIZE,
    });
    expect(repeat.successRate).toBe(rates[0]);
  });
});
