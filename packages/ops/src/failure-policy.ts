/**
 * ALD-061 — the documented failure-handling policy (SPECIFICATION.md §14.5).
 *
 * §14.5 names four automated safety triggers, each of which "MUST cause a
 * `pause`, not a silent continue" — `maxConsecutiveRejections` exceeded, a
 * ledger fork, a Verifier run returning nonzero, and an adapter crash or
 * `turnResponseBudgetMs` timeout beyond a configurable retry budget — plus the
 * requirement that "every trigger writes a `safety-trigger` audit entry with a
 * machine-readable reason code". §14.6 adds the two termination triggers that
 * abort rather than pause.
 *
 * This module contributes three things and deliberately not a fifth trigger:
 *
 * 1. {@link FAILURE_MODE_TABLE} — the §14.5 modes as data, each naming where
 *    its handling path lives and what audit reason code it writes. The reason
 *    codes are imported from `@ald/orchestrator` rather than re-spelled, so
 *    the table cannot drift from the runtime that emits them.
 * 2. {@link installProcessFailureHandlers} — the `uncaughtException` /
 *    `unhandledRejection` handlers §14.5 requires so that a background task
 *    (checkpoint scheduler tick, anchor confirmation poll, snapshot tick)
 *    logs rather than killing the server, while a state in which the process
 *    can no longer be trusted to write correct evidence still exits.
 * 3. {@link supervise} — the wrapper background tasks run inside.
 *
 * **What this module never does:** it does not implement anchoring retry.
 * ALD-061 criterion 3 requires reuse of ALD-021's retry/backoff, so
 * `supervise`'s defaults are imported from `@ald/anchor`
 * (`DEFAULT_RETRY_ATTEMPTS`, `DEFAULT_INITIAL_BACKOFF_MS`,
 * `DEFAULT_MAX_BACKOFF_MS`) and an anchor submission is retried by
 * `BaseAnchorPublisher` itself, never here.
 *
 * **Secrecy of log content.** A thrown error's message can embed anything the
 * thrower touched — an observation, a rejected payload, a key path. SPEC §10.3
 * and §13.6 forbid writing those anywhere. Log records therefore carry the
 * error's `name`, its `code` when it has one, and a `messageDigest` (so two
 * occurrences can be correlated) but **not** the message text unless the host
 * explicitly opts in with `includeMessages`, which is documented as an
 * operator-only local-debugging switch.
 */
import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RETRY_ATTEMPTS,
} from '@ald/anchor';
import { hashCanonical } from '@ald/hashing';
import {
  ADAPTER_FAILURE_REASON,
  ANCHORING_SKIPPED_REASON,
  REJECTION_STREAK_REASON,
  SAFETY_ESCALATION_REASON,
  SIGNER_MISMATCH_REASON,
  VERIFIER_NONZERO_REASON,
} from '@ald/orchestrator';
import { HASH_DOMAINS, type Clock } from '@ald/types';

import { SupervisedTaskError } from './errors.js';

/** Domain of {@link FailureLogRecord.messageDigest}. See module doc. */
export const FAILURE_MESSAGE_DIGEST_DOMAIN = HASH_DOMAINS.failureMessage;

/** Opt-in message length cap, mirroring the orchestrator's own truncation. */
export const FAILURE_MESSAGE_LIMIT = 256;

// ---------------------------------------------------------------------------
// The §14.5 failure-mode table (ALD-061 criterion 1)
// ---------------------------------------------------------------------------

export type FailureMode =
  /** LEDGER §15 / SPEC §7.3: a stream's committed prefix does not verify. */
  | 'evidence-store-failure'
  /** LEDGER §15: two entries claim the same stream and sequence. */
  | 'ledger-fork'
  /** SPEC §13.4: the anchor could not be submitted or confirmed. */
  | 'anchoring-failure'
  /** SPEC §14.5: an adapter call threw through its whole retry budget. */
  | 'adapter-crash'
  /** SPEC §8.3/§14.5: an adapter missed `turnResponseBudgetMs`. */
  | 'adapter-timeout'
  /** SPEC §14.5: a Verifier run returned a nonzero exit code. */
  | 'verifier-nonzero'
  /** SPEC §9.4/§14.5: the rejection streak exceeded the configured maximum. */
  | 'max-consecutive-rejections'
  /** SPEC §14.5: a background task failed; the server keeps serving. */
  | 'background-task-failure';

