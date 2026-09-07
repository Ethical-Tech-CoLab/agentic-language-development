/**
 * SPEC §9.6 `shuffled`: the batch pre-pass acts for a whole batch of slots
 * before the batch's first delivery.
 *
 * Two properties the rest of the turn loop gets for free but the pre-pass has
 * to arrange itself: every private ledger event an adapter appends carries the
 * turn it acted for (§11.4), and a malformed envelope becomes a committed
 * `channel.rejected` event rather than an exception that escapes `step()`
 * without a turn record (§8.3, §9.4, §11.3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DeliveredChannelArtifact,
  LearnerAdapter,
  LearnerAdapterFactory,
  LearnerInitContext,
  LedgerDraftEnvelope,
  Observation,
  OutcomeEvent,
  TurnBudget,
  TurnProposalEnvelope,
} from '@ald/types';

import { senderForTurn } from '../src/index.js';
import {
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

/** A Baby whose sender `act()` forgets to return an envelope (§11.3). */
class ForgetfulSenderAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    if (turnBudget.role === 'sender') {
      return Promise.resolve(undefined as unknown as TurnProposalEnvelope);
    }
    const objectRef = turnBudget.candidateRefs?.[0] ?? 'o:missing';
    return Promise.resolve({
      proposal: { kind: 'select_object', publicArtifact: { objectRef } },
      privateLedgerDraft: {
        eventType: 'intention.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: `candidate:${objectRef}`,
        content: { artifactRef: `proposal:${objectRef}` },
        blindingNonce: `nonce:r${String(turnBudget.turn)}`,
        evidenceRefs: [],
      },
    });
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve({
      channelEventHash: delivery.channelEventHash,
      privateLedgerDraft: {
        eventType: 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:unknown',
        content: { artifactRef: delivery.channelEventHash },
        blindingNonce: `nonce:i${String(delivery.turn)}`,
        evidenceRefs: [`channel:${delivery.channelEventHash}`],
      },
    });
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'forgetful' };
  }
}

const forgetfulFactory: LearnerAdapterFactory = {
  track: 'no-learning',
  create: () => new ForgetfulSenderAdapter(),
};

describe('shuffled pre-pass (SPEC §9.6)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('stamps each pre-pass ledger event with its own slot turn', async () => {
    harness = await createHarness();
    const runId = 'run-shuffled-turns';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-shuffled-turns',
        communicationCondition: 'shuffled',
        maxTurnsPerRun: 1,
        evaluationTurns: 16,
      }),
    );
    await harness.runtime.createRun(config);
    await harness.runtime.runToCompletion(runId);

    const ledgers = harness.runtime.ledgers(runId);
    for (const [role, ledger] of [
      ['baby-a', ledgers.babyA],
      ['baby-b', ledgers.babyB],
    ] as const) {
      const turns = ledger
        .filter((event) => event.eventType === 'term.first_emitted')
        .map((event) => event.turn);
      // The condition only pre-generates a batch; it does not change who acts.
      expect(turns.length, role).toBeGreaterThan(0);
      expect(new Set(turns).size, role).toBeGreaterThan(1);
      for (const turn of turns) {
        // §11.4: an emission event belongs to a turn this Baby sent on — not
        // to the batch head the runtime's cursor named while the batch ran.
        expect(
          senderForTurn(turn, config.roleReversalPeriod),
          `${role} first emitted at turn ${String(turn)}`,
        ).toBe(role);
      }
    }
  }, 60_000);

  it('commits a rejection when a pre-pass envelope is malformed', async () => {
    harness = await createHarness({ adapterFactoryFor: () => forgetfulFactory });
    const runId = 'run-shuffled-malformed';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-shuffled-malformed',
          communicationCondition: 'shuffled',
          maxTurnsPerRun: 2,
          evaluationTurns: 2,
        }),
      ),
    );

    // §8.3/§9.4: a forfeited turn, never an exception out of `step()`.
    const result = await harness.runtime.step(runId);
    expect(result.turn).toBe(0);
    expect(result.outcome.success).toBe(false);
    expect(result.outcome.details).toMatchObject({
      reasonCode: 'invalid-envelope',
    });
    expect(result.channelEvent?.gatewayValidationResult).toBe('rejected');
    expect(result.channelEvent?.reasonCode).toBe('invalid-envelope');

    // Exactly one turn record for the turn, and the rejection is in the
    // transcript rather than lost with the exception.
    const records = harness.runtime.turnRecords(runId);
    expect(records).toHaveLength(1);
    expect(records[0]?.babyProposalHash).toBeNull();
    expect(
      harness.runtime
        .transcript(runId)
        .every((event) => event.gatewayValidationResult === 'rejected'),
    ).toBe(true);
  }, 60_000);
});
