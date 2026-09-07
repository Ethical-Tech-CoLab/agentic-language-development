import type { CheckpointManifest, CheckpointReason } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CheckpointCreationResult,
  CheckpointCreator,
} from '../src/checkpoint-service.js';
import { InvalidCheckpointRequestError } from '../src/errors.js';
import {
  CheckpointScheduler,
  type SchedulerTimer,
  type SchedulerTimerHandle,
} from '../src/scheduler.js';
import {
  ManualClock,
  cleanupTemporaryDirectories,
  commitTurns,
  createContext,
} from './support.js';

afterEach(cleanupTemporaryDirectories);

/** Timer whose callback only runs when a test fires it. */
class FakeTimer implements SchedulerTimer {
  callbacks: (() => void)[] = [];
  intervals: number[] = [];
  cleared = 0;

  setInterval(callback: () => void, ms: number): SchedulerTimerHandle {
    this.callbacks.push(callback);
    this.intervals.push(ms);
    return this.callbacks.length - 1;
  }

  clearInterval(): void {
    this.cleared += 1;
    this.callbacks = [];
  }

  fire(): void {
    for (const callback of [...this.callbacks]) {
      callback();
    }
  }
}

/** Records every checkpoint request; never touches an Evidence Store. */
class RecordingCreator implements CheckpointCreator {
  readonly calls: CheckpointReason[] = [];

  constructor(private readonly failWith?: Error) {}

  createCheckpointIfChanged(
    _runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointCreationResult> {
    this.calls.push(reason);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve({
      created: true,
      reason,
      manifest: {
        checkpointSequence: this.calls.length - 1,
      } as unknown as CheckpointManifest,
    });
  }
}

describe('CheckpointScheduler event trigger', () => {
  it('fires exactly once the configured event interval is reached', async () => {
    const creator = new RecordingCreator();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 4,
      timeIntervalMs: 60_000,
      clock: new ManualClock(),
    });

    scheduler.recordAcceptedEvents(1);
    scheduler.recordAcceptedEvents(2);
    expect(creator.calls).toEqual([]);
    expect(scheduler.pendingEventCount).toBe(3);

    scheduler.recordAcceptedEvents(1);
    // The window is consumed synchronously; the checkpoint itself is queued.
    expect(scheduler.pendingEventCount).toBe(0);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval']);

    scheduler.recordAcceptedEvents(3);
    await scheduler.pending;
    expect(creator.calls).toHaveLength(1);
    scheduler.recordAcceptedEvents(1);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval', 'event-interval']);
  });

  it('fires once for a burst larger than the interval and starts a fresh window', async () => {
    const creator = new RecordingCreator();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 4,
      timeIntervalMs: 60_000,
      clock: new ManualClock(),
    });

    scheduler.recordAcceptedEvents(10);
    await scheduler.pending;

    expect(creator.calls).toEqual(['event-interval']);
    expect(scheduler.pendingEventCount).toBe(0);
  });

  it('reports a non-integer event count instead of counting it', () => {
    const scheduler = new CheckpointScheduler({
      service: new RecordingCreator(),
      runId: 'run-a',
      eventInterval: 4,
      timeIntervalMs: 60_000,
      clock: new ManualClock(),
    });

    expect(() => scheduler.recordAcceptedEvents(-1)).toThrow(
      InvalidCheckpointRequestError,
    );
    expect(() => scheduler.recordAcceptedEvents(1.5)).toThrow(
      InvalidCheckpointRequestError,
    );
    expect(scheduler.pendingEventCount).toBe(0);
  });

  it('rejects a non-positive interval at construction', () => {
    expect(
      () =>
        new CheckpointScheduler({
          service: new RecordingCreator(),
          runId: 'run-a',
          eventInterval: 0,
          timeIntervalMs: 60_000,
          clock: new ManualClock(),
        }),
    ).toThrow(InvalidCheckpointRequestError);
  });
});