/** Where a mode's handling path is implemented. */
export type FailureModeOwner = 'orchestrator' | 'evidence' | 'anchor' | 'ops';

/** What the system does when the mode fires. */
export type FailureModeAction =
  | 'pause'
  | 'abort'
  | 'block-writes'
  | 'sealing-blocked'
  | 'forked-invalid'
  | 'log-and-continue';

export interface FailureModeHandling {
  mode: FailureMode;
  specRef: string;
  owner: FailureModeOwner;
  action: FailureModeAction;
  /** Machine-readable `reasonCode` written to `intervention_log`, if any. */
  auditReasonCode: string | null;
  /** True when the path writes a `safety-trigger` intervention event. */
  safetyTrigger: boolean;
  notes: string;
}

/**
 * The §14.5 table as data. Every row is exercised by a test in
 * `packages/ops/__tests__/failure-policy.test.ts`: rows owned by the
 * orchestrator are driven through a real `NurseryRuntimeImpl` with a
 * fault-injected dependency and the documented outcome is asserted; the
 * `ops`-owned row is driven through a child process.
 *
 * Two honest asymmetries recorded here rather than smoothed over:
 *
 * - `verifier-nonzero` does **not** pause. The Verifier runs at seal time
 *   (`NurseryRuntimeImpl.seal`), and SPEC §7.2 has no `pause` transition out
 *   of `sealing`; the implemented path writes the `safety-trigger` entry, adds
 *   the §15.1 deviation, and records the run's disposition as `invalid`. That
 *   is stricter than a pause, not weaker — the run can never be `valid`.
 * - `anchoring-failure` reaches `sealing-blocked` rather than a pause, because
 *   §7.2 defines exactly that state for an unanchorable seal, with `retrySeal`
 *   as the resume path.
 */
