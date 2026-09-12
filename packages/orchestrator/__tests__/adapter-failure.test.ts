/**
 * SPEC §14.5 adapter failure handling, the §7.2 `sealing-blocked` recovery
 * rows, the §9.6 `disabled` control under a learning track, and the LEDGER §9
 * event-interval checkpoint boundary.
 *
 * ALD-025 criterion 2 ("a turn exceeding its budget is terminated and
 * recorded, not left hanging") is asserted here for the adapter-crash case:
 * the turn is forfeited, audited, recorded, and the run pauses — it never
 * escapes `step()` as an exception, and it never leaves a turn without a
 * record. ALD-026 covers the pause paths: the automatic pause, the
 * `pause-not-available` fallback in `evaluating`, and the operator resume.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HASH_DOMAINS, type AnchorPublisher, type LearnerAdapter } from '@ald/types';
import { createLearnerAdapterFactory } from '@ald/learners';
import { hashCanonical, hashCarrierMark } from '@ald/hashing';
import type {
  DeliveredChannelArtifact,
  LearnerAdapterFactory,
  LearnerInitContext,
  LedgerDraftEnvelope,
  Observation,
  OutcomeEvent,
  PolicyCheckpointRef,
  TurnBudget,
  TurnProposalEnvelope,
  UpdateBatch,
} from '@ald/types';

import {
  ADAPTER_FAILURE_MESSAGE_LIMIT,
  adapterFailureMessage,
} from '../src/errors.js';
import {
  SAFETY_ESCALATION_REASON,
  createNurseryRuntime,
  simpleCheckpointFactory,
} from '../src/index.js';
import {
  FakeAnchorPublisher,
  SOFTWARE_COMMIT,
  createHarness,
  fakeVerifier,
  noLearningOverrides,
  successRate,
  testConfig,
  type Harness,
} from './helpers.js';

const OPERATOR = {
  actorId: 'researcher:test-operator',
  reasonCode: 'crash-reviewed',
};

const CRASH_MESSAGE = 'synthetic adapter crash';

/**
 * A Baby whose `act()` throws on the call indexes it is given, counting from
 * one. Everything else is delegated to a real `no-learning` adapter, so the
 * turns that do not crash are ordinary turns.
 */
class FlakyAdapter implements LearnerAdapter {
  readonly track: LearnerAdapter['track'];

  actCalls = 0;

  outcomeCalls = 0;

  updatePolicy?: (batch: UpdateBatch) => Promise<PolicyCheckpointRef>;

  constructor(
    private readonly inner: LearnerAdapter,
    private readonly failOn: ReadonlySet<number>,
    private readonly failOutcomeOn: ReadonlySet<number> = new Set(),
  ) {
    this.track = inner.track;
    const update = inner.updatePolicy;
    if (update) {
      this.updatePolicy = (batch) => update.call(inner, batch);
    }
  }

  init(context: LearnerInitContext): Promise<void> {
    return this.inner.init(context);
  }

  observe(observation: Observation): Promise<void> {
    return this.inner.observe(observation);
  }

  async act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    this.actCalls += 1;
    if (this.failOn.has(this.actCalls)) {
      throw new Error(`${CRASH_MESSAGE} on act call ${String(this.actCalls)}`);
    }
    return this.inner.act(turnBudget);
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return this.inner.receive(delivery);
  }

  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    this.outcomeCalls += 1;
    if (this.failOutcomeOn.has(this.outcomeCalls)) {
      throw new Error(
        `${CRASH_MESSAGE} on onOutcome call ${String(this.outcomeCalls)}`,
      );
    }
    return this.inner.onOutcome(outcome);
  }

  exportPolicy(): unknown {
    return this.inner.exportPolicy();
  }
}

