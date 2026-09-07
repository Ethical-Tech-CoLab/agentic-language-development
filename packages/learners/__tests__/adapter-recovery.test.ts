/**
 * Mid-run re-initialization of a learner adapter (SPEC §7.3 crash recovery),
 * and the SPEC §14.5 retry of a failed adapter call.
 *
 * `NurseryRuntime.recover()` re-initializes the *same* run's adapter — same
 * private seed, same `runId`, same Baby ledger chain — from the last exported
 * policy checkpoint, and then keeps appending to that chain. Two properties
 * have to survive that:
 *
 * - blinding nonces stay unique within the chain (LEDGER §12), which rules out
 *   any nonce drawn from a stream position that `init()` resets;
 * - the episodic registries survive, so no term gets a second `term.first_*`
 *   event (CONCEPT-IDEA.md §11.2 rule 1) and no `hyp:<symbol>:<n>` reference
 *   is issued twice for two different hypotheses (rule 3, LEDGER §5).
 *
 * A derived run (SPEC §7.4) loads the same checkpoint against a *fresh* chain
 * under a new `runId` and must do the opposite: record its own first uses.
 */
import {
  HASH_DOMAINS,
  fixedTokenInventory,
  type LedgerEvent,
  type LedgerEventDraft,
  type PrivateLedgerClient,
  type RunConfig,
  type Sha256Hash,
} from '@ald/types';
import { domainHash, hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { NoLearningAdapter } from '../src/no-learning.js';
import { TabularReinforceAdapter } from '../src/tabular-reinforce.js';
import {
  parseExportedTabularPolicy,
  type ExportedEpisodicRegistries,
} from '../src/policy.js';

const OPTIONS = { learningRate: 1, temperature: 0.5 } as const;
const INVENTORY_SIZE = 6;
const CANDIDATE_REFS = ['object:a', 'object:b', 'object:c', 'object:d'];

const inventory = fixedTokenInventory(INVENTORY_SIZE);

function channelHashFor(turn: number): Sha256Hash {
  return domainHash(HASH_DOMAINS.channelEvent, `turn-${String(turn)}`);
}

/** The symbol the partner is taken to have sent on `turn`. */
function deliveredSymbol(turn: number): string {
  return inventory[turn % INVENTORY_SIZE] as string;
}

async function initAdapter(
  ledger: PrivateLedgerClient,
  config: RunConfig,
  initialPolicy?: unknown,
): Promise<TabularReinforceAdapter> {
  const adapter = new TabularReinforceAdapter(OPTIONS);
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('scratch-rl'),
    seed: 'private-seed-baby-a',
    symbolInventory: inventory,
    ledger,
    ...(initialPolicy === undefined ? {} : { initialPolicy }),
  });
  return adapter;
}

/**
 * One turn of the referential game against a single adapter: odd turns are
 * sender turns, even turns receiver turns, so both tables move and hypotheses
 * are revised rather than only created.
 */
