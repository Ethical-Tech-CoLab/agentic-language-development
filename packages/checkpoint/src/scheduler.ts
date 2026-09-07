/**
 * ALD-014 — the checkpoint frequency scheduler
 * (LEDGER-INTEGRITY-DESIGN.md §9).
 *
 * LEDGER §9 asks for a checkpoint "every 64 accepted ledger events or five
 * minutes, whichever occurs first", with the exact numbers recorded before
 * the run (`RunConfig.checkpointEventInterval` /
 * `checkpointTimeIntervalMs`). Lifecycle checkpoints — run initialization,
 * pause, intervention, recovery, policy checkpoints, seal, abort — are the
 * orchestrator's business and go straight to
 * {@link EvidenceCheckpointService.createCheckpoint}; this class owns only
 * the two periodic triggers.
 *
 * Two invariants matter more than the cadence:
 *
 * 1. **No two checkpoints overlap in event range** (criterion 2). Every
 *    trigger consumes the pending event count synchronously and all
 *    checkpoint calls run through one promise chain, so two triggers can
 *    never interleave over the same events.
 * 2. **A scheduling failure never crashes the host** (criterion 3). The
 *    timer callback cannot throw and the internal chain never rejects; every
 *    failure is handed to `onError`, which the server wires to its logger
 *    alongside its `uncaughtException` / `unhandledRejection` handlers. A
 *    throwing `onError` or `onCheckpoint` observer is itself contained the
 *    same way: it can neither poison the chain nor re-add events for a
 *    checkpoint that was already written (see {@link trigger}).
 *
 * **Time-interval cadence bound.** `tick()` only fires a checkpoint when at
 * least `tickIntervalMs` has passed since the previous tick *and* at least
 * `timeIntervalMs` has passed since the last checkpoint. Because ticks land
 * on a fixed phase from `start()`, a tick that arrives even slightly short of
 * `timeIntervalMs` is skipped entirely and the next opportunity is a full
 * `tickIntervalMs` later. Defaulting `tickIntervalMs` to `timeIntervalMs`
 * (as this class used to) therefore lets the worst-case gap between an
 * accepted event and its time-interval checkpoint approach
 * `2 * timeIntervalMs` instead of the configured value, doubling the
 * unanchored-rewrite window LEDGER §9 exists to bound. The default is now
 * `max(1000, floor(timeIntervalMs / 4))`, which bounds the worst case at
 * `timeIntervalMs + tickIntervalMs` (at most `1.25 * timeIntervalMs` at the
 * default ratio): the event can arrive up to one tick after the interval
 * last elapsed, and the checkpoint then lands at most one more tick later.
 */
import type { CheckpointManifest, CheckpointReason, Clock } from '@ald/types';

import type { CheckpointCreationResult, CheckpointCreator } from './checkpoint-service.js';
import { InvalidCheckpointRequestError } from './errors.js';

/** Opaque handle returned by {@link SchedulerTimer.setInterval}. */
export type SchedulerTimerHandle = unknown;

/** The slice of the timer API the scheduler uses; injectable for tests. */
export interface SchedulerTimer {
  setInterval(callback: () => void, ms: number): SchedulerTimerHandle;
  clearInterval(handle: SchedulerTimerHandle): void;
}

/**
 * Default timer. The interval is unref'd so a scheduler nobody stopped can
 * never be the only reason a process stays alive; the server's own listening
 * handles keep it running.
 */
export const nodeSchedulerTimer: SchedulerTimer = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface CheckpointSchedulerOptions {
  service: CheckpointCreator;
  runId: string;
  /** `RunConfig.checkpointEventInterval` (LEDGER §9 default 64). */
  eventInterval: number;
  /** `RunConfig.checkpointTimeIntervalMs` (LEDGER §9 default 300000). */
  timeIntervalMs: number;
  clock: Clock;
  /**
   * How often {@link CheckpointScheduler.tick} runs; defaults to
   * `max(1000, floor(timeIntervalMs / 4))` (see the class docstring).
   */
  tickIntervalMs?: number;
  /** Called after every completed attempt, skipped ones included. */
  onCheckpoint?(manifest: CheckpointManifest, result: CheckpointCreationResult): void;
  onError?(error: unknown): void;
  timer?: SchedulerTimer;
}

export class CheckpointScheduler {
  private readonly service: CheckpointCreator;
  private readonly runId: string;
  private readonly eventInterval: number;
  private readonly timeIntervalMs: number;
  private readonly tickIntervalMs: number;
  private readonly clock: Clock;
  private readonly timer: SchedulerTimer;
  private readonly onCheckpoint?: (
    manifest: CheckpointManifest,
    result: CheckpointCreationResult,
  ) => void;
  private readonly onError?: (error: unknown) => void;

  private eventsSinceCheckpoint = 0;
  private lastCheckpointAtMs: number;
  private chain: Promise<void> = Promise.resolve();
  private handle: SchedulerTimerHandle | undefined;

  constructor(options: CheckpointSchedulerOptions) {
    assertPositiveInteger('eventInterval', options.eventInterval);
    assertPositiveInteger('timeIntervalMs', options.timeIntervalMs);
    if (options.tickIntervalMs !== undefined) {
      assertPositiveInteger('tickIntervalMs', options.tickIntervalMs);
    }
    this.service = options.service;
    this.runId = options.runId;
    this.eventInterval = options.eventInterval;
    this.timeIntervalMs = options.timeIntervalMs;
    this.tickIntervalMs =
      options.tickIntervalMs ?? defaultTickIntervalMs(options.timeIntervalMs);
    this.clock = options.clock;
    this.timer = options.timer ?? nodeSchedulerTimer;
    this.onCheckpoint = options.onCheckpoint;
    this.onError = options.onError;
    this.lastCheckpointAtMs = this.nowMs();
  }

