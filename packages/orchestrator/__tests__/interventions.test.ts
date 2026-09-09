/**
 * ALD-026 / ALD-059: the rejection safety trigger of SPEC §9.4/§14.5 and the
 * audited pause, resume, and abort path of §7.3/§14.2.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  misbehavingFactory,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

const OPERATOR = { actorId: 'researcher:test-operator', reasonCode: 'manual-check' };

describe('rejection safety trigger (SPEC §9.4)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('pauses the run with a safety trigger after the rejection ceiling', async () => {
    harness = await createHarness({ adapterFactoryFor: () => misbehavingFactory });
    const runId = 'run-rejections';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-rejections',
        maxTurnsPerRun: 20,
        evaluationTurns: 5,
        maxConsecutiveRejections: 5,
      }),
    );
    await harness.runtime.createRun(config);
    const summary = await harness.runtime.runToCompletion(runId);

    // §7.3: the pause prevents a new turn from starting, so the run stops
    // exactly at the ceiling instead of burning its whole budget.
    expect(summary.state).toBe('paused');
    expect(summary.turn).toBe(5);

    const transcript = harness.runtime.transcript(runId);
    expect(transcript).toHaveLength(5);
    expect(
      transcript.every((event) => event.gatewayValidationResult === 'rejected'),
    ).toBe(true);
    expect(transcript.every((event) => event.reasonCode !== undefined)).toBe(true);

    const records = harness.runtime.turnRecords(runId);
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.babyProposalHash).toBeNull();
      expect(record.outcome.success).toBe(false);
      expect(record.outcome.details).toMatchObject({ reason: 'forfeit' });
    }

    const audit = harness.runtime.auditLog(runId);
    const trigger = audit.find(
      (event) =>
        event.eventType === 'safety-trigger' &&
        event.reasonCode === 'max-consecutive-rejections',
    );
    expect(trigger).toBeDefined();
    expect(trigger?.details).toMatchObject({ consecutiveRejections: 5 });

    // §7.2: a pause MUST produce a checkpoint.
    expect(
      harness.runtime
        .checkpoints(runId)
        .some((manifest) => manifest.reason === 'pause'),
    ).toBe(true);

    const resumed = await harness.runtime.resume(runId, {
      actorId: 'researcher:test-operator',
      reasonCode: 'rejections-reviewed',
    });
    expect(resumed.state).toBe('running');
    expect(
      harness.runtime
        .auditLog(runId)
        .some((event) => event.eventType === 'resume'),
    ).toBe(true);
    // The reviewed streak starts again, so one more turn is accepted.
    const next = await harness.runtime.step(runId);
    expect(next.turn).toBe(5);
    expect(next.state).toBe('running');
  }, 60_000);
});

describe('operator interventions (SPEC §7.3, §14.2)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('logs annotations and human views without changing the run state', async () => {
    harness = await createHarness();
    const runId = 'run-annotations';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-annotations',
          maxTurnsPerRun: 4,
          evaluationTurns: 2,
        }),
      ),
    );
    await harness.runtime.step(runId);

    const annotation = await harness.runtime.annotate(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'unplanned-observation',
      details: { note: 'symbol reuse looks degenerate' },
    });
    expect(annotation.eventType).toBe('annotate');
    const view = await harness.runtime.recordHumanView(runId, {
      actorId: 'researcher:viewer',
      reasonCode: 'transcript-read',
    });
    expect(view.eventType).toBe('human-view');

    expect(harness.runtime.getRun(runId)?.state).toBe('running');
    // §14.2: an intervention is checkpointed; a human view is not.
    const reasons = harness.runtime
      .checkpoints(runId)
      .map((manifest) => manifest.reason);
    expect(reasons.filter((reason) => reason === 'intervention')).toHaveLength(1);
    const deviationRecord = harness.runtime.experimentRecords(runId).at(-1);
    expect(deviationRecord?.recordVersion).toBe(2);
    expect(deviationRecord?.deviations).toEqual([
      `unplanned-intervention:${annotation.entryHash}:unplanned-observation`,
    ]);
    const next = await harness.runtime.step(runId);
    expect(next.turn).toBe(1);
  }, 60_000);

  it('pauses, resumes, and aborts through the audited path', async () => {
    harness = await createHarness();
    const runId = 'run-interventions';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-interventions',
        maxTurnsPerRun: 30,
        evaluationTurns: 5,
      }),
    );
    await harness.runtime.createRun(config);
    await harness.runtime.step(runId);
    await harness.runtime.step(runId);

    const paused = await harness.runtime.pause(runId, {
      ...OPERATOR,
      details: { note: 'inspecting the transcript' },
    });
    expect(paused.state).toBe('paused');
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );

    const audit = harness.runtime.auditLog(runId);
    const pauseEvent = audit.find((event) => event.eventType === 'pause');
    expect(pauseEvent?.actorId).toBe(OPERATOR.actorId);
    expect(pauseEvent?.reasonCode).toBe(OPERATOR.reasonCode);
    expect(pauseEvent?.details).toMatchObject({
      note: 'inspecting the transcript',
    });
    expect(
      harness.runtime
        .checkpoints(runId)
        .filter((manifest) => manifest.reason === 'pause'),
    ).toHaveLength(1);

    const resumed = await harness.runtime.resume(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'resume-after-review',
    });
    expect(resumed.state).toBe('running');
    const afterResume = await harness.runtime.step(runId);
    expect(afterResume.turn).toBe(2);

    const aborted = await harness.runtime.abort(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'operator-abort',
    });
    expect(aborted.state).toBe('aborted-sealed');

    // §7.1: `aborted-sealed` is terminal and can never accept a turn again.
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );
    await expect(
      harness.runtime.resume(runId, OPERATOR),
    ).rejects.toThrow(/invalid-run-state|requires/u);

    const finalAudit = harness.runtime.auditLog(runId);
    expect(finalAudit.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['pause', 'resume', 'abort', 'governance-decision']),
    );
    const checkpointReasons = harness.runtime
      .checkpoints(runId)
      .map((manifest) => manifest.reason);
    expect(checkpointReasons).toContain('run-aborted');

    const records = harness.runtime.experimentRecords(runId);
    expect(records.at(-1)?.disposition).toBe('aborted');
    expect(records.map((record) => record.recordVersion)).toEqual([1, 2]);

    // §7.3: an aborted run still produces `run.sealed` and a full bundle.
    const ledgers = harness.runtime.ledgers(runId);
    for (const ledger of [ledgers.babyA, ledgers.babyB]) {
      expect(ledger.some((event) => event.eventType === 'run.sealed')).toBe(true);
    }
  }, 60_000);
});
