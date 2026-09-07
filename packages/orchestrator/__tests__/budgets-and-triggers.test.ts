/**
 * SPEC §7.2, §14.5, §15.1, §18: the stage/budget transitions are evaluated
 * independently of the §14.5 pause.
 *
 * A safety trigger may pause a run, but it may never buy it an extra training
 * or evaluation turn beyond the pre-registered budget, and it may never leave
 * a run circling a budget it cannot reach — when §7.2 offers no `pause` out of
 * the current state the trigger escalates to the `abort` row instead. A
 * nonzero Verifier at seal time is itself an audited §14.5 trigger.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RunState } from '@ald/types';

import {
  anchorPublisherFor,
  createHarness,
  fakeVerifier,
  misbehavingFactory,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

const OPERATOR = {
  actorId: 'researcher:test-operator',
  reasonCode: 'rejections-reviewed',
};

const TURN_ACCEPTING: readonly RunState[] = ['running', 'evaluating'];

function phaseCounts(
  harness: Harness,
  runId: string,
): { running: number; evaluating: number } {
  const records = harness.runtime.turnRecords(runId);
  return {
    running: records.filter((record) => record.phase === 'running').length,
    evaluating: records.filter((record) => record.phase === 'evaluating').length,
  };
}

/** Steps while the run accepts turns, with a hard bound on the loop. */
async function stepBounded(
  harness: Harness,
  runId: string,
  limit: number,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const state = harness.runtime.getRun(runId)?.state;
    if (state === undefined || !TURN_ACCEPTING.includes(state)) {
      return;
    }
    await harness.runtime.step(runId);
  }
}

describe('a pause never buys a turn (SPEC §7.2, §18)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('moves to evaluating on resume when the training budget is spent', async () => {
    harness = await createHarness({ adapterFactoryFor: () => misbehavingFactory });
    const runId = 'run-pause-at-budget';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-pause-at-budget',
          maxTurnsPerRun: 3,
          evaluationTurns: 2,
          // The §9.4 ceiling lands exactly on the last training turn.
          maxConsecutiveRejections: 3,
        }),
      ),
    );
    const paused = await harness.runtime.runToCompletion(runId);
    expect(paused.state).toBe('paused');
    expect(paused.turn).toBe(3);

    // §7.2: the transition the paused turn owed is applied before the run
    // accepts another turn, so the resumed run evaluates instead of taking a
    // fourth training turn with `updatePolicy` still enabled.
    const resumed = await harness.runtime.resume(runId, OPERATOR);
    expect(resumed.state).toBe('evaluating');

    await stepBounded(harness, runId, 10);
    expect(phaseCounts(harness, runId)).toEqual({ running: 3, evaluating: 2 });
    expect(harness.runtime.getRun(runId)?.state).toBe('sealing');
  }, 60_000);
});

describe('a trigger with no pause row escalates (SPEC §7.2, §14.5)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('ends a run whose rejection streak fires during evaluating', async () => {
    harness = await createHarness({ adapterFactoryFor: () => misbehavingFactory });
    const runId = 'run-trigger-evaluating';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-trigger-evaluating',
          maxTurnsPerRun: 1,
          evaluationTurns: 5,
          maxConsecutiveRejections: 2,
        }),
      ),
    );

    // The bound is the point: before the escalation the run neither paused nor
    // completed its budget, and stepped forever.
    await stepBounded(harness, runId, 12);

    expect(harness.runtime.getRun(runId)?.state).toBe('aborted-sealed');
    expect(phaseCounts(harness, runId)).toEqual({ running: 1, evaluating: 1 });
    const audit = harness.runtime.auditLog(runId);
    expect(
      audit.filter(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === 'pause-not-available',
      ),
    ).toHaveLength(1);
    expect(
      audit.filter(
        (event) =>
          event.eventType === 'abort' &&
          event.reasonCode === 'safety-trigger-escalated-abort',
      ),
    ).toHaveLength(1);
  }, 60_000);
});

describe('verifier trigger at seal time (SPEC §14.5, §15.1)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('audits a nonzero verifier exit with a reason code and a deviation', async () => {
    const runId = 'run-verifier-nonzero';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId, false, {
        evidence: () => harness?.runtime.writerFor(runId),
      }),
      verifier: fakeVerifier(runId, 1),
    });
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-verifier-nonzero',
          maxTurnsPerRun: 1,
          evaluationTurns: 2,
        }),
      ),
    );
    await harness.runtime.runToCompletion(runId);

    const triggers = harness.runtime
      .auditLog(runId)
      .filter(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === 'verifier-nonzero',
      );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.details).toMatchObject({
      exitCode: 1,
      gaps: 0,
      forks: 0,
    });
    expect(String(triggers[0]?.details['reportHash'])).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );

    // §15.1: the Verifier is authoritative, so the record stays `invalid` and
    // carries the deviation.
    const current = harness.runtime.experimentRecords(runId).at(-1);
    expect(current?.disposition).toBe('invalid');
    expect(current?.deviations.join(' ')).toContain('verifier-nonzero');
  }, 60_000);
});