function flakyFactory(
  failOn: readonly number[],
  failOutcomeOn: readonly number[] = [],
): LearnerAdapterFactory {
  const acts = new Set(failOn);
  const outcomes = new Set(failOutcomeOn);
  return {
    track: 'no-learning',
    create: () =>
      new FlakyAdapter(
        createLearnerAdapterFactory('no-learning').create(),
        acts,
        outcomes,
      ),
  };
}

/** A publisher whose first `failures` submissions fail, then succeed. */
function flakyPublisher(runId: string, failures: number): AnchorPublisher {
  const inner = new FakeAnchorPublisher();
  let attempts = 0;
  return {
    anchorClass: inner.anchorClass,
    network: inner.network,
    submit: async (manifest) => {
      attempts += 1;
      if (attempts <= failures) {
        throw new Error('rpc endpoint unavailable');
      }
      return { ...(await inner.submit(manifest)), runId };
    },
    awaitConfirmation: (receipt) => inner.awaitConfirmation(receipt),
  };
}

function adapterFailures(harness: Harness, runId: string) {
  return harness.runtime
    .auditLog(runId)
    .filter(
      (event) =>
        event.eventType === 'safety-trigger' &&
        event.reasonCode === 'adapter-failure',
    );
}

describe('adapter failure policy (SPEC §14.5, ALD-025, ALD-026)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('retries once, forfeits and pauses on the second failure, and resumes', async () => {
    // Baby A crashes on its first two `act()` calls — the initial call of turn
    // 0 and its one retry — and once more on its fifth call, which the retry
    // recovers from.
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        role === 'baby-a'
          ? flakyFactory([1, 2, 5])
          : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-adapter-crash';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-adapter-crash',
          maxTurnsPerRun: 20,
          evaluationTurns: 2,
        }),
      ),
    );

    // Turn 0: both attempts fail, so the turn is forfeited, not thrown out of.
    const failed = await harness.runtime.step(runId);
    expect(failed.turn).toBe(0);
    expect(failed.outcome.success).toBe(false);
    expect(failed.outcome.reward).toBe(0);
    expect(failed.outcome.details).toMatchObject({
      reason: 'adapter-failure',
      role: 'baby-a',
      phase: 'running',
    });
    // A crash is not a channel violation: no channel event was committed.
    expect(failed.channelEvent).toBeNull();
    expect(failed.state).toBe('paused');

    // The turn is recorded, with a null action (§14.3 replay tuple).
    const afterFailure = harness.runtime.turnRecords(runId);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]?.turn).toBe(0);
    expect(afterFailure[0]?.babyProposalHash).toBeNull();
    expect(afterFailure[0]?.channelEventHash).toBeNull();
    expect(afterFailure[0]?.actionHash).toBe(
      hashCanonical(HASH_DOMAINS.action, null),
    );
    expect(afterFailure[0]?.deliveredArtifactHash).toBe(
      hashCarrierMark('fixed-token', null),
    );

    // §14.5: one `safety-trigger` entry with a machine-readable reason code.
    const triggers = adapterFailures(harness, runId);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.details).toMatchObject({
      turn: 0,
      phase: 'running',
      role: 'baby-a',
      method: 'act',
      attempts: 2,
      errorName: 'Error',
    });
    expect(String(triggers[0]?.details?.message)).toContain(CRASH_MESSAGE);
    // §7.2: a pause produces a checkpoint. No `channel.rejected` event exists.
    expect(
      harness.runtime
        .checkpoints(runId)
        .filter((manifest) => manifest.reason === 'pause'),
    ).toHaveLength(1);
    expect(harness.runtime.transcript(runId)).toHaveLength(0);

    // §7.3: the pause prevents a new turn from starting until an operator
    // reviews it.
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );
    const resumed = await harness.runtime.resume(runId, OPERATOR);
    expect(resumed.state).toBe('running');

    // Turns 1-3 run; act call 5 crashes once and the retry recovers it, so
    // that turn is an ordinary accepted turn.
    for (let turn = 1; turn <= 3; turn += 1) {
      const result = await harness.runtime.step(runId);
      expect(result.turn, `turn ${String(turn)}`).toBe(turn);
      expect(result.state, `turn ${String(turn)}`).toBe('running');
      expect(result.outcome.details, `turn ${String(turn)}`).not.toMatchObject({
        reason: 'adapter-failure',
      });
    }

    // Six `act()` calls for four turns: turn 0's call plus its retry, three
    // good calls, and the crashed fifth call plus the retry that recovered it.
    // Without the retry the fifth call would have forfeited a second turn.
    const flaky = harness.runtime.adaptersFor(runId)['baby-a'] as FlakyAdapter;
    expect(flaky.actCalls).toBe(6);

    // The recovered call produced no new safety trigger and no second pause.
    expect(adapterFailures(harness, runId)).toHaveLength(1);
    expect(
      harness.runtime
        .checkpoints(runId)
        .filter((manifest) => manifest.reason === 'pause'),
    ).toHaveLength(1);

    // Exactly one turn record per turn on every exit path.
    const records = harness.runtime.turnRecords(runId);
    expect(records.map((record) => record.turn)).toEqual([0, 1, 2, 3]);
    expect(
      records.slice(1).every((record) => record.babyProposalHash !== null),
    ).toBe(true);
    // Turns 1-3 delivered normally, so the transcript caught up.
    expect(harness.runtime.transcript(runId)).toHaveLength(3);
  }, 60_000);

  it('forfeits a turn whose adapter crashes after the atomic commit', async () => {
    // §8.1 step 7 runs after the sender's ledger/channel commit, so a crash
    // there must keep the committed evidence and still forfeit the turn.
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        role === 'baby-a'
          ? flakyFactory([], [1, 2])
          : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-adapter-crash-outcome';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-adapter-crash-outcome',
          maxTurnsPerRun: 20,
          evaluationTurns: 2,
        }),
      ),
    );
    const result = await harness.runtime.step(runId);

    expect(result.state).toBe('paused');
    expect(result.outcome.details).toMatchObject({
      reason: 'adapter-failure',
      role: 'baby-a',
    });
    const triggers = adapterFailures(harness, runId);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.details).toMatchObject({
      method: 'onOutcome',
      attempts: 2,
    });

    // §8.2: the committed transaction is never rolled back by a later crash;
    // the record keeps the delivered artifact and a null action.
    const records = harness.runtime.turnRecords(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.babyProposalHash).not.toBeNull();
    expect(records[0]?.channelEventHash).toBe(result.channelEvent?.entryHash);
    expect(records[0]?.actionHash).toBe(
      hashCanonical(HASH_DOMAINS.action, null),
    );
    expect(harness.runtime.transcript(runId)).toHaveLength(1);
  }, 60_000);

  it('escalates to the §7.2 abort row when the crash lands in evaluating', async () => {
    // Turn 0 is the only training turn; act calls 2 and 3 are the initial call
    // and the retry of the first evaluation turn, where §7.2 has no `pause`.
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        role === 'baby-a'
          ? flakyFactory([2, 3])
          : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-adapter-crash-evaluating';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-adapter-crash-eval',
          maxTurnsPerRun: 1,
          evaluationTurns: 4,
        }),
      ),
    );
    const summary = await harness.runtime.runToCompletion(runId);

    const triggers = adapterFailures(harness, runId);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.details).toMatchObject({ phase: 'evaluating' });
    const blocked = harness.runtime
      .auditLog(runId)
      .filter(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === 'pause-not-available',
      );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.details).toMatchObject({
      state: 'evaluating',
      trigger: 'adapter-failure',
    });

    // §7.2 offers `evaluating --abort--> aborting`, and §14.5 forbids a
    // trigger that neither pauses nor stops: the run ends instead of drawing
    // held-out episodes with a live trigger.
    const escalation = harness.runtime
      .auditLog(runId)
      .filter(
        (event) =>
          event.eventType === 'abort' &&
          event.reasonCode === SAFETY_ESCALATION_REASON,
      );
    expect(escalation).toHaveLength(1);

    // The crashed turn is still recorded like any other, and nothing ran
    // after it.
    const records = harness.runtime.turnRecords(runId);
    expect(records).toHaveLength(2);
    const forfeited = records.filter(
      (record) => record.outcome.details?.['reason'] === 'adapter-failure',
    );
    expect(forfeited).toHaveLength(1);
    expect(summary.state).toBe('aborted-sealed');
    expect(harness.runtime.experimentRecords(runId).at(-1)?.disposition).toBe(
      'aborted',
    );
  }, 60_000);

  it('honours a retryBudget of zero and rejects an invalid one', async () => {
    harness = await createHarness({
      retryBudget: 0,
      adapterFactoryFor: (_config, role) =>
        role === 'baby-a'
          ? flakyFactory([1])
          : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-adapter-no-retry';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-adapter-no-retry',
          maxTurnsPerRun: 20,
          evaluationTurns: 2,
        }),
      ),
    );
    const result = await harness.runtime.step(runId);
    expect(result.state).toBe('paused');
    expect(adapterFailures(harness, runId)[0]?.details).toMatchObject({
      attempts: 1,
    });
    const flaky = harness.runtime.adaptersFor(runId)['baby-a'] as FlakyAdapter;
    expect(flaky.actCalls).toBe(1);

    // §14.5 names a retry budget, never an unbounded or negative one.
    const database = harness.database;
    const bundleRoot = harness.root;
    expect(() =>
      createNurseryRuntime({
        database,
        bundleRoot,
        softwareCommit: SOFTWARE_COMMIT,
        checkpointFactory: simpleCheckpointFactory(),
        retryBudget: -1,
      }),
    ).toThrow(/retryBudget/u);
  }, 60_000);

  it('truncates an adapter message and never records a payload', () => {
    const long = 'x'.repeat(ADAPTER_FAILURE_MESSAGE_LIMIT + 50);
    const message = adapterFailureMessage(new Error(`${long}\nsecond line`));
    expect(message.length).toBe(ADAPTER_FAILURE_MESSAGE_LIMIT + 1);
    expect(message).not.toContain('second line');
    expect(adapterFailureMessage(new Error('short'))).toBe('short');
    expect(adapterFailureMessage('raw string')).toBe('raw string');
    expect(adapterFailureMessage({ payload: 'secret' })).toBe('');
  });
});