export const FAILURE_MODE_TABLE: readonly FailureModeHandling[] = [
  {
    mode: 'evidence-store-failure',
    specRef: 'SPEC §7.3, §14.5; LEDGER §15',
    owner: 'evidence',
    action: 'block-writes',
    auditReasonCode: 'integrity-violation',
    safetyTrigger: true,
    notes:
      'EvidenceWriter.recover blocks every later write of the run ' +
      '(IntegrityBlockedError). The runtime writes the safety-trigger entry ' +
      'first, because a blocked writer cannot accept it afterwards. A signer ' +
      `registry that no longer matches the run is the same class of failure and uses "${SIGNER_MISMATCH_REASON}".`,
  },
  {
    mode: 'ledger-fork',
    specRef: 'SPEC §7.3, §14.5; LEDGER §15',
    owner: 'evidence',
    action: 'forked-invalid',
    auditReasonCode: 'integrity-violation',
    safetyTrigger: true,
    notes:
      'Both conflicting artifacts are preserved in fork_artifacts and the run ' +
      'transitions to forked-invalid; the evidence stays in the run index ' +
      '(§14.6) and is invalid for interpretation until a review is logged.',
  },
  {
    mode: 'anchoring-failure',
    specRef: 'SPEC §7.2, §13.4, §14.5; LEDGER §16',
    owner: 'anchor',
    action: 'sealing-blocked',
    auditReasonCode: null,
    safetyTrigger: false,
    notes:
      'BaseAnchorPublisher owns the send retry/backoff and the confirmation ' +
      'poll budget (ALD-021); the runtime records an anchor-unavailable ' +
      'deviation and enters sealing-blocked, from which retrySeal resumes. ' +
      'A prototype-mode run with no publisher at all records the audited ' +
      `governance decision "${ANCHORING_SKIPPED_REASON}" instead.`,
  },
  {
    mode: 'adapter-crash',
    specRef: 'SPEC §14.5',
    owner: 'orchestrator',
    action: 'pause',
    auditReasonCode: ADAPTER_FAILURE_REASON,
    safetyTrigger: true,
    notes:
      'One retry by default (DEFAULT_ADAPTER_RETRY_BUDGET), never unbounded — ' +
      'an unbounded retry loop is itself the timing side channel §14.5 ' +
      'forbids. The turn is forfeited with a recorded turn record and the run ' +
      'pauses. When §7.2 offers no pause from the current state the trigger ' +
      `escalates to abort with "${SAFETY_ESCALATION_REASON}".`,
  },
  {
    mode: 'adapter-timeout',
    specRef: 'SPEC §8.3, §14.5',
    owner: 'orchestrator',
    action: 'pause',
    auditReasonCode: ADAPTER_FAILURE_REASON,
    safetyTrigger: true,
    notes:
      'A missed turnResponseBudgetMs deadline is surfaced as the same ' +
      'AdapterFailureError as a crash, so timeout and crash are ' +
      'indistinguishable to an observer (§10.3) and share one handling path.',
  },
  {
    mode: 'verifier-nonzero',
    specRef: 'SPEC §14.5, §15.1',
    owner: 'orchestrator',
    action: 'log-and-continue',
    auditReasonCode: VERIFIER_NONZERO_REASON,
    safetyTrigger: true,
    notes:
      'Runs at seal time, where §7.2 has no pause transition: the trigger ' +
      'writes its safety-trigger entry, appends the §15.1 deviation, and the ' +
      'Experiment Record disposition becomes invalid. The run is never ' +
      'presented as valid.',
  },
  {
    mode: 'max-consecutive-rejections',
    specRef: 'SPEC §9.4, §14.5',
    owner: 'orchestrator',
    action: 'pause',
    auditReasonCode: REJECTION_STREAK_REASON,
    safetyTrigger: true,
    notes:
      'The Gateway counts consecutive rejections; the runtime pauses and the ' +
      'counter restarts only when an operator resumes.',
  },
  {
    mode: 'background-task-failure',
    specRef: 'SPEC §14.5',
    owner: 'ops',
    action: 'log-and-continue',
    auditReasonCode: null,
    safetyTrigger: false,
    notes:
      'A checkpoint-scheduler tick, anchor confirmation poll, or snapshot ' +
      'tick that throws or rejects is caught by supervise()/the process ' +
      'handlers, logged, and counted. The server keeps serving; no run state ' +
      'changes, because a failed background task is not evidence about a run.',
  },
];

