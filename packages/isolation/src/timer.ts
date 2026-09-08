/**
 * The one clock this package uses (SPEC §8.3 turn deadlines, §10.3 timing
 * normalization).
 *
 * Every wait — the per-call deadline and the Mode R fixed-schedule pad — goes
 * through {@link IsolationTimer}, so a test can drive both without a
 * wall-clock sleep and without patching global timers (which would also patch
 * the timers Node's own stream and child-process machinery uses).
 */

export interface IsolationDelay {
  readonly promise: Promise<void>;
  /** Cancel the pending resolution. The promise then never settles. */
  cancel(): void;
}

export interface IsolationTimer {
  /** Monotonic-ish milliseconds. Only differences are ever used. */
  now(): number;
  delay(ms: number): IsolationDelay;
}

/** Real timers and `performance.now()`. */
export const systemTimer: IsolationTimer = {
  now(): number {
    return performance.now();
  },
  delay(ms: number): IsolationDelay {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    const handle = setTimeout(() => {
      resolve?.();
    }, Math.max(0, ms));
    return {
      promise,
      cancel(): void {
        clearTimeout(handle);
      },
    };
  },
};

/**
 * Test timer: records every requested wait and resolves it immediately, so a
 * test can assert *that* a call was padded to the deadline and *by how much*
 * without spending the time (SPEC §10.3: what matters is that the schedule is
 * fixed, and the schedule is exactly this sequence of requested waits).
 *
 * `now()` advances by the recorded amount as each delay resolves, so elapsed
 * time inside the adapter behaves as if the wait really happened.
 */
export class RecordingTimer implements IsolationTimer {
  /** Every `delay(ms)` this timer was asked for, in call order. */
  readonly waits: number[] = [];

  private clock: number;

  constructor(start = 0) {
    this.clock = start;
  }

  now(): number {
    return this.clock;
  }

  /** Advance the virtual clock without a delay (simulates work taking time). */
  advance(ms: number): void {
    this.clock += ms;
  }

  delay(ms: number): IsolationDelay {
    this.waits.push(ms);
    let cancelled = false;
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        if (!cancelled) {
          this.clock += Math.max(0, ms);
          resolve();
        }
      });
    });
    return {
      promise,
      cancel(): void {
        cancelled = true;
      },
    };
  }
}