describe('CheckpointScheduler time trigger', () => {
  it('fires once the time interval has passed and events are pending', async () => {
    const creator = new RecordingCreator();
    const clock = new ManualClock();
    const timer = new FakeTimer();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 1_000,
      timeIntervalMs: 5_000,
      clock,
      timer,
    });
    scheduler.start();
    // Default tickIntervalMs is max(1000, floor(timeIntervalMs / 4)).
    expect(timer.intervals).toEqual([1_250]);

    // No events yet: an idle run never checkpoints on time alone.
    clock.advance(10_000);
    timer.fire();
    await scheduler.pending;
    expect(creator.calls).toEqual([]);

    // Events pending and the interval already elapsed: the trigger fires.
    scheduler.recordAcceptedEvents(2);
    timer.fire();
    await scheduler.pending;
    expect(creator.calls).toEqual(['time-interval']);
    expect(scheduler.pendingEventCount).toBe(0);

    // The window restarts from the completed checkpoint: too soon to fire.
    scheduler.recordAcceptedEvents(1);
    timer.fire();
    await scheduler.pending;
    expect(creator.calls).toEqual(['time-interval']);

    clock.advance(5_000);
    timer.fire();
    await scheduler.pending;
    expect(creator.calls).toEqual(['time-interval', 'time-interval']);

    scheduler.stop();
    expect(timer.cleared).toBe(1);
    expect(scheduler.running).toBe(false);
  });

  it('start and stop are idempotent', () => {
    const timer = new FakeTimer();
    const scheduler = new CheckpointScheduler({
      service: new RecordingCreator(),
      runId: 'run-a',
      eventInterval: 4,
      timeIntervalMs: 5_000,
      clock: new ManualClock(),
      timer,
    });

    scheduler.start();
    scheduler.start();
    expect(timer.callbacks).toHaveLength(1);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    scheduler.stop();
    expect(timer.cleared).toBe(1);
  });
});

describe('CheckpointScheduler time-interval cadence bound', () => {
  it('fires within timeIntervalMs + tickIntervalMs of the last checkpoint, even off-cycle', async () => {
    const timeIntervalMs = 300_000;
    const creator = new RecordingCreator();
    const clock = new ManualClock(0);
    const timer = new FakeTimer();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 2,
      timeIntervalMs,
      clock,
      timer,
    });
    scheduler.start();
    const tickIntervalMs = timer.intervals[0];
    expect(tickIntervalMs).toBe(75_000); // max(1000, floor(300_000 / 4))

    // An event-interval checkpoint lands off the tick cycle, at t = 301_000
    // (the reporter's exact reproduction scenario).
    clock.advance(301_000);
    scheduler.recordAcceptedEvents(2);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval']);
    const lastCheckpointAtMs = 301_000;

    // One further event arrives, then nothing else.
    clock.advance(1_000); // t = 302_000
    scheduler.recordAcceptedEvents(1);

    // Fire ticks on the real fixed phase (multiples of tickIntervalMs from
    // start) until the time trigger fires; earlier ticks in this window
    // correctly skip because timeIntervalMs has not elapsed since 301_000.
    let elapsed = 302_000;
    let fired = false;
    for (let tick = 5; tick <= 20 && !fired; tick += 1) {
      const target = tick * tickIntervalMs;
      clock.advance(target - elapsed);
      elapsed = target;
      timer.fire();
      await scheduler.pending;
      if (creator.calls.includes('time-interval')) {
        fired = true;
        const gap = elapsed - lastCheckpointAtMs;
        // This is the bound the fix establishes: not 2 * timeIntervalMs.
        expect(gap).toBeLessThanOrEqual(timeIntervalMs + tickIntervalMs);
        expect(gap).toBeGreaterThanOrEqual(timeIntervalMs);
      }
    }
    expect(fired).toBe(true);

    scheduler.stop();
  });
});