/** Look up one row. Throws on an unknown mode so the table stays exhaustive. */
export function failureModeHandling(mode: FailureMode): FailureModeHandling {
  const row = FAILURE_MODE_TABLE.find((entry) => entry.mode === mode);
  if (row === undefined) {
    throw new Error(`No §14.5 handling row for failure mode "${mode}"`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

export type FailureSource =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'background-task';

export interface FailureLogRecord {
  version: 1;
  recordedAt: string;
  level: 'warn' | 'error';
  source: FailureSource;
  /** The error's own `code` when it has one, else its constructor name. */
  code: string;
  name: string;
  /** Domain-separated digest of the message; never the message itself. */
  messageDigest: string;
  /** Present only when the host opted in with `includeMessages`. */
  message?: string;
  taskName?: string;
  attempts?: number;
  /** Whether the policy classified this as a state the process cannot serve in. */
  fatal: boolean;
}

export interface StructuredLogger {
  log(record: FailureLogRecord): void;
}

/** Collects records in memory. Used by tests and by the child-process fixture. */
export class InMemoryFailureLogger implements StructuredLogger {
  readonly records: FailureLogRecord[] = [];

  log(record: FailureLogRecord): void {
    this.records.push(record);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : error.name;
  }
  return typeof error;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return '<unstringifiable>';
  }
}

export interface BuildFailureRecordOptions {
  source: FailureSource;
  error: unknown;
  clock: Clock;
  fatal: boolean;
  includeMessages?: boolean;
  taskName?: string;
  attempts?: number;
}

/** Builds one log record under the secrecy rules in this module's doc. */
export function buildFailureRecord(
  options: BuildFailureRecordOptions,
): FailureLogRecord {
  const message = errorMessage(options.error);
  return {
    version: 1,
    recordedAt: options.clock.now(),
    level: options.fatal ? 'error' : 'warn',
    source: options.source,
    code: errorCode(options.error),
    name: errorName(options.error),
    messageDigest: hashCanonical(FAILURE_MESSAGE_DIGEST_DOMAIN, message),
    ...(options.includeMessages === true
      ? { message: message.slice(0, FAILURE_MESSAGE_LIMIT) }
      : {}),
    ...(options.taskName === undefined ? {} : { taskName: options.taskName }),
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    fatal: options.fatal,
  };
}

// ---------------------------------------------------------------------------
// Fatality policy
// ---------------------------------------------------------------------------

/**
 * The documented fatal set: states in which the process can no longer be
 * trusted to write correct evidence, so continuing to serve would produce
 * evidence that looks committed and is not (SPEC §14.6 "termination triggers
 * requiring immediate abort: repeated integrity failure, ... resource
 * exhaustion").
 *
 * Everything else — an adapter fault, a failed anchor poll, a scheduler tick,
 * a telemetry write, a route handler bug — is non-fatal by policy: §14.5
 * requires those to log rather than crash the server.
 */
export const FATAL_ERROR_CODES: readonly string[] = [
  // SQLite says the store itself is damaged, read-only, or out of space.
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'SQLITE_IOERR',
  'SQLITE_FULL',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  // The filesystem the evidence store lives on can no longer be written.
  'ENOSPC',
  'EROFS',
  'EIO',
  // The process is out of memory or its heap is unusable.
  'ERR_WORKER_OUT_OF_MEMORY',
];

/** Marker any caller can set to force the fatal path for its own error. */
export const FATAL_ERROR_MARKER = 'aldFatal';

/**
 * Default classification. An error is fatal when it carries
 * `aldFatal === true` or its `code` is in {@link FATAL_ERROR_CODES}, and
 * `RangeError`s named `RangeError: Maximum call stack size exceeded` are
 * deliberately *not* fatal — a runaway recursion in one request is a bug to
 * log, not a reason to drop every other run.
 */
export function isFatalFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const marked = (error as Record<string, unknown>)[FATAL_ERROR_MARKER];
    if (marked === true) {
      return true;
    }
  }
  return FATAL_ERROR_CODES.includes(errorCode(error));
}

// ---------------------------------------------------------------------------
// Process handlers
// ---------------------------------------------------------------------------

/** The `process` slice {@link installProcessFailureHandlers} needs. */
export interface FailureHostProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): never;
}

export interface ProcessFailureHandlerOptions {
  logger: StructuredLogger;
  clock?: Clock;
  process?: FailureHostProcess;
  /** Overrides {@link isFatalFailure}. */
  isFatal?: (error: unknown) => boolean;
  /**
   * Called for a fatal classification. The default exits with
   * {@link FATAL_EXIT_CODE}; a host that wants to drain connections first
   * supplies its own and calls `process.exit` when ready.
   */
  onFatal?: (record: FailureLogRecord, error: unknown) => void;
  includeMessages?: boolean;
}

/** `EX_SOFTWARE` from sysexits(3): an internal software error. */
export const FATAL_EXIT_CODE = 70;

export interface ProcessFailureHandlers {
  uninstall(): void;
  /** Non-fatal failures logged since install. */
  readonly loggedCount: number;
  /** Fatal classifications since install. */
  readonly fatalCount: number;
}

/**
 * SPEC §14.5: registers `uncaughtException` and `unhandledRejection` so a
 * background task cannot crash the server.
 *
 * The handler itself is written not to throw: a logger that throws is
 * swallowed, because a failure handler that fails would turn a logged warning
 * into the crash it exists to prevent.
 */