describe('sealing-blocked recovery (SPEC §7.2)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  function sealedEventCount(harness: Harness, runId: string): number[] {
    const ledgers = harness.runtime.ledgers(runId);
    return [ledgers.babyA, ledgers.babyB].map(
      (ledger) =>
        ledger.filter((event) => event.eventType === 'run.sealed').length,
    );
  }

  it('retries a blocked seal without a second run.sealed or final checkpoint', async () => {
    const runId = 'run-seal-retry';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: flakyPublisher(runId, 1),
      verifier: fakeVerifier(runId),
    });
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-seal-retry',
          maxTurnsPerRun: 1,
          evaluationTurns: 2,
        }),
      ),
    );
    const blocked = await harness.runtime.runToCompletion(runId);
    expect(blocked.state).toBe('sealing-blocked');
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);
    const checkpointsBefore = harness.runtime.checkpoints(runId).length;

    const retried = await harness.runtime.retrySeal(runId);
    expect(retried.state).toBe('sealed');

    // §7.2: "Resume only export/anchor/verification work" — the seal evidence
    // is not written twice.
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);
    const checkpoints = harness.runtime.checkpoints(runId);
    expect(
      checkpoints.filter((manifest) => manifest.reason === 'run-sealed'),
    ).toHaveLength(1);
    expect(checkpoints).toHaveLength(checkpointsBefore);
    expect(checkpoints.at(-1)?.reason).toBe('run-sealed');

    const audit = harness.runtime.auditLog(runId);
    expect(
      audit.some(
        (event) =>
          event.eventType === 'recovery' && event.reasonCode === 'seal-retry',
      ),
    ).toBe(true);

    const current = harness.runtime.experimentRecords(runId).at(-1);
    expect(current?.disposition).toBe('valid');
    expect(current?.checkpointManifestRef).toBe(
      checkpoints.at(-1)?.checkpointHash,
    );

    // §7.2 has no transition out of `sealed`, and a re-entered seal is a
    // no-op rather than a second seal.
    const recordsBefore = harness.runtime.experimentRecords(runId).length;
    const again = await harness.runtime.seal(runId);
    expect(again.state).toBe('sealed');
    expect(harness.runtime.experimentRecords(runId)).toHaveLength(
      recordsBefore,
    );
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);
    await expect(harness.runtime.retrySeal(runId)).rejects.toThrow(
      /seal-retry/u,
    );
  }, 60_000);

  it('abandons recovery with an audited governance decision', async () => {
    const runId = 'run-seal-abandoned';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: flakyPublisher(runId, Number.MAX_SAFE_INTEGER),
    });
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-seal-abandoned',
          maxTurnsPerRun: 1,
          evaluationTurns: 2,
        }),
      ),
    );
    expect((await harness.runtime.runToCompletion(runId)).state).toBe(
      'sealing-blocked',
    );
    // A retry that fails again returns to `sealing-blocked`, not to an error.
    expect((await harness.runtime.retrySeal(runId)).state).toBe(
      'sealing-blocked',
    );

    const abandoned = await harness.runtime.abandonSeal(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'anchor-permanently-unavailable',
      details: { note: 'rpc endpoint decommissioned' },
    });
    expect(abandoned.state).toBe('aborted-sealed');

    const decision = harness.runtime
      .auditLog(runId)
      .filter(
        (event) =>
          event.eventType === 'governance-decision' &&
          event.reasonCode === 'anchor-permanently-unavailable',
      );
    expect(decision).toHaveLength(1);
    expect(decision[0]?.actorId).toBe(OPERATOR.actorId);
    expect(decision[0]?.details).toMatchObject({
      note: 'rpc endpoint decommissioned',
      outcome: 'seal-recovery-abandoned',
    });

    const current = harness.runtime.experimentRecords(runId).at(-1);
    expect(current?.disposition).toBe('invalid');
    expect(current?.anchorTxRef).toBe(`0x${'0'.repeat(64)}`);
    expect(current?.deviations.join(' ')).toContain('seal-recovery-abandoned');
    expect(current?.deviations.join(' ')).toContain('anchor-unavailable');
    // The final checkpoint of the bundle is still the blocked seal's.
    expect(
      harness.runtime
        .checkpoints(runId)
        .filter((manifest) => manifest.reason === 'run-sealed'),
    ).toHaveLength(1);
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);

    // §7.1: `aborted-sealed` is terminal.
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );
    await expect(
      harness.runtime.abandonSeal(runId, OPERATOR),
    ).rejects.toThrow(/abandon-recovery/u);
  }, 60_000);
});

