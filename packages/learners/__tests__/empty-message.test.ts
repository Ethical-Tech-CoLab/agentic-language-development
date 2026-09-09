/**
 * SPEC §9.6 `disabled`: a receiver turn with no delivered message.
 *
 * The control delivers no artifact at all, and §8.2 forbids an interpretation
 * event when there is no channel event to reference, so the receiver acts
 * without having received anything. Both reference tracks must therefore
 * accept an empty message: the choice falls back to uniform over the offered
 * candidates (no symbol, no information), the intention event records
 * `symbols: []`, and — for the learning track — the turn contributes no
 * REINFORCE update, because there is no symbol row to credit.
 */
import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';
import type {
  DeliveredChannelArtifact,
  LearnerAdapter,
  Observation,
  RunConfig,
} from '@ald/types';

import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { NoLearningAdapter } from '../src/no-learning.js';
import { TabularReinforceAdapter } from '../src/tabular-reinforce.js';

const SYMBOL_INVENTORY_SIZE = 8;
const CANDIDATES = 4;
const TURNS = 2_000;

/** Four candidate rows, receiver view (`attributeCount` columns, no target flag). */
const RECEIVER_PAYLOAD = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
];

/** One sender row set whose target is the first row. */
const SENDER_PAYLOAD = [
  [0, 0, 1],
  [1, 1, 0],
  [2, 2, 0],
  [3, 3, 0],
];

const CANDIDATE_REFS = Array.from(
  { length: CANDIDATES },
  (_, index) => `object:candidate-${String(index)}`,
);

function observation(
  config: RunConfig,
  turn: number,
  payload: number[][],
): Observation {
  return {
    runId: config.runId,
    turn,
    recipient: 'baby-a',
    encoding: 'opaque-numeric',
    payload,
    scenarioRef: 'scenario:empty-message',
  };
}

async function initAdapter<T extends LearnerAdapter>(
  adapter: T,
  track: 'no-learning' | 'scratch-rl',
  seed = 'seed-empty-message',
): Promise<{ adapter: T; config: RunConfig; ledger: RecordingLedgerClient }> {
  const config = buildConformanceRunConfig(track, {
    episodes: TURNS,
    symbolInventorySize: SYMBOL_INVENTORY_SIZE,
  });
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract(track),
    seed,
    symbolInventory: fixedTokenInventory(SYMBOL_INVENTORY_SIZE),
    ledger,
  });
  return { adapter, config, ledger };
}

function policyHash(adapter: LearnerAdapter): string {
  return hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy());
}