describe('CheckpointScheduler failure handling', () => {
  it('routes a checkpoint failure to onError and keeps the events pending', async () => {
    const failure = new Error('sqlite is busy');
    const creator = new RecordingCreator(failure);
    const errors: unknown[] = [];
    const timer = new FakeTimer();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 2,
      timeIntervalMs: 5_000,
      clock: new ManualClock(),
      timer,
      onError: (error) => errors.push(error),
    });
    scheduler.start();

    scheduler.recordAcceptedEvents(2);
    await scheduler.pending;

    expect(errors).toEqual([failure]);
    expect(scheduler.pendingEventCount).toBe(2);
    // The chain survived the rejection, so the next trigger still runs.
    scheduler.recordAcceptedEvents(1);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval', 'event-interval']);
    expect(errors).toHaveLength(2);

    scheduler.stop();
  });

  it('never lets a timer callback throw out of the timer', async () => {
    const errors: unknown[] = [];
    const timer = new FakeTimer();
    let readings = 0;
    const creator = new RecordingCreator();
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 2,
      timeIntervalMs: 1_000,
      clock: {
        now: () => {
          readings += 1;
          return readings === 1
            ? new Date(Date.UTC(2026, 0, 1)).toISOString()
            : 'not-a-timestamp';
        },
      },
      timer,
      onError: (error) => errors.push(error),
    });
    scheduler.start();
    scheduler.recordAcceptedEvents(1);

    expect(() => timer.fire()).not.toThrow();
    await scheduler.pending;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(InvalidCheckpointRequestError);
    expect(creator.calls).toEqual([]);

    scheduler.stop();
  });

  it('recovers when onError itself throws: the chain never stays rejected', async () => {
    const failure = new Error('sqlite is busy');
    const creator = new RecordingCreator(failure);
    const errors: unknown[] = [];
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 2,
      timeIntervalMs: 5_000,
      clock: new ManualClock(),
      onError: (error) => {
        errors.push(error);
        throw new Error('logger exploded');
      },
    });

    scheduler.recordAcceptedEvents(2);
    // Before the fix this rejected forever, so a bare `await` here would
    // throw "logger exploded" instead of resolving.
    await expect(scheduler.pending).resolves.toBeUndefined();
    expect(errors).toEqual([failure]);

    // A later window must still reach the service: the chain was not
    // permanently poisoned by the throwing observer.
    scheduler.recordAcceptedEvents(2);
    await expect(scheduler.pending).resolves.toBeUndefined();
    expect(creator.calls).toEqual(['event-interval', 'event-interval']);
    expect(errors).toHaveLength(2);
  });

  it('does not re-add already-checkpointed events when onCheckpoint throws', async () => {
    const creator = new RecordingCreator();
    const errors: unknown[] = [];
    const scheduler = new CheckpointScheduler({
      service: creator,
      runId: 'run-a',
      eventInterval: 4,
      timeIntervalMs: 60_000,
      clock: new ManualClock(),
      onCheckpoint: () => {
        throw new Error('subscriber blew up');
      },
      onError: (error) => errors.push(error),
    });

    scheduler.recordAcceptedEvents(4);
    await expect(scheduler.pending).resolves.toBeUndefined();

    // The checkpoint was created; only the subscriber failed.
    expect(creator.calls).toEqual(['event-interval']);
    expect(errors).toHaveLength(1);
    // Criterion 2: a successfully checkpointed window must not be restored,
    // or the next single event would immediately re-trigger and the
    // checkpointed range would be re-attempted.
    expect(scheduler.pendingEventCount).toBe(0);

    scheduler.recordAcceptedEvents(1);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval']);
    expect(scheduler.pendingEventCount).toBe(1);

    // The cadence is otherwise unaffected: completing the window still
    // fires exactly one more checkpoint, not one per event.
    scheduler.recordAcceptedEvents(3);
    await scheduler.pending;
    expect(creator.calls).toEqual(['event-interval', 'event-interval']);
  });
});

describe('CheckpointScheduler against a real Evidence Store', () => {
  it('writes non-overlapping checkpoints and skips when nothing changed', async () => {
    const context = await createContext({ checkpointEventInterval: 2 });
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    const results: CheckpointCreationResult[] = [];
    const timer = new FakeTimer();
    const clock = new ManualClock();
    const scheduler = new CheckpointScheduler({
      service: context.service,
      runId: context.runId,
      eventInterval: context.config.checkpointEventInterval,
      timeIntervalMs: context.config.checkpointTimeIntervalMs,
      clock,
      timer,
      onCheckpoint: (_manifest, result) => results.push(result),
    });
    scheduler.start();

    await commitTurns(context, 1);
    scheduler.recordAcceptedEvents(2);
    await scheduler.pending;

    await commitTurns(context, 1, 2);
    scheduler.recordAcceptedEvents(2);
    await scheduler.pending;

    // A third trigger with nothing appended in between is skipped.
    scheduler.recordAcceptedEvents(2);
    await scheduler.pending;

    scheduler.stop();

    expect(results.map((result) => result.created)).toEqual([
      true,
      true,
      false,
    ]);
    const checkpoints = context.writer.readCheckpoints(context.runId);
    expect(checkpoints.map((entry) => entry.checkpointSequence)).toEqual([
      0, 1, 2,
    ]);
    // ALD-014 criterion 2: tree sizes never overlap or go backwards.
    const sizes = checkpoints.map((entry) => entry.channel.treeSize);
    expect(sizes).toEqual([0, 1, 2]);
    for (let index = 1; index < checkpoints.length; index += 1) {
      const previous = checkpoints[index - 1];
      const current = checkpoints[index];
      expect(current?.previousCheckpointHash).toBe(previous?.checkpointHash);
      expect(current?.babyA.treeSize).toBeGreaterThanOrEqual(
        previous?.babyA.treeSize ?? 0,
      );
    }

    context.close();
  });

  it('serializes concurrent triggers so no two checkpoints cover the same events', async () => {
    const context = await createContext({ checkpointEventInterval: 1 });
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    const timer = new FakeTimer();
    const clock = new ManualClock();
    const scheduler = new CheckpointScheduler({
      service: context.service,
      runId: context.runId,
      eventInterval: 1,
      timeIntervalMs: 1_000,
      clock,
      timer,
    });
    scheduler.start();

    await commitTurns(context, 2);
    // Two triggers back to back: event interval and, in the same tick, time.
    scheduler.recordAcceptedEvents(1);
    clock.advance(5_000);
    scheduler.recordAcceptedEvents(1);
    timer.fire();
    await scheduler.pending;
    scheduler.stop();

    const checkpoints = context.writer.readCheckpoints(context.runId);
    const sequences = checkpoints.map((entry) => entry.checkpointSequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    context.close();
  });
});