  /** Events counted toward the next event-interval trigger. */
  get pendingEventCount(): number {
    return this.eventsSinceCheckpoint;
  }

  /** Wall-clock instant the last checkpoint attempt was reserved at. */
  get lastCheckpointAt(): string {
    return new Date(this.lastCheckpointAtMs).toISOString();
  }

  /** Whether {@link start} has been called without a matching {@link stop}. */
  get running(): boolean {
    return this.handle !== undefined;
  }

  /**
   * Resolves once every checkpoint this scheduler has triggered so far has
   * finished. Tests await it; the orchestrator awaits it before sealing so a
   * scheduled checkpoint cannot land after the final one.
   */
  get pending(): Promise<void> {
    return this.chain;
  }

  /**
   * Records `count` accepted events. Fires an `event-interval` checkpoint as
   * soon as the configured interval is reached, then starts counting again
   * from zero, so successive checkpoints cover disjoint event ranges.
   */
  recordAcceptedEvents(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new InvalidCheckpointRequestError(
        `accepted event count must be a non-negative integer, received ${String(count)}`,
      );
    }
    this.eventsSinceCheckpoint += count;
    if (this.eventsSinceCheckpoint >= this.eventInterval) {
      this.trigger('event-interval');
    }
  }

  /**
   * Time trigger. Fires a `time-interval` checkpoint when at least
   * `timeIntervalMs` has passed since the last checkpoint and at least one
   * event has been recorded since — an idle run appends nothing, so a new
   * checkpoint would only restate the previous one.
   */
  tick(): void {
    if (this.eventsSinceCheckpoint === 0) {
      return;
    }
    if (this.nowMs() - this.lastCheckpointAtMs < this.timeIntervalMs) {
      return;
    }
    this.trigger('time-interval');
  }

  /** Starts the background timer. Idempotent. */
  start(): void {
    if (this.handle !== undefined) {
      return;
    }
    this.handle = this.timer.setInterval(() => {
      // Criterion 3: nothing thrown inside a timer callback may escape.
      try {
        this.tick();
      } catch (error) {
        this.report(error);
      }
    }, this.tickIntervalMs);
  }

  /** Stops the background timer. Idempotent; in-flight work still settles. */
  stop(): void {
    if (this.handle === undefined) {
      return;
    }
    this.timer.clearInterval(this.handle);
    this.handle = undefined;
  }

  /**
   * Runs a checkpoint through the same serialized chain as the triggers.
   *
   * `onError` and `onCheckpoint` are host-supplied observers and neither may
   * be trusted not to throw: a throwing `onCheckpoint` must not be mistaken
   * for a failed `createCheckpointIfChanged` (that would re-add `consumed`
   * for a checkpoint that was in fact written, corrupting the next window's
   * count), and a throwing `onError` must not escape into `this.chain` (that
   * would permanently reject it, silently dropping every later trigger — see
   * {@link report}). Both observers therefore run in their own try/catch,
   * entirely outside the block that decides whether the attempt failed.
   */
  private trigger(reason: CheckpointReason): void {
    const consumed = this.eventsSinceCheckpoint;
    // Reserve the window before awaiting anything: a second synchronous
    // trigger must not queue a checkpoint over the same events.
    this.eventsSinceCheckpoint = 0;
    this.lastCheckpointAtMs = this.nowMs();
    // A prior attempt may have left the chain rejected despite every catch
    // below, if something is still capable of throwing to a wider scope than
    // an observer — `.catch` here means that history can never keep this
    // trigger's attempt from running.
    this.chain = this.chain.catch(() => undefined).then(async () => {
      let result: CheckpointCreationResult | undefined;
      try {
        result = await this.service.createCheckpointIfChanged(
          this.runId,
          reason,
        );
        this.lastCheckpointAtMs = this.nowMs();
      } catch (error) {
        // The events stay pending so the next trigger retries them rather
        // than silently dropping an uncheckpointed range.
        this.eventsSinceCheckpoint += consumed;
        this.report(error);
        return;
      }
      try {
        this.onCheckpoint?.(result.manifest, result);
      } catch (error) {
        this.report(error);
      }
    });
  }

  /** Never throws: a misbehaving `onError` must not poison {@link chain}. */
  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // The scheduler owes the host a non-throwing timer callback and a
      // chain that never rejects (criterion 3); a logger that itself throws
      // has nowhere safer to report that than nowhere.
    }
  }

  private nowMs(): number {
    const parsed = Date.parse(this.clock.now());
    if (Number.isNaN(parsed)) {
      throw new InvalidCheckpointRequestError(
        'clock.now() must return an ISO-8601 timestamp',
      );
    }
    return parsed;
  }
}

/** Convenience for callers holding a validated `RunConfig`. */
export function schedulerIntervalsFromConfig(config: {
  checkpointEventInterval: number;
  checkpointTimeIntervalMs: number;
}): { eventInterval: number; timeIntervalMs: number } {
  return {
    eventInterval: config.checkpointEventInterval,
    timeIntervalMs: config.checkpointTimeIntervalMs,
  };
}

/**
 * A quarter of `timeIntervalMs`, floored at one second, so tick granularity
 * does not itself dominate the configured interval (see the class docstring
 * for the resulting worst-case bound).
 */
function defaultTickIntervalMs(timeIntervalMs: number): number {
  return Math.max(1_000, Math.floor(timeIntervalMs / 4));
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidCheckpointRequestError(
      `${field} must be a positive integer, received ${String(value)}`,
    );
  }
}