/** The frequency of each candidate index over `turns` empty-message turns. */
async function receiverFrequencies(
  adapter: LearnerAdapter,
  config: RunConfig,
  turns: number,
): Promise<number[]> {
  const counts = new Array<number>(CANDIDATES).fill(0);
  for (let turn = 1; turn <= turns; turn += 1) {
    await adapter.observe(observation(config, turn, RECEIVER_PAYLOAD));
    const envelope = await adapter.act({
      turn,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    const objectRef = (
      envelope.proposal.publicArtifact as { objectRef: string }
    ).objectRef;
    const index = CANDIDATE_REFS.indexOf(objectRef);
    expect(index).toBeGreaterThanOrEqual(0);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((count) => count / turns);
}

describe('scratch-rl receiver with no delivered message (SPEC §9.6 disabled)', () => {
  it('chooses uniformly over the candidates with no receive()', async () => {
    const { adapter, config } = await initAdapter(
      new TabularReinforceAdapter({ learningRate: 1, temperature: 0.5 }),
      'scratch-rl',
    );
    const frequencies = await receiverFrequencies(adapter, config, TURNS);
    for (const frequency of frequencies) {
      expect(frequency).toBeGreaterThanOrEqual(0.2);
      expect(frequency).toBeLessThanOrEqual(0.3);
    }
    expect(frequencies.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  }, 30_000);

  it('records an empty symbol list and no channel evidence ref', async () => {
    const { adapter, config } = await initAdapter(
      new TabularReinforceAdapter(),
      'scratch-rl',
    );
    await adapter.observe(observation(config, 1, RECEIVER_PAYLOAD));
    const envelope = await adapter.act({
      turn: 1,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    const draft = envelope.privateLedgerDraft;
    expect(draft.eventType).toBe('intention.recorded');
    expect(draft.content.symbols).toEqual([]);
    // §8.2: with nothing delivered there is no channel event to reference.
    expect(
      draft.evidenceRefs.some((ref) => ref.startsWith('channel:')),
    ).toBe(false);
    // The distribution over the four candidates is exactly uniform.
    expect(draft.content.associationWeights).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(draft.content.probability).toBe(0.25);
  });

  it('leaves the policy hash untouched when every receiver turn is empty', async () => {
    const { adapter, config } = await initAdapter(
      new TabularReinforceAdapter({ learningRate: 1, temperature: 0.5 }),
      'scratch-rl',
    );
    const before = policyHash(adapter);
    const receiverBefore = adapter.exportPolicy().thetaReceiver;
    for (let turn = 1; turn <= 200; turn += 1) {
      await adapter.observe(observation(config, turn, RECEIVER_PAYLOAD));
      await adapter.act({
        turn,
        role: 'receiver',
        responseBudgetMs: 1_000,
        availableActions: ['select_object'],
        candidateRefs: CANDIDATE_REFS,
      });
      const success = turn % 3 === 0;
      await adapter.onOutcome({
        runId: config.runId,
        turn,
        role: 'receiver',
        success,
        reward: success ? 1 : 0,
        payload: [success ? 1 : 0],
      });
      await adapter.updatePolicy?.({
        runId: config.runId,
        turns: [turn],
        learningSignal: 'extrinsic-task',
      });
    }
    // No symbol row to credit, and no baseline movement either: an
    // empty-message receiver turn is evidence about nothing.
    expect(policyHash(adapter)).toBe(before);
    const policy = adapter.exportPolicy() as {
      baseline: number;
      thetaReceiver: number[][][];
    };
    expect(policy.baseline).toBe(0);
    expect(policy.thetaReceiver).toEqual(receiverBefore);
  }, 30_000);

  it('still updates the sender side of a run whose receiver turns are empty', async () => {
    const { adapter, config } = await initAdapter(
      new TabularReinforceAdapter({ learningRate: 1, temperature: 0.5 }),
      'scratch-rl',
    );
    const receiverBefore = adapter.exportPolicy().thetaReceiver;
    for (let turn = 1; turn <= 40; turn += 1) {
      const isSender = turn % 2 === 1;
      await adapter.observe(
        observation(config, turn, isSender ? SENDER_PAYLOAD : RECEIVER_PAYLOAD),
      );
      await adapter.act(
        isSender
          ? {
              turn,
              role: 'sender',
              responseBudgetMs: 1_000,
              availableActions: ['emit_symbols'],
            }
          : {
              turn,
              role: 'receiver',
              responseBudgetMs: 1_000,
              availableActions: ['select_object'],
              candidateRefs: CANDIDATE_REFS,
            },
      );
      await adapter.onOutcome({
        runId: config.runId,
        turn,
        role: isSender ? 'sender' : 'receiver',
        success: true,
        reward: 1,
        payload: [1],
      });
      await adapter.updatePolicy?.({
        runId: config.runId,
        turns: [turn],
        learningSignal: 'extrinsic-task',
      });
    }
    const policy = adapter.exportPolicy() as {
      baseline: number;
      thetaSender: number[][];
      thetaReceiver: number[][][];
    };
    // The sender half learned; the receiver half saw no symbol at all.
    expect(policy.thetaSender.flat().some((value) => value !== 0)).toBe(true);
    expect(policy.baseline).toBeGreaterThan(0);
    expect(policy.thetaReceiver).toEqual(receiverBefore);
  });

  it('does not reuse a message delivered on an earlier turn', async () => {
    const { adapter, config } = await initAdapter(
      new TabularReinforceAdapter(),
      'scratch-rl',
    );
    const delivery: DeliveredChannelArtifact = {
      runId: config.runId,
      turn: 1,
      logicalSender: 'baby-b',
      carrier: 'fixed-token',
      publicArtifact: { symbols: [fixedTokenInventory(SYMBOL_INVENTORY_SIZE)[0] as string] },
      channelEventHash: `sha256:${'a'.repeat(64)}`,
    };
    await adapter.observe(observation(config, 1, RECEIVER_PAYLOAD));
    await adapter.receive(delivery);
    const bound = await adapter.act({
      turn: 1,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    expect(bound.privateLedgerDraft.content.symbols).toHaveLength(1);

    // §8.2 `ledgerLagTurns: 0`: turn 2 delivered nothing, so turn 1's message
    // is not in hand any more.
    await adapter.observe(observation(config, 2, RECEIVER_PAYLOAD));
    const empty = await adapter.act({
      turn: 2,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    expect(empty.privateLedgerDraft.content.symbols).toEqual([]);
  });
});

describe('no-learning receiver with no delivered message (SPEC §9.6 disabled)', () => {
  it('chooses uniformly over the candidates with no receive()', async () => {
    const { adapter, config } = await initAdapter(
      new NoLearningAdapter(),
      'no-learning',
    );
    const frequencies = await receiverFrequencies(adapter, config, TURNS);
    for (const frequency of frequencies) {
      expect(frequency).toBeGreaterThanOrEqual(0.2);
      expect(frequency).toBeLessThanOrEqual(0.3);
    }
  }, 30_000);

  it('records an empty symbol list', async () => {
    const { adapter, config } = await initAdapter(
      new NoLearningAdapter(),
      'no-learning',
    );
    await adapter.observe(observation(config, 1, RECEIVER_PAYLOAD));
    const envelope = await adapter.act({
      turn: 1,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    expect(envelope.privateLedgerDraft.content.symbols).toEqual([]);
  });

  it('does not reuse a message delivered on an earlier turn', async () => {
    const { adapter, config } = await initAdapter(
      new NoLearningAdapter(),
      'no-learning',
    );
    await adapter.observe(observation(config, 1, RECEIVER_PAYLOAD));
    await adapter.receive({
      runId: config.runId,
      turn: 1,
      logicalSender: 'baby-b',
      carrier: 'fixed-token',
      publicArtifact: { symbols: [fixedTokenInventory(SYMBOL_INVENTORY_SIZE)[0] as string] },
      channelEventHash: `sha256:${'b'.repeat(64)}`,
    });
    const bound = await adapter.act({
      turn: 1,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    expect(bound.privateLedgerDraft.content.symbols).toHaveLength(1);

    await adapter.observe(observation(config, 2, RECEIVER_PAYLOAD));
    const empty = await adapter.act({
      turn: 2,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    expect(empty.privateLedgerDraft.content.symbols).toEqual([]);
  });
});