async function playTurn(
  adapter: TabularReinforceAdapter,
  ledger: RecordingLedgerClient,
  config: RunConfig,
  turn: number,
  options: { update?: boolean } = {},
): Promise<void> {
  const sender = turn % 2 === 1;
  ledger.turn = turn;
  await adapter.observe({
    runId: config.runId,
    turn,
    recipient: 'baby-a',
    encoding: 'opaque-numeric',
    payload: sender
      ? [
          [turn % 4, (turn + 1) % 4, 1],
          [(turn + 2) % 4, (turn + 3) % 4, 0],
        ]
      : [
          [turn % 4, 0],
          [(turn + 1) % 4, 1],
          [(turn + 2) % 4, 2],
          [(turn + 3) % 4, 3],
        ],
    scenarioRef: `scenario:${String(turn)}`,
  });

  if (sender) {
    const envelope = await adapter.act({
      turn,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    await ledger.append(envelope.privateLedgerDraft);
  }

  const channelEventHash = channelHashFor(turn);
  const interpretation = await adapter.receive({
    runId: config.runId,
    turn,
    logicalSender: 'baby-b',
    carrier: 'fixed-token',
    publicArtifact: { symbols: [deliveredSymbol(turn)] },
    channelEventHash,
  });
  await ledger.append(interpretation.privateLedgerDraft, { channelEventHash });

  if (!sender) {
    const envelope = await adapter.act({
      turn,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    await ledger.append(envelope.privateLedgerDraft);
  }

  await adapter.onOutcome({
    runId: config.runId,
    turn,
    role: sender ? 'sender' : 'receiver',
    success: turn % 3 !== 0,
    reward: turn % 3 !== 0 ? 1 : 0,
    payload: [turn % 3 !== 0 ? 1 : 0],
  });

  if (options.update ?? true) {
    await adapter.updatePolicy({
      runId: config.runId,
      turns: [turn],
      learningSignal: 'extrinsic-task',
    });
  }
}

async function playTurns(
  adapter: TabularReinforceAdapter,
  ledger: RecordingLedgerClient,
  config: RunConfig,
  turns: readonly number[],
  options: { update?: boolean } = {},
): Promise<void> {
  for (const turn of turns) {
    await playTurn(adapter, ledger, config, turn, options);
  }
}

function contentString(draft: LedgerEventDraft, field: string): string {
  const value = draft.content[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Run turns 1..8, export the checkpoint, re-initialize a fresh adapter from it
 * against the same chain, and run turns 9..16 — the shape of a restart
 * recovery, with the drafts of both halves collected in one ledger.
 */
async function runWithRestart(): Promise<{
  ledger: RecordingLedgerClient;
  policy: unknown;
  beforeRestart: number;
}> {
  const config = buildConformanceRunConfig('scratch-rl', {
    episodes: 16,
    symbolInventorySize: INVENTORY_SIZE,
  });
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');

  const first = await initAdapter(ledger, config);
  await playTurns(first, ledger, config, [1, 2, 3, 4, 5, 6, 7, 8]);
  const policy = first.exportPolicy();
  const beforeRestart = ledger.drafts.length;

  const second = await initAdapter(ledger, config, policy);
  await playTurns(second, ledger, config, [9, 10, 11, 12, 13, 14, 15, 16]);

  return { ledger, policy, beforeRestart };
}

describe('re-initialization inside a run (SPEC §7.3)', () => {
  it('never reuses a blinding nonce across the restart (LEDGER §12)', async () => {
    const { ledger, beforeRestart } = await runWithRestart();
    const nonces = ledger.drafts.map((draft) => draft.blindingNonce);

    expect(beforeRestart).toBeGreaterThan(0);
    expect(nonces.length).toBeGreaterThan(beforeRestart);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[0-9a-f]{24}$/u);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('re-emits no term.first_* event for a term already recorded', async () => {
    const { ledger } = await runWithRestart();

    for (const eventType of ['term.first_emitted', 'term.first_received'] as const) {
      const terms = ledger
        .draftsOf(eventType)
        .map((draft) => contentString(draft, 'termRef'));
      expect(terms.length).toBeGreaterThan(0);
      expect(new Set(terms).size).toBe(terms.length);
    }
    // The restart really did cross terms it had already seen: the delivered
    // symbols cycle through the whole inventory twice.
    expect(ledger.countOf('term.first_received')).toBe(INVENTORY_SIZE);
  });

  it('never issues one hypothesis reference for two hypotheses', async () => {
    const { ledger } = await runWithRestart();

    const issued = new Set<string>();
    for (const eventType of ['hypothesis.created', 'hypothesis.revised'] as const) {
      for (const draft of ledger.draftsOf(eventType)) {
        const ref = contentString(draft, 'hypothesisRef');
        expect(issued.has(ref)).toBe(false);
        issued.add(ref);
      }
    }
    expect(issued.size).toBeGreaterThan(0);

    // LEDGER §5: every revision names a prior hypothesis that exists.
    const revisions = ledger.draftsOf('hypothesis.revised');
    expect(revisions.length).toBeGreaterThan(0);
    for (const draft of revisions) {
      expect(issued.has(contentString(draft, 'priorHypothesisRef'))).toBe(true);
    }
  });

  it('carries the episodic registries in the exported checkpoint', async () => {
    const { policy } = await runWithRestart();
    const parsed = parseExportedTabularPolicy(policy);
    const registries = parsed.registries as ExportedEpisodicRegistries;

    expect(parsed.version).toBe(2);
    expect(registries.babyId).toBe('A');
    expect(registries.emitted.length).toBeGreaterThan(0);
    expect(registries.received.length).toBeGreaterThan(0);
    expect(registries.hypotheses.length).toBeGreaterThan(0);
    // Canonical order, so the checkpoint hash does not depend on discovery
    // order (SPEC §14.3).
    expect(registries.received).toEqual([...registries.received].sort());
  });

  it('starts a derived run (SPEC §7.4) with empty registries', async () => {
    const { policy } = await runWithRestart();
    const derivedConfig = buildConformanceRunConfig('scratch-rl', {
      episodes: 4,
      symbolInventorySize: INVENTORY_SIZE,
      runId: 'run-derived',
    });
    const ledger = new RecordingLedgerClient(derivedConfig.runId, 'baby-a');
    const derived = await initAdapter(ledger, derivedConfig, policy);
    await playTurns(derived, ledger, derivedConfig, [1, 2]);

    // A fresh chain has no first-use event for any term yet, so the derived
    // run records its own.
    expect(ledger.countOf('term.first_emitted')).toBeGreaterThan(0);
    expect(ledger.countOf('term.first_received')).toBeGreaterThan(0);
    const registries = parseExportedTabularPolicy(derived.exportPolicy())
      .registries as ExportedEpisodicRegistries;
    expect(registries.runId).toBe('run-derived');
  });

  it('holds the checkpoint hash constant while no policy update runs', async () => {
    const config = buildConformanceRunConfig('scratch-rl', {
      episodes: 8,
      symbolInventorySize: INVENTORY_SIZE,
    });
    const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
    const adapter = await initAdapter(ledger, config);
    const before = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      adapter.exportPolicy(),
    );

    // SPEC §7.2: `updatePolicy` is disabled once evaluation starts. New terms
    // are still first used in that phase, and that must not move the policy
    // hash the E11 harness checks for constancy.
    await playTurns(adapter, ledger, config, [1, 2, 3, 4], { update: false });

    expect(ledger.countOf('term.first_received')).toBeGreaterThan(0);
    expect(
      hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy()),
    ).toBe(before);
  });
});

/**
 * A ledger whose first append of one event type fails, standing in for the
 * transient Ledger-Writer fault SPEC §14.5 bullet 4 retries an adapter call
 * for. Everything else passes through to a recording client.
 */
class FailOnceLedgerClient implements PrivateLedgerClient {
  private failed = false;

  constructor(
    readonly inner: RecordingLedgerClient,
    private readonly eventType: string,
  ) {}

  async append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent> {
    if (!this.failed && draft.eventType === this.eventType) {
      this.failed = true;
      throw new Error(`ledger unavailable for ${draft.eventType}`);
    }
    return this.inner.append(draft, options);
  }
}

describe('retried adapter calls (SPEC §14.5)', () => {
  it('re-emits hypothesis.created when the first append failed', async () => {
    const config = buildConformanceRunConfig('scratch-rl', {
      episodes: 4,
      symbolInventorySize: INVENTORY_SIZE,
    });
    const recording = new RecordingLedgerClient(config.runId, 'baby-a');
    const ledger = new FailOnceLedgerClient(recording, 'hypothesis.created');
    const adapter = await initAdapter(ledger, config);

    recording.turn = 1;
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: [
        [0, 0, 1],
        [1, 1, 0],
      ],
      scenarioRef: 'scenario:1',
    });
    const envelope = await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    await recording.append(envelope.privateLedgerDraft);

    const outcome = {
      runId: config.runId,
      turn: 1,
      role: 'sender' as const,
      success: true,
      reward: 1,
      payload: [1],
    };
    await expect(adapter.onOutcome(outcome)).rejects.toThrow(
      'ledger unavailable',
    );
    expect(recording.countOf('hypothesis.created')).toBe(0);

    // The runtime's retry of the same call must produce the event the failed
    // attempt lost, exactly once.
    await adapter.onOutcome(outcome);
    expect(recording.countOf('hypothesis.created')).toBe(1);
    const created = recording.draftsOf('hypothesis.created')[0] as LedgerEventDraft;
    const symbol = created.subjectId.replace('symbol:', '');
    expect(contentString(created, 'hypothesisRef')).toBe(`hyp:${symbol}:1`);

    // And the reference the map now holds is the one that was written, so a
    // later revision resolves against it (LEDGER §5).
    await adapter.updatePolicy({
      runId: config.runId,
      turns: [1],
      learningSignal: 'extrinsic-task',
    });
    const registries = parseExportedTabularPolicy(adapter.exportPolicy())
      .registries as ExportedEpisodicRegistries;
    expect(registries.hypotheses).toContainEqual({
      symbol,
      version: 1,
      hypothesisRef: `hyp:${symbol}:1`,
      argmaxTypeCode: expect.any(Number) as number,
    });
  });

  it('re-emits term.first_received when the first append failed', async () => {
    const config = buildConformanceRunConfig('scratch-rl', {
      episodes: 4,
      symbolInventorySize: INVENTORY_SIZE,
    });
    const recording = new RecordingLedgerClient(config.runId, 'baby-a');
    const ledger = new FailOnceLedgerClient(recording, 'term.first_received');
    const adapter = await initAdapter(ledger, config);

    recording.turn = 1;
    const delivery = {
      runId: config.runId,
      turn: 1,
      logicalSender: 'baby-b' as const,
      carrier: 'fixed-token' as const,
      publicArtifact: { symbols: [deliveredSymbol(1)] },
      channelEventHash: channelHashFor(1),
    };
    await expect(adapter.receive(delivery)).rejects.toThrow('ledger unavailable');
    expect(recording.countOf('term.first_received')).toBe(0);

    // The retry delivers the same artifact, so the first use of that term is
    // recorded exactly once and is not swallowed by the failed attempt.
    const envelope = await adapter.receive(delivery);
    expect(recording.countOf('term.first_received')).toBe(1);
    expect(
      contentString(
        recording.draftsOf('term.first_received')[0] as LedgerEventDraft,
        'termRef',
      ),
    ).toBe(`symbol:${deliveredSymbol(1)}`);
    expect(envelope.privateLedgerDraft.eventType).toBe('interpretation.recorded');
  });
});

/**
 * The `no-learning` control shares the nonce derivation, so its chain keeps
 * unique nonces across a restart too. It exports no learned state, so it has
 * no checkpoint to restore registries from — see `NoLearningAdapter.emitted`.
 */
describe('no-learning re-initialization (SPEC §7.3)', () => {
  it('never reuses a blinding nonce across the restart', async () => {
    const config = buildConformanceRunConfig('no-learning', {
      episodes: 8,
      symbolInventorySize: INVENTORY_SIZE,
    });
    const ledger = new RecordingLedgerClient(config.runId, 'baby-a');

    const play = async (
      adapter: NoLearningAdapter,
      turns: readonly number[],
    ): Promise<void> => {
      for (const turn of turns) {
        ledger.turn = turn;
        await adapter.observe({
          runId: config.runId,
          turn,
          recipient: 'baby-a',
          encoding: 'opaque-numeric',
          payload: [
            [turn % 4, (turn + 1) % 4, 1],
            [(turn + 2) % 4, (turn + 3) % 4, 0],
          ],
          scenarioRef: `scenario:${String(turn)}`,
        });
        const envelope = await adapter.act({
          turn,
          role: 'sender',
          responseBudgetMs: 1_000,
          availableActions: ['emit_symbols'],
        });
        await ledger.append(envelope.privateLedgerDraft);
        const channelEventHash = channelHashFor(turn);
        const interpretation = await adapter.receive({
          runId: config.runId,
          turn,
          logicalSender: 'baby-b',
          carrier: 'fixed-token',
          publicArtifact: { symbols: [deliveredSymbol(turn)] },
          channelEventHash,
        });
        await ledger.append(interpretation.privateLedgerDraft, {
          channelEventHash,
        });
      }
    };

    const initNoLearning = async (): Promise<NoLearningAdapter> => {
      const adapter = new NoLearningAdapter();
      await adapter.init({
        runId: config.runId,
        role: 'baby-a',
        babyId: 'A',
        config,
        learnerContract: loadLearnerContract('no-learning'),
        seed: 'private-seed-baby-a',
        symbolInventory: inventory,
        ledger,
      });
      return adapter;
    };

    await play(await initNoLearning(), [1, 2, 3, 4]);
    await play(await initNoLearning(), [5, 6, 7, 8]);

    const nonces = ledger.drafts.map((draft) => draft.blindingNonce);
    expect(nonces.length).toBeGreaterThan(8);
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});