describe('event-interval checkpoints (LEDGER §9)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('creates one checkpoint per crossed boundary, even inside one turn', async () => {
    harness = await createHarness();
    const runId = 'run-event-interval';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-event-interval',
          maxTurnsPerRun: 4,
          // One turn commits far more than two events on the mandatory
          // chains, so a single turn crosses several boundaries.
          checkpointEventInterval: 2,
        }),
      ),
    );
    await harness.runtime.step(runId);

    const writer = harness.runtime.writerFor(runId);
    const eventTotal = (['baby-a-ledger', 'baby-b-ledger', 'channel'] as const)
      .map((stream) => writer.chainHead(runId, stream).size)
      .reduce((sum, size) => sum + size, 0);
    expect(eventTotal).toBeGreaterThanOrEqual(4);

    const intervals = harness.runtime
      .checkpoints(runId)
      .filter((manifest) => manifest.reason === 'event-interval');
    // The whole point: the counter advances one interval at a time, so a turn
    // that lands `2 * interval` events does not skip a boundary.
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(intervals.length).toBe(Math.floor(eventTotal / 2));

    // Nothing uncheckpointed is left over beyond one interval.
    const last = intervals.at(-1);
    const committed =
      (last?.babyA.treeSize ?? 0) +
      (last?.babyB.treeSize ?? 0) +
      (last?.channel.treeSize ?? 0);
    expect(eventTotal - committed).toBeLessThan(2);
  }, 60_000);
});

