/**
 * SPEC §9.6: all six Gateway-selectable communication conditions execute the
 * same scenarios and learner interfaces through the runtime, and every
 * Baby-originated condition records both the Baby proposal hash and the
 * delivered artifact hash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCarrierMark } from '@ald/hashing';
import { createLearnerAdapterFactory } from '@ald/learners';
import type {
  AgentActionProposal,
  ChannelEvent,
  RunConfig,
  TurnRecord,
} from '@ald/types';

import {
  createHarness,
  noLearningOverrides,
  recordingFactory,
  successRate,
  testConfig,
  type Harness,
} from './helpers.js';

const CONDITIONS = [
  'normal',
  'disabled',
  'constant',
  'random',
  'shuffled',
  'oracle',
] as const;

const EVALUATION_TURNS = 20;

interface ConditionRun {
  runId: string;
  config: RunConfig;
  records: TurnRecord[];
  transcript: ChannelEvent[];
  proposals: Map<number, AgentActionProposal>;
  state: string;
}

describe('communication control conditions (SPEC §9.6)', () => {
  let harness: Harness;
  const runs = new Map<(typeof CONDITIONS)[number], ConditionRun>();

  beforeAll(async () => {
    const proposalsByRun = new Map<string, Map<number, AgentActionProposal>>();
    harness = await createHarness({
      adapterFactoryFor: (config) => {
        const sink =
          proposalsByRun.get(config.runId) ??
          new Map<number, AgentActionProposal>();
        proposalsByRun.set(config.runId, sink);
        return recordingFactory(
          createLearnerAdapterFactory('no-learning'),
          sink,
        );
      },
    });

    for (const condition of CONDITIONS) {
      const runId = `run-e03-${condition}`;
      const config = testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: `ald-e03-${condition}`,
          maxTurnsPerRun: 1,
          evaluationTurns: EVALUATION_TURNS,
          communicationCondition: condition,
        }),
      );
      await harness.runtime.createRun(config);
      const summary = await harness.runtime.runToCompletion(runId);
      runs.set(condition, {
        runId,
        config,
        records: harness.runtime.turnRecords(runId),
        transcript: harness.runtime.transcript(runId),
        proposals: proposalsByRun.get(runId) ?? new Map(),
        state: summary.state,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it('runs every condition to completion with one record per turn', () => {
    for (const condition of CONDITIONS) {
      const run = runs.get(condition);
      expect(run, condition).toBeDefined();
      expect(run?.state, condition).toBe('aborted-sealed');
      expect(run?.records, condition).toHaveLength(EVALUATION_TURNS + 1);
      expect(
        run?.records.every(
          (record) => record.communicationCondition === condition,
        ),
        condition,
      ).toBe(true);
    }
  });

  it('records a Baby proposal hash for every condition except oracle', () => {
    for (const condition of CONDITIONS) {
      const run = runs.get(condition);
      const hashes = run?.records.map((record) => record.babyProposalHash) ?? [];
      if (condition === 'oracle') {
        expect(hashes.every((hash) => hash === null), condition).toBe(true);
      } else {
        expect(hashes.every((hash) => hash !== null), condition).toBe(true);
      }
    }
  });

  it('delivers the Baby artifact unchanged only under normal', () => {
    const run = runs.get('normal');
    const evaluation =
      run?.records.filter((record) => record.phase === 'evaluating') ?? [];
    expect(evaluation).toHaveLength(EVALUATION_TURNS);
    for (const record of evaluation) {
      const proposal = run?.proposals.get(record.turn);
      expect(proposal, `turn ${String(record.turn)}`).toBeDefined();
      expect(record.deliveredArtifactHash).toBe(
        hashCarrierMark('fixed-token', proposal?.publicArtifact),
      );
    }
  });

  it('substitutes the delivered artifact under constant, random, and shuffled', () => {
    for (const condition of ['constant', 'random', 'shuffled'] as const) {
      const run = runs.get(condition);
      const evaluation =
        run?.records.filter((record) => record.phase === 'evaluating') ?? [];
      expect(evaluation, condition).toHaveLength(EVALUATION_TURNS);

      let substituted = 0;
      for (const record of evaluation) {
        const proposal = run?.proposals.get(record.turn);
        expect(proposal, `${condition} turn ${String(record.turn)}`).toBeDefined();
        if (
          record.deliveredArtifactHash !==
          hashCarrierMark('fixed-token', proposal?.publicArtifact)
        ) {
          substituted += 1;
        }
      }
      // A seeded replacement may coincide with the Baby's own one-symbol
      // message, so the check is that substitution dominates, not that it is
      // universal.
      expect(substituted, condition).toBeGreaterThanOrEqual(
        Math.ceil(EVALUATION_TURNS * 0.7),
      );
    }
  });

  it('delivers nothing under disabled', () => {
    const run = runs.get('disabled');
    expect(
      run?.transcript.every((event) => event.deliveryReceipt === undefined),
    ).toBe(true);
    expect(
      run?.records.every(
        (record) =>
          record.deliveredArtifactHash ===
          hashCarrierMark('fixed-token', null),
      ),
    ).toBe(true);
    // No delivery means no interpretation event can exist (§8.2).
    const ledgers = harness.runtime.ledgers(run?.runId ?? '');
    for (const ledger of [ledgers.babyA, ledgers.babyB]) {
      expect(
        ledger.some((event) => event.eventType === 'interpretation.recorded'),
      ).toBe(false);
    }
  });

  it('solves the task under the oracle control', () => {
    const run = runs.get('oracle');
    const evaluation =
      run?.records.filter((record) => record.phase === 'evaluating') ?? [];
    const rate = successRate(
      evaluation.map((record) => ({ success: record.outcome.success === true })),
    );
    expect(rate).toBeGreaterThan(0.9);
    expect(
      run?.transcript.every((event) => event.origin === 'gateway-control'),
    ).toBe(true);
  });

  it('replays every condition from the recorded seed', () => {
    for (const condition of CONDITIONS) {
      const run = runs.get(condition);
      const result = harness.runtime.scenarioReplayCheck(run?.runId ?? '');
      expect(result.mismatches, condition).toEqual([]);
      expect(result.turnsChecked, condition).toBe(EVALUATION_TURNS + 1);
    }
  });

  it('keeps the learned conditions near chance for a no-learning pair', () => {
    for (const condition of ['normal', 'disabled', 'shuffled'] as const) {
      const run = runs.get(condition);
      const rate = successRate(
        (run?.records ?? []).map((record) => ({
          success: record.outcome.success === true,
        })),
      );
      expect(rate, condition).toBeLessThanOrEqual(0.6);
    }
  });
});
