/** Process-level crash protection for the periodic checkpoint timer (ALD-014). */
import {
  CheckpointScheduler,
  type CheckpointSchedulerOptions,
} from '@ald/checkpoint';

import {
  buildFailureRecord,
  installProcessFailureHandlers,
  type FailureHostProcess,
  type ProcessFailureHandlers,
  type StructuredLogger,
} from './failure-policy.js';

export interface ProtectedCheckpointSchedulerOptions
  extends Omit<CheckpointSchedulerOptions, 'onError'> {
  logger: StructuredLogger;
  process?: FailureHostProcess;
  includeMessages?: boolean;
}

export interface ProtectedCheckpointScheduler {
  scheduler: CheckpointScheduler;
  failureHandlers: ProcessFailureHandlers;
  stop(): void;
}

/**
 * Starts the timer only after both process-wide failure handlers are installed.
 * Scheduler failures are logged as non-fatal background tasks and never escape.
 */
export function startProtectedCheckpointScheduler(
  options: ProtectedCheckpointSchedulerOptions,
): ProtectedCheckpointScheduler {
  const failureHandlers = installProcessFailureHandlers({
    logger: options.logger,
    clock: options.clock,
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.includeMessages === undefined
      ? {}
      : { includeMessages: options.includeMessages }),
  });
  const scheduler = new CheckpointScheduler({
    service: options.service,
    runId: options.runId,
    eventInterval: options.eventInterval,
    timeIntervalMs: options.timeIntervalMs,
    clock: options.clock,
    ...(options.tickIntervalMs === undefined
      ? {}
      : { tickIntervalMs: options.tickIntervalMs }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    ...(options.onCheckpoint === undefined
      ? {}
      : { onCheckpoint: options.onCheckpoint }),
    onError: (error) => {
      try {
        options.logger.log(
          buildFailureRecord({
            source: 'background-task',
            error,
            clock: options.clock,
            fatal: false,
            taskName: 'checkpoint-scheduler',
            ...(options.includeMessages === undefined
              ? {}
              : { includeMessages: options.includeMessages }),
          }),
        );
      } catch {
        // A logger failure cannot turn a checkpoint scheduling error into a crash.
      }
    },
  });
  scheduler.start();
  return {
    scheduler,
    failureHandlers,
    stop() {
      scheduler.stop();
      failureHandlers.uninstall();
    },
  };
}