describe('disabled channel with a learning track (SPEC §9.6)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('runs scratch-rl for 60 turns with no delivery and stays near chance', async () => {
    harness = await createHarness({
      learnerOptions: { shared: { learningRate: 1, temperature: 0.5 } },
    });
    const runId = 'run-disabled-scratch-rl';
    const turns = 60;
    await harness.runtime.createRun(
      testConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-disabled-scratch-rl',
        babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
        babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
        learningSignal: 'extrinsic-task',
        communicationCondition: 'disabled',
        // Comfortably above `turns`, so the 60 turns all run in `running`.
        maxTurnsPerRun: turns + 20,
        evaluationTurns: 2,
      }),
    );
    const initialReceiverTables = Object.fromEntries(
      Object.entries(harness.runtime.adaptersFor(runId)).map(([role, adapter]) => [
        role,
        (adapter.exportPolicy() as { thetaReceiver: number[][][] }).thetaReceiver,
      ]),
    );
    for (let turn = 0; turn < turns; turn += 1) {
      const result = await harness.runtime.step(runId);
      expect(result.turn, `turn ${String(turn)}`).toBe(turn);
      expect(result.state, `turn ${String(turn)}`).toBe('running');
    }

    const records = harness.runtime.turnRecords(runId);
    expect(records).toHaveLength(turns);
    // Every turn was accepted: a receiver without a message is not an error.
    expect(
      records.every((record) => record.babyProposalHash !== null),
    ).toBe(true);
    expect(adapterFailures(harness, runId)).toHaveLength(0);
    expect(
      harness.runtime
        .transcript(runId)
        .every(
          (event) =>
            event.gatewayValidationResult === 'accepted' &&
            event.deliveryReceipt === undefined,
        ),
    ).toBe(true);

    const ledgers = harness.runtime.ledgers(runId);
    for (const ledger of [ledgers.babyA, ledgers.babyB]) {
      // §8.2: nothing was delivered, so no interpretation event may exist.
      expect(
        ledger.some((event) => event.eventType === 'interpretation.recorded'),
      ).toBe(false);
      const receiverIntentions = ledger.filter(
        (event) =>
          event.eventType === 'intention.recorded' &&
          event.content['selection'] !== undefined,
      );
      expect(receiverIntentions.length).toBeGreaterThan(0);
      for (const event of receiverIntentions) {
        // The receiver acted on the empty message and said so.
        expect(event.content['symbols']).toEqual([]);
        expect(event.content['associationWeights']).toEqual([
          0.25, 0.25, 0.25, 0.25,
        ]);
      }
    }

    // No symbol row was ever credited, so the receiver tables never moved.
    const adapters = harness.runtime.adaptersFor(runId);
    for (const role of ['baby-a', 'baby-b'] as const) {
      const policy = adapters[role].exportPolicy() as {
        thetaReceiver: number[][][];
      };
      expect(policy.thetaReceiver).toEqual(initialReceiverTables[role]);
    }

    const rate = successRate(
      records.map((record) => ({ success: record.outcome.success === true })),
    );
    expect(rate).toBeLessThanOrEqual(0.6);
  }, 60_000);
});
