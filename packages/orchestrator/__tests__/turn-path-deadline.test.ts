import { afterEach, describe, expect, it } from 'vitest';
import {
  DirectHostTransport,
  LearnerHost,
  RemoteLearnerAdapter,
  createLoopbackChannelPair,
} from '@ald/isolation';
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

class QuarantinableDeadlineAdapter extends DeadlineAdapter {
  quarantineAfterDeadline(): Promise<void> {
    return Promise.resolve();
  }
}

class DelayedAdapter implements LearnerAdapter {
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

  private async delay(method: TurnPathMethod): Promise<void> {
    if (this.method === method) {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
  }

  async init(context: LearnerInitContext): Promise<void> {
    await this.inner.init(context);
  }

  async observe(observation: Observation): Promise<void> {
    await this.delay('observe');
    await this.inner.observe(observation);
  }

  async act(budget: TurnBudget): Promise<TurnProposalEnvelope> {
    await this.delay('act');
    return this.inner.act(budget);
  }

  async receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    await this.delay('receive');
    return this.inner.receive(delivery);
  }

  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    await this.delay('onOutcome');
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

function quarantinableDeadlineFactory(method: TurnPathMethod): LearnerAdapterFactory {
  return {
    track: 'no-learning',
    isolation: 'in-process',
    create: () => new QuarantinableDeadlineAdapter(
      createLearnerAdapterFactory('no-learning').create(),
      method,
    ),
  };
}

function remoteDeadlineFactory(method: TurnPathMethod): {
  factory: LearnerAdapterFactory;
  adapter: () => RemoteLearnerAdapter;
  close: () => Promise<void>;
} {
  const pair = createLoopbackChannelPair();
  const host = new LearnerHost({
    channel: pair.host,
    boundary: 'in-process',
    createFactory: () => ({
      track: 'no-learning',
      create: () => new DelayedAdapter(
        createLearnerAdapterFactory('no-learning').create(),
        method,
      ),
    }),
  });
  const transport = new DirectHostTransport('in-process', pair.runtime, 'deadline-fixture');
  let adapter: RemoteLearnerAdapter | undefined;
  return {
    factory: {
      track: 'no-learning',
      isolation: 'in-process',
      create: () => {
        adapter = new RemoteLearnerAdapter({
          track: 'no-learning',
          transport,
          timing: 'normalized',
          deadlineMs: 1_000,
        });
        return adapter;
      },
    },
    adapter: () => {
      if (adapter === undefined) throw new Error('remote adapter was not created');
      return adapter;
    },
    close: async () => {
      await adapter?.dispose();
      await host.close();
    },
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

  it.each(cases)('quarantines a remote adapter after a real $label deadline', async ({ id, role, method }) => {
    const remote = remoteDeadlineFactory(method);
    try {
      harness = await createHarness({
        adapterFactoryFor: (_config, candidate) => candidate === role
          ? remote.factory
          : createLearnerAdapterFactory('no-learning'),
      });
      const runId = `run-rdl-${String(id).padStart(2, '0')}`;
      await harness.runtime.createRun(testConfig(noLearningOverrides({
        runId,
        experimentId: 'E02',
        randomSeed: `ald-rdl-${String(id).padStart(2, '0')}`,
        maxTurnsPerRun: 10,
        evaluationTurns: 2,
        turnResponseBudgetMs: 1_000,
        maxConsecutiveRejections: 5,
      })));

      const result = await harness.runtime.step(runId);

      expect(result.channelEvent).toMatchObject({
        gatewayValidationResult: 'rejected',
        reasonCode: 'timeout',
        logicalSender: role,
      });
      expect(result.state).toBe('paused');
      expect(harness.runtime.turnRecords(runId)).toHaveLength(1);
      const expectedHostMethod = method === 'onOutcome' ? 'on_outcome' : method;
      expect(remote.adapter().diagnostics).toMatchObject({
        deadlineExceeded: 1,
        lastDeadlineMethod: expectedHostMethod,
      });
      const deadlineEvent = harness.runtime.auditLog(runId).find(
        (event) => event.reasonCode === 'turn-deadline-forfeit',
      );
      expect(deadlineEvent?.details).toMatchObject({
        role,
        method,
        adapterQuarantined: true,
        quarantineFailed: false,
      });
      await expect(harness.runtime.resume(runId, {
        actorId: 'researcher:test-operator',
        reasonCode: 'unsafe-resume-attempt',
      })).rejects.toThrow(/abort this attempt instead of resuming/u);
    } finally {
      await remote.close();
    }
  }, 10_000);

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

  it('restores the no-resume quarantine from evidence after a restart', async () => {
    harness = await createHarness({
      adapterFactoryFor: (_config, role) => role === 'baby-a'
        ? quarantinableDeadlineFactory('observe')
        : createLearnerAdapterFactory('no-learning'),
    });
    const runId = 'run-rdl-recover';
    await harness.runtime.createRun(testConfig(noLearningOverrides({
      runId,
      experimentId: 'E02',
      randomSeed: 'ald-rdl-recover',
      maxTurnsPerRun: 10,
      evaluationTurns: 2,
      turnResponseBudgetMs: 1_000,
      maxConsecutiveRejections: 5,
    })));
    expect((await harness.runtime.step(runId)).state).toBe('paused');

    harness = harness.restart({
      adapterFactoryFor: () => createLearnerAdapterFactory('no-learning'),
    });
    expect((await harness.runtime.recover(runId)).state).toBe('paused');
    await expect(harness.runtime.resume(runId, {
      actorId: 'researcher:test-operator',
      reasonCode: 'unsafe-resume-after-restart',
    })).rejects.toThrow(/abort this attempt instead of resuming/u);
  });
});
