import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { domainHash, hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  NoLearningAdapter,
  createNoLearningAdapterFactory,
} from '../src/no-learning.js';
import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { LearnerStateError } from '../src/errors.js';

const factory = () => createNoLearningAdapterFactory();

async function initAdapter(seed = 'seed-a') {
  const adapter = new NoLearningAdapter();
  const config = buildConformanceRunConfig('no-learning', { episodes: 8 });
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('no-learning'),
    seed,
    symbolInventory: fixedTokenInventory(8),
    ledger,
  });
  return { adapter, ledger };
}

describe('NoLearningAdapter conformance (ALD-042)', () => {
  it('passes the adapter conformance harness', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 40,
      seed: 'no-learning-conformance',
    });
    expect(result.episodes).toBe(40);
    expect(result.proposals).toBe(80);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(result.ledgers[role].countOf('intention.recorded')).toBe(40);
      expect(result.ledgers[role].countOf('interpretation.recorded')).toBe(20);
      expect(result.ledgers[role].countOf('term.first_emitted')).toBeGreaterThan(0);
      expect(result.ledgers[role].countOf('term.first_received')).toBeGreaterThan(0);
      expect(result.ledgers[role].countOf('hypothesis.created')).toBe(0);
    }
  });

  it('exposes no updatePolicy method (SPEC §6.2)', async () => {
    const { adapter } = await initAdapter();
    expect(adapter.updatePolicy).toBeUndefined();
    expect('updatePolicy' in adapter).toBe(false);
  });

  it('scores at chance over 2000 episodes with four candidates', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 2_000,
      seed: 'chance-control',
      validation: 'none',
      collectDrafts: false,
    });
    expect(result.successRate).toBeGreaterThanOrEqual(0.22);
    expect(result.successRate).toBeLessThanOrEqual(0.28);
  });

  it('never changes its policy hash across a whole run', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 200,
      seed: 'chance-control',
      validation: 'none',
      collectDrafts: false,
    });
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(new Set(result.policyHashes[role]).size).toBe(1);
    }
  });

  it('emits symbols uniformly over the inventory', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 1_200,
      seed: 'uniform-emission',
      symbolInventorySize: 4,
      validation: 'none',
    });
    const counts = new Map<string, number>();
    for (const role of ['baby-a', 'baby-b'] as const) {
      for (const draft of result.ledgers[role].draftsOf('intention.recorded')) {
        if (!draft.subjectId.startsWith('symbol:')) {
          continue;
        }
        for (const symbol of draft.content.symbols as string[]) {
          counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
        }
      }
    }
    expect(counts.size).toBe(4);
    for (const count of counts.values()) {
      // 1200 draws over 4 symbols: expectation 300, sd ~15.
      expect(count).toBeGreaterThan(240);
      expect(count).toBeLessThan(360);
    }
  });

  it('exports a seed hash and never the raw seed', async () => {
    const { adapter } = await initAdapter('private-seed-material');
    const policy = adapter.exportPolicy();
    expect(policy).toEqual({
      kind: 'uniform-random',
      seedHash: domainHash(HASH_DOMAINS.seed, 'private-seed-material'),
      symbolInventorySize: 8,
      messageLength: 1,
      attributeCount: 2,
      valuesPerAttribute: 4,
    });
    expect(JSON.stringify(policy)).not.toContain('private-seed-material');
  });

  it('replays identically from the same seed and differs across seeds', async () => {
    const first = await runLearnerAdapterConformance(factory(), {
      episodes: 30,
      seed: 'replay',
    });
    const second = await runLearnerAdapterConformance(factory(), {
      episodes: 30,
      seed: 'replay',
    });
    const other = await runLearnerAdapterConformance(factory(), {
      episodes: 30,
      seed: 'replay-other',
    });
    const drafts = (result: typeof first) =>
      JSON.stringify(result.ledgers['baby-a'].drafts);
    expect(drafts(first)).toBe(drafts(second));
    expect(drafts(first)).not.toBe(drafts(other));
  });

  it('records the first emission and first receipt of each symbol exactly once', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 400,
      seed: 'first-use',
      symbolInventorySize: 4,
    });
    for (const role of ['baby-a', 'baby-b'] as const) {
      const ledger = result.ledgers[role];
      expect(ledger.countOf('term.first_emitted')).toBe(4);
      expect(ledger.countOf('term.first_received')).toBe(4);
      const subjects = ledger
        .draftsOf('term.first_emitted')
        .map((draft) => draft.subjectId);
      expect(new Set(subjects).size).toBe(4);
      for (const draft of ledger.draftsOf('term.first_emitted')) {
        expect(draft.content.termRef).toBe(draft.subjectId);
        expect(draft.contentSchema).toBe('agent-native-ledger');
      }
    }
  });

  it('writes an intention draft whose artifactRef addresses its own proposal', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 4,
      seed: 'artifact-ref',
    });
    const senderDraft = result.ledgers['baby-a']
      .draftsOf('intention.recorded')
      .find((draft) => draft.subjectId.startsWith('symbol:'));
    expect(senderDraft).toBeDefined();
    const symbols = senderDraft?.content.symbols as string[];
    expect(senderDraft?.content.artifactRef).toBe(
      `proposal:${hashCanonical(HASH_DOMAINS.babyProposal, {
        kind: 'emit_symbols',
        publicArtifact: { symbols },
      })}`,
    );
    expect(senderDraft?.content.policy).toBe('uniform-random');
    expect(typeof senderDraft?.content.targetTypeCode).toBe('number');
  });

  it('reports a uniform inferred type distribution when receiving', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 4,
      seed: 'uniform-interpretation',
    });
    const draft = result.ledgers['baby-b'].draftsOf('interpretation.recorded')[0];
    const distribution = draft?.content.inferredTypeDistribution as number[];
    expect(distribution).toHaveLength(16);
    expect(new Set(distribution)).toEqual(new Set([0.0625]));
    expect(draft?.evidenceRefs?.[0]).toMatch(/^channel:sha256:[a-f0-9]{64}$/u);
  });

  it('emits 24 hex characters of blinding nonce per event, all distinct', async () => {
    const result = await runLearnerAdapterConformance(factory(), {
      episodes: 60,
      seed: 'nonces',
    });
    const nonces = result.ledgers['baby-a'].drafts.map(
      (draft) => draft.blindingNonce,
    );
    expect(nonces.length).toBeGreaterThan(60);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[0-9a-f]{24}$/u);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('refuses to act before init or observe, and without candidate refs', async () => {
    const bare = new NoLearningAdapter();
    await expect(
      bare.act({
        turn: 1,
        role: 'sender',
        responseBudgetMs: 1_000,
        availableActions: ['emit_symbols'],
      }),
    ).rejects.toThrow(LearnerStateError);

    const { adapter } = await initAdapter();
    await expect(
      adapter.act({
        turn: 1,
        role: 'sender',
        responseBudgetMs: 1_000,
        availableActions: ['emit_symbols'],
      }),
    ).rejects.toThrow(LearnerStateError);
    await expect(
      adapter.act({
        turn: 1,
        role: 'receiver',
        responseBudgetMs: 1_000,
        availableActions: ['select_object'],
      }),
    ).rejects.toThrow(LearnerStateError);
  });

  it('refuses an action the turn budget does not offer (tool-only, SPEC §6.3)', async () => {
    const { adapter } = await initAdapter();
    await adapter.observe({
      runId: 'run-conformance',
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: [
        [0, 0, 1],
        [1, 1, 0],
      ],
      scenarioRef: 'scenario:x',
    });
    await expect(
      adapter.act({
        turn: 1,
        role: 'sender',
        responseBudgetMs: 1_000,
        availableActions: ['select_object'],
      }),
    ).rejects.toThrow(LearnerStateError);
  });

  it('counts outcomes privately without writing them to the ledger', async () => {
    const { adapter, ledger } = await initAdapter();
    const before = ledger.drafts.length;
    await adapter.onOutcome({
      runId: 'run-conformance',
      turn: 1,
      role: 'receiver',
      success: true,
      reward: 1,
      payload: [1],
    });
    await adapter.onOutcome({
      runId: 'run-conformance',
      turn: 2,
      role: 'sender',
      success: false,
      reward: 0,
      payload: [0],
    });
    expect(adapter.outcomeCounters).toEqual({ outcomes: 2, successes: 1 });
    expect(ledger.drafts.length).toBe(before);
  });
});
