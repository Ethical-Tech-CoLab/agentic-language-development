import { afterEach, describe, expect, it } from 'vitest';
import { createLearnerAdapterFactory } from '@ald/learners';
import type {
  BabyRole,
  DeliveredChannelArtifact,
  LearnerAdapter,
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
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

type TurnPathMethod = 'observe' | 'act' | 'receive' | 'onOutcome';

class SyntheticDeadlineError extends Error {
  readonly failureClass = 'adapter-timeout';
}

class DeadlineAdapter implements LearnerAdapter {
  readonly track: LearnerAdapter['track'];

  updatePolicy?: (batch: UpdateBatch) => Promise<PolicyCheckpointRef>;

  constructor(
    private readonly inner: LearnerAdapter,
    private readonly method: TurnPathMethod,
  ) {
    this.track = inner.track;
    const update = inner.updatePolicy;
    if (update) this.updatePolicy = (batch) => update.call(inner, batch);
  }

  private fail(method: TurnPathMethod): void {
    if (this.method === method) throw new SyntheticDeadlineError(method);
  }

  async init(context: LearnerInitContext): Promise<void> {
    await this.inner.init(context);
  }

  async observe(observation: Observation): Promise<void> {
    this.fail('observe');
    await this.inner.observe(observation);
  }

  async act(budget: TurnBudget): Promise<TurnProposalEnvelope> {
    this.fail('act');
    return this.inner.act(budget);
  }

  async receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    this.fail('receive');
    return this.inner.receive(delivery);
  }

  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    this.fail('onOutcome');
    await this.inner.onOutcome(outcome);
  }

  exportPolicy(): unknown {
    return this.inner.exportPolicy();
  }
}

function deadlineFactory(method: TurnPathMethod): LearnerAdapterFactory {
  return {
    track: 'no-learning',
    create: () => new DeadlineAdapter(
      createLearnerAdapterFactory('no-learning').create(),
      method,
    ),
  };
}

const cases: ReadonlyArray<{
  id: number;
  label: string;
  role: BabyRole;
  method: TurnPathMethod;
}> = [
  { id: 1, label: 'first observation', role: 'baby-a', method: 'observe' },
  { id: 2, label: 'sender action', role: 'baby-a', method: 'act' },
  { id: 3, label: 'receiver delivery', role: 'baby-b', method: 'receive' },
  { id: 4, label: 'receiver action', role: 'baby-b', method: 'act' },
  { id: 5, label: 'post-outcome update', role: 'baby-a', method: 'onOutcome' },
];

describe('all-method turn deadline accounting (SPEC §8.3)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it.each(cases)('records a $label deadline as one audited forfeited turn', async ({ id, role, method }) => {
    harness = await createHarness({
      adapterFactoryFor: (_config, candidate) => candidate === role
        ? deadlineFactory(method)
        : createLearnerAdapterFactory('no-learning'),
    });
    const runId = `run-dl-${String(id).padStart(2, '0')}`;
    await harness.runtime.createRun(testConfig(noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: `ald-dl-${String(id).padStart(2, '0')}`,
      maxTurnsPerRun: 10,
      evaluationTurns: 2,
      turnResponseBudgetMs: 1_000,
      maxConsecutiveRejections: 5,
    })));

    const result = await harness.runtime.step(runId);

    expect(result.turn).toBe(0);
    expect(result.state).toBe('running');
    expect(result.channelEvent).toMatchObject({
      gatewayValidationResult: 'rejected',
      reasonCode: 'timeout',
      logicalSender: role,
    });
    expect(result.outcome).toMatchObject({
      success: false,
      reward: 0,
      details: { reason: 'forfeit', reasonCode: 'timeout' },
    });
    expect(harness.runtime.turnRecords(runId)).toHaveLength(1);
    expect(result.turnRecord.channelEventHash).toBe(result.channelEvent?.entryHash);
    const deadlineEvents = harness.runtime.auditLog(runId).filter(
      (event) => event.reasonCode === 'turn-deadline-forfeit',
    );
    expect(deadlineEvents).toHaveLength(1);
    expect(deadlineEvents[0]).toMatchObject({
      eventType: 'runtime-attestation',
      details: { turn: 0, role, method, budgetMs: 1_000 },
    });
  });

  it('pauses after five consecutive method-level timeout forfeits', async () => {
    harness = await createHarness({
      adapterFactoryFor: (_config, role) => role === 'baby-a'
        ? deadlineFactory('observe')
        : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-five-turn-path-deadlines';
    await harness.runtime.createRun(testConfig(noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: 'ald-five-turn-path-deadlines',
      maxTurnsPerRun: 10,
      evaluationTurns: 2,
      turnResponseBudgetMs: 1_000,
      maxConsecutiveRejections: 5,
    })));

    for (let turn = 0; turn < 5; turn += 1) {
      const result = await harness.runtime.step(runId);
      expect(result.turn).toBe(turn);
      expect(result.channelEvent?.reasonCode).toBe('timeout');
      expect(result.state).toBe(turn === 4 ? 'paused' : 'running');
    }

    expect(harness.runtime.turnRecords(runId)).toHaveLength(5);
    expect(harness.runtime.auditLog(runId).filter(
      (event) => event.reasonCode === 'turn-deadline-forfeit',
    )).toHaveLength(5);
    expect(harness.runtime.auditLog(runId).filter(
      (event) => event.reasonCode === 'max-consecutive-rejections',
    )).toHaveLength(1);
    await expect(harness.runtime.step(runId)).rejects.toThrow(/does not accept turns/u);
  });
});
