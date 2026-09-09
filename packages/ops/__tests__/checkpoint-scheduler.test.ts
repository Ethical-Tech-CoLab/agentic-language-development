import { EventEmitter } from 'node:events';

import type { SchedulerTimer, SchedulerTimerHandle } from '@ald/checkpoint';
import { describe, expect, it } from 'vitest';

import {
  InMemoryFailureLogger,
  startProtectedCheckpointScheduler,
  type FailureHostProcess,
} from '../src/index.js';

class FakeTimer implements SchedulerTimer {
  callback: (() => void) | undefined;

  setInterval(callback: () => void): SchedulerTimerHandle {
    this.callback = callback;
    return callback;
  }

  clearInterval(): void {
    this.callback = undefined;
  }

  fire(): void {
    this.callback?.();
  }
}

class FakeProcess extends EventEmitter implements FailureHostProcess {
  exit(): never {
    throw new Error('non-fatal scheduler failure must not exit');
  }
}

describe('protected checkpoint scheduler (ALD-014)', () => {
  it('installs process guards before the timer and logs a failed tick', async () => {
    const host = new FakeProcess();
    const timer = new FakeTimer();
    const logger = new InMemoryFailureLogger();
    let now = Date.UTC(2026, 0, 1);
    const protectedScheduler = startProtectedCheckpointScheduler({
      service: {
        createCheckpointIfChanged: async () => {
          throw new Error('checkpoint write failed');
        },
      },
      runId: 'protected-scheduler-run',
      eventInterval: 64,
      timeIntervalMs: 1_000,
      tickIntervalMs: 250,
      clock: { now: () => new Date(now).toISOString() },
      timer,
      logger,
      process: host,
    });
    expect(host.listenerCount('uncaughtException')).toBe(1);
    expect(host.listenerCount('unhandledRejection')).toBe(1);

    protectedScheduler.scheduler.recordAcceptedEvents(1);
    now += 1_000;
    expect(() => timer.fire()).not.toThrow();
    await expect(protectedScheduler.scheduler.pending).resolves.toBeUndefined();
    expect(logger.records).toEqual([
      expect.objectContaining({
        source: 'background-task',
        taskName: 'checkpoint-scheduler',
        fatal: false,
      }),
    ]);

    protectedScheduler.stop();
    expect(host.listenerCount('uncaughtException')).toBe(0);
    expect(host.listenerCount('unhandledRejection')).toBe(0);
  });
});