export function installProcessFailureHandlers(
  options: ProcessFailureHandlerOptions,
): ProcessFailureHandlers {
  const host = options.process ?? (process as unknown as FailureHostProcess);
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() };
  const classify = options.isFatal ?? isFatalFailure;
  let logged = 0;
  let fatalCount = 0;

  const handle = (source: FailureSource, error: unknown): void => {
    const fatal = safely(() => classify(error), false);
    const record = safely(
      () =>
        buildFailureRecord({
          source,
          error,
          clock,
          fatal,
          ...(options.includeMessages === undefined
            ? {}
            : { includeMessages: options.includeMessages }),
        }),
      undefined,
    );
    if (record !== undefined) {
      safely(() => {
        options.logger.log(record);
        return undefined;
      }, undefined);
    }
    if (fatal) {
      fatalCount += 1;
      if (options.onFatal === undefined) {
        host.exit(FATAL_EXIT_CODE);
      } else if (record !== undefined) {
        safely(() => {
          options.onFatal?.(record, error);
          return undefined;
        }, undefined);
      }
      return;
    }
    logged += 1;
  };

  const onUncaught = (...args: unknown[]): void => {
    handle('uncaughtException', args[0]);
  };
  const onRejection = (...args: unknown[]): void => {
    handle('unhandledRejection', args[0]);
  };

  host.on('uncaughtException', onUncaught);
  host.on('unhandledRejection', onRejection);

  return {
    uninstall: () => {
      host.off?.('uncaughtException', onUncaught);
      host.off?.('unhandledRejection', onRejection);
    },
    get loggedCount() {
      return logged;
    },
    get fatalCount() {
      return fatalCount;
    },
  };
}

function safely<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Background-task supervision
// ---------------------------------------------------------------------------

export interface SuperviseRetryOptions {
  /** Total attempts, including the first. Default: `@ald/anchor`'s. */
  attempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable delay so tests never wait. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface SuperviseOptions {
  name: string;
  logger?: StructuredLogger;
  clock?: Clock;
  retry?: SuperviseRetryOptions;
  includeMessages?: boolean;
  /** Called once with the terminal failure after the budget is exhausted. */
  onFailure?: (error: SupervisedTaskError, record: FailureLogRecord) => void;
}

export interface SuperviseResult<T> {
  ok: boolean;
  value?: T;
  attempts: number;
  error?: SupervisedTaskError;
}

/**
 * Runs one background task under the §14.5 policy: retry within a bounded
 * budget, log every attempt's failure, and resolve — never reject — so a
 * `setInterval` callback that forgets to `await` cannot produce an
 * `unhandledRejection`.
 *
 * The retry defaults come from `@ald/anchor` (ALD-021) rather than from a
 * second ad hoc schedule (ALD-061 criterion 3). Anchor *submission* is not
 * supervised here at all: `BaseAnchorPublisher` retries its own sends and
 * keeps its own crash-durable pending sidecar.
 */
export async function supervise<T>(
  task: () => Promise<T> | T,
  options: SuperviseOptions,
): Promise<SuperviseResult<T>> {
  const attempts = options.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('retry.attempts must be at least 1');
  }
  const initialBackoffMs =
    options.retry?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep =
    options.retry?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds).unref?.();
      }));
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() };

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: await task(), attempts: attempt };
    } catch (error) {
      lastError = error;
      const record = buildFailureRecord({
        source: 'background-task',
        error,
        clock,
        fatal: false,
        taskName: options.name,
        attempts: attempt,
        ...(options.includeMessages === undefined
          ? {}
          : { includeMessages: options.includeMessages }),
      });
      safely(() => {
        options.logger?.log(record);
        return undefined;
      }, undefined);
      if (attempt < attempts) {
        await sleep(
          Math.min(maxBackoffMs, initialBackoffMs * 2 ** (attempt - 1)),
        );
      }
    }
  }

  const failure = new SupervisedTaskError(options.name, attempts, lastError);
  const record = buildFailureRecord({
    source: 'background-task',
    error: failure,
    clock,
    fatal: false,
    taskName: options.name,
    attempts,
    ...(options.includeMessages === undefined
      ? {}
      : { includeMessages: options.includeMessages }),
  });
  safely(() => {
    options.onFailure?.(failure, record);
    return undefined;
  }, undefined);
  return { ok: false, attempts, error: failure };
}
