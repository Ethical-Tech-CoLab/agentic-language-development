/**
 * ALD-061 — failure handling policy (SPECIFICATION.md §14.5).
 *
 * Criterion 1: every failure mode named in §14.5 has an implemented, tested
 * handling path. Rows of {@link FAILURE_MODE_TABLE} owned by the orchestrator
 * are driven through a real `NurseryRuntimeImpl` with a fault-injected
 * dependency and the documented outcome is asserted; the `ops`-owned row is
 * driven through this module's own supervision and process handlers.
 *
 * Criterion 2: an unhandled rejection from a background task is caught,
 * logged, and does not crash the server — proved in a real child process.
 *
 * Criterion 3 (already `[x]` in BACKLOG): anchoring failures reuse ALD-021's
 * retry/backoff. Asserted here by construction: `supervise`'s defaults are
 * the `@ald/anchor` constants, and nothing in `@ald/ops` retries an anchor
 * submission.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RETRY_ATTEMPTS,
} from '@ald/anchor';
import { SqliteEvidenceWriter } from '@ald/evidence';
import {
  ADAPTER_FAILURE_REASON,
  REJECTION_STREAK_REASON,
  VERIFIER_NONZERO_REASON,
} from '@ald/orchestrator';
import type { LedgerEventDraft } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildFailureRecord,
  FAILURE_MODE_TABLE,
  FATAL_ERROR_CODES,
  FATAL_ERROR_MARKER,
  FATAL_EXIT_CODE,
  failureModeHandling,
  InMemoryFailureLogger,
  installProcessFailureHandlers,
  isFatalFailure,
  supervise,
  type FailureHostProcess,
  type FailureMode,
} from '@ald/ops';

import {
  createHarness,
  factoryFor,
  fakeVerifier,
  noLearningConfig,
  AlwaysRejectedAdapter,
  CrashingAdapter,
  FixedClock,
  StepClock,
  TimingOutAdapter,
  type Harness,
} from './support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const HYPOTHESIS_DRAFT: LedgerEventDraft = {
  eventType: 'hypothesis.created',
  contentSchema: 'agent-native-ledger',
  subjectId: 'symbol:S01',
  content: { hypothesisRef: 'hyp:conflict' },
  blindingNonce: 'nonce:conflict',
  evidenceRefs: [],
};

/** A `process` double that records exits instead of taking them. */
function fakeProcess(): {
  host: FailureHostProcess;
  emit(event: string, error: unknown): void;
  exits: number[];
  listenerCount(): number;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const exits: number[] = [];
  return {
    host: {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return undefined;
      },
      off: (event, listener) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        );
        return undefined;
      },
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as never,
    },
    emit: (event, error) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(error);
      }
    },
    exits,
    listenerCount: () =>
      [...listeners.values()].reduce((total, list) => total + list.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Criterion 1: the table
// ---------------------------------------------------------------------------

describe('ALD-061 criterion 1: the §14.5 failure-mode table', () => {
  it('ALD-061: every §14.5 named failure mode has exactly one handling row', () => {
    const expected: FailureMode[] = [
      'evidence-store-failure',
      'ledger-fork',
      'anchoring-failure',
      'adapter-crash',
      'adapter-timeout',
      'verifier-nonzero',
      'max-consecutive-rejections',
      'background-task-failure',
    ];
    expect(FAILURE_MODE_TABLE.map((row) => row.mode)).toEqual(expected);
    expect(new Set(FAILURE_MODE_TABLE.map((row) => row.mode)).size).toBe(
      expected.length,
    );
    for (const mode of expected) {
      const row = failureModeHandling(mode);
      expect(row.specRef).toMatch(/§14\.5|§7\.3|§13\.4|§8\.3|§9\.4/u);
      expect(row.notes.length).toBeGreaterThan(40);
    }
    expect(() => failureModeHandling('nope' as FailureMode)).toThrowError(
      /No §14\.5 handling row/u,
    );
  });

  it('ALD-061: the table quotes the orchestrator reason codes rather than re-spelling them', () => {
    expect(failureModeHandling('adapter-crash').auditReasonCode).toBe(
      ADAPTER_FAILURE_REASON,
    );
    expect(failureModeHandling('adapter-timeout').auditReasonCode).toBe(
      ADAPTER_FAILURE_REASON,
    );
    expect(
      failureModeHandling('max-consecutive-rejections').auditReasonCode,
    ).toBe(REJECTION_STREAK_REASON);
    expect(failureModeHandling('verifier-nonzero').auditReasonCode).toBe(
      VERIFIER_NONZERO_REASON,
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 1: orchestrator-owned rows, driven with fault injection
// ---------------------------------------------------------------------------

describe('ALD-061 criterion 1: orchestrator-owned §14.5 paths', () => {
  it('ALD-061 max-consecutive-rejections: the run pauses with the documented reason code', async () => {
    harness = await createHarness({
      adapterFactoryFor: () => factoryFor(() => new AlwaysRejectedAdapter()),
    });
    const runId = 'fp-rejections';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-rejections',
        maxTurnsPerRun: 20,
        evaluationTurns: 2,
        maxConsecutiveRejections: 2,
      }),
    );
    await harness.runtime.step(runId);
    const second = await harness.runtime.step(runId);

    const row = failureModeHandling('max-consecutive-rejections');
    expect(row.action).toBe('pause');
    expect(second.state).toBe('paused');
    const audit = harness.runtime.auditLog(runId);
    const trigger = audit.find(
      (event) =>
        event.eventType === 'safety-trigger' &&
        event.reasonCode === row.auditReasonCode,
    );
    expect(trigger).toBeDefined();
    expect(row.safetyTrigger).toBe(true);
    // §7.3/§14.2: the pause produced its mandatory checkpoint.
    expect(
      harness.runtime.checkpoints(runId).some((m) => m.reason === 'pause'),
    ).toBe(true);
  }, 60_000);

  it('ALD-061 adapter-crash: the turn is forfeited, audited, and the run pauses', async () => {
    const crashing = new CrashingAdapter();
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        factoryFor(() =>
          role === 'baby-a' ? crashing : new AlwaysRejectedAdapter(),
        ),
      retryBudget: 1,
    });
    const runId = 'fp-crash';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-crash',
        maxTurnsPerRun: 20,
        evaluationTurns: 2,
      }),
    );
    const result = await harness.runtime.step(runId);

    const row = failureModeHandling('adapter-crash');
    expect(row.action).toBe('pause');
    expect(result.outcome.success).toBe(false);
    expect(result.state).toBe('paused');
    // The retry budget is bounded, never unbounded (§14.5).
    expect(crashing.calls).toBe(2);
    const trigger = harness.runtime
      .auditLog(runId)
      .find(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === row.auditReasonCode,
      );
    expect(trigger).toBeDefined();
    // §10.3: the audit entry carries no adapter payload, only a bounded detail.
    expect(Object.keys(trigger?.details ?? {}).sort()).toEqual([
      'attempts',
      'errorName',
      'message',
      'method',
      'phase',
      'role',
      'turn',
    ]);
    // Even a forfeited turn produces a turn record (§8.1).
    expect(harness.runtime.turnRecords(runId)).toHaveLength(1);
  }, 60_000);

  it('ALD-061 adapter-timeout: an over-budget turn takes the same path as a crash', async () => {
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        factoryFor(() =>
          role === 'baby-a'
            ? new TimingOutAdapter(2_500)
            : new AlwaysRejectedAdapter(),
        ),
    });
    const runId = 'fp-timeout';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-timeout',
        maxTurnsPerRun: 20,
        evaluationTurns: 2,
        turnResponseBudgetMs: 1_000,
      }),
    );
    const result = await harness.runtime.step(runId);

    expect(failureModeHandling('adapter-timeout').action).toBe('pause');
    expect(result.outcome.success).toBe(false);
    // §8.3: the deadline turns into a channel rejection with reason `timeout`.
    const rejected = harness.runtime
      .transcript(runId)
      .filter((event) => event.gatewayValidationResult === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reasonCode).toBe('timeout');
    expect(harness.runtime.turnRecords(runId)).toHaveLength(1);
  }, 60_000);

  it('ALD-061 verifier-nonzero: the trigger is audited and the run is never valid', async () => {
    const runId = 'fp-verifier';
    harness = await createHarness({ verifier: fakeVerifier(runId, 1) });
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-verifier',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
        communicationCondition: 'disabled',
      }),
    );
    await harness.runtime.runToCompletion(runId);

    const row = failureModeHandling('verifier-nonzero');
    expect(row.action).toBe('log-and-continue');
    const trigger = harness.runtime
      .auditLog(runId)
      .find(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === row.auditReasonCode,
      );
    expect(trigger).toBeDefined();
    const record = harness.runtime.experimentRecords(runId).at(-1);
    expect(record?.disposition).toBe('invalid');
    expect(record?.deviations.some((d) => /[Vv]erifier/u.test(d))).toBe(true);
  }, 90_000);

  it('ALD-061 ledger-fork / evidence-store-failure: both artifacts are preserved and writes are blocked', async () => {
    harness = await createHarness();
    const runId = 'fp-fork';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-fork',
        maxTurnsPerRun: 20,
        evaluationTurns: 2,
      }),
    );
    await harness.runtime.step(runId);
    await harness.runtime.step(runId);

    const primary = harness.runtime.writerFor(runId);
    const rival = new SqliteEvidenceWriter({
      database: harness.database,
      signers: harness.signerProvider(runId),
      clock: new StepClock(Date.UTC(2030, 0, 1)),
      softwareCommit: 'git:rival-writer',
    });
    const settled = await Promise.allSettled([
      primary.appendLedgerEvent({
        runId,
        babyId: 'A',
        turn: 2,
        draft: HYPOTHESIS_DRAFT,
      }),
      rival.appendLedgerEvent({
        runId,
        babyId: 'A',
        turn: 2,
        draft: HYPOTHESIS_DRAFT,
      }),
    ]);
    expect(settled.some((result) => result.status === 'rejected')).toBe(true);

    // LEDGER §15: both conflicting artifacts are preserved.
    const artifacts = primary.readForkArtifacts(runId);
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
    expect(failureModeHandling('ledger-fork').action).toBe('forked-invalid');
    expect(failureModeHandling('evidence-store-failure').action).toBe(
      'block-writes',
    );

    const summary = await harness.runtime.recover(runId);
    expect(summary.state).toBe('forked-invalid');
    // §14.6: the run index entry survives; only interpretation is invalid.
    expect(primary.readRunMetadata(runId)).toBeDefined();
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );
  }, 90_000);

  it('ALD-061 anchoring-failure: prototype mode records the audited governance decision', async () => {
    harness = await createHarness();
    const runId = 'fp-anchor';
    await harness.runtime.createRun(
      noLearningConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-fp-anchor',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
        communicationCondition: 'disabled',
      }),
    );
    await harness.runtime.runToCompletion(runId);

    const row = failureModeHandling('anchoring-failure');
    expect(row.owner).toBe('anchor');
    expect(row.notes).toContain('BaseAnchorPublisher');
    const decision = harness.runtime
      .auditLog(runId)
      .find((event) => event.eventType === 'governance-decision');
    expect(decision?.reasonCode).toBe('anchoring-skipped-prototype-mode');
    const record = harness.runtime.experimentRecords(runId).at(-1);
    expect(record?.disposition).not.toBe('valid');
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Structured logging and fatality policy
// ---------------------------------------------------------------------------

describe('ALD-061: structured failure records never carry payload text', () => {
  it('ALD-061: the record digests the message instead of storing it', () => {
    const record = buildFailureRecord({
      source: 'unhandledRejection',
      error: Object.assign(new Error('observation payload [1,2,3] leaked'), {
        code: 'E_SECRET',
      }),
      clock: new FixedClock(),
      fatal: false,
    });
    expect(record).toMatchObject({
      version: 1,
      level: 'warn',
      source: 'unhandledRejection',
      code: 'E_SECRET',
      name: 'Error',
      fatal: false,
    });
    expect(record.message).toBeUndefined();
    expect(record.messageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(record)).not.toContain('1,2,3');

    // The same message digests the same way, so occurrences correlate.
    const again = buildFailureRecord({
      source: 'uncaughtException',
      error: new Error('observation payload [1,2,3] leaked'),
      clock: new FixedClock(),
      fatal: false,
    });
    expect(again.messageDigest).toBe(record.messageDigest);
  });

  it('ALD-061: includeMessages is opt-in and bounded', () => {
    const record = buildFailureRecord({
      source: 'background-task',
      error: new Error('x'.repeat(1_000)),
      clock: new FixedClock(),
      fatal: false,
      includeMessages: true,
      taskName: 'anchor-poll',
      attempts: 2,
    });
    expect(record.message).toHaveLength(256);
    expect(record.taskName).toBe('anchor-poll');
    expect(record.attempts).toBe(2);
  });

  it('ALD-061: the fatal set is exactly the documented evidence-integrity states', () => {
    for (const code of FATAL_ERROR_CODES) {
      expect(isFatalFailure(Object.assign(new Error('x'), { code }))).toBe(true);
    }
    expect(isFatalFailure(new Error('an adapter blew up'))).toBe(false);
    expect(isFatalFailure(new RangeError('Maximum call stack size exceeded'))).toBe(
      false,
    );
    expect(
      isFatalFailure(Object.assign(new Error('x'), { [FATAL_ERROR_MARKER]: true })),
    ).toBe(true);
    expect(isFatalFailure('a string')).toBe(false);
  });
});

describe('ALD-061 criterion 2: process handlers keep the server alive', () => {
  it('ALD-061: an unhandled rejection from a background task is logged, not fatal', () => {
    const logger = new InMemoryFailureLogger();
    const host = fakeProcess();
    const handlers = installProcessFailureHandlers({
      logger,
      clock: new FixedClock(),
      process: host.host,
    });

    host.emit('unhandledRejection', new Error('anchor confirmation poll failed'));
    host.emit('uncaughtException', new Error('checkpoint scheduler tick failed'));

    expect(handlers.loggedCount).toBe(2);
    expect(handlers.fatalCount).toBe(0);
    expect(host.exits).toEqual([]);
    expect(logger.records.map((record) => record.source)).toEqual([
      'unhandledRejection',
      'uncaughtException',
    ]);
    expect(logger.records.every((record) => record.fatal === false)).toBe(true);

    handlers.uninstall();
    expect(host.listenerCount()).toBe(0);
  });

  it('ALD-061: a fatal state exits with the documented code', () => {
    const logger = new InMemoryFailureLogger();
    const host = fakeProcess();
    const handlers = installProcessFailureHandlers({
      logger,
      clock: new FixedClock(),
      process: host.host,
    });
    host.emit(
      'uncaughtException',
      Object.assign(new Error('evidence store is corrupt'), {
        code: 'SQLITE_CORRUPT',
      }),
    );
    expect(handlers.fatalCount).toBe(1);
    expect(host.exits).toEqual([FATAL_EXIT_CODE]);
    expect(logger.records[0]?.level).toBe('error');
    expect(logger.records[0]?.fatal).toBe(true);
    handlers.uninstall();
  });

  it('ALD-061: a host-supplied onFatal replaces the exit so it can drain first', () => {
    const logger = new InMemoryFailureLogger();
    const host = fakeProcess();
    const seen: string[] = [];
    installProcessFailureHandlers({
      logger,
      clock: new FixedClock(),
      process: host.host,
      onFatal: (record) => seen.push(record.code),
    });
    host.emit(
      'uncaughtException',
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    );
    expect(seen).toEqual(['ENOSPC']);
    expect(host.exits).toEqual([]);
  });

  it('ALD-061: a logger that itself throws cannot turn a warning into a crash', () => {
    const host = fakeProcess();
    const handlers = installProcessFailureHandlers({
      logger: {
        log: () => {
          throw new Error('logger is broken');
        },
      },
      clock: new FixedClock(),
      process: host.host,
    });
    expect(() =>
      host.emit('unhandledRejection', new Error('background task failed')),
    ).not.toThrow();
    expect(handlers.loggedCount).toBe(1);
    expect(host.exits).toEqual([]);
  });

  it('ALD-061 criterion 2: a real child process survives an unhandled rejection from a background task', async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/unhandled-rejection-child.ts', import.meta.url),
    );
    const output = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
            fixture,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout }));
        setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('child process did not exit in time'));
        }, 30_000).unref();
      },
    );

    expect(output.code).toBe(0);
    const lines = output.stdout.trim().split('\n');
    const summary = JSON.parse(lines.at(-1) ?? '{}') as {
      survived: boolean;
      logged: number;
      fatal: number;
      sources: string[];
      messagesLogged: number;
    };
    expect(summary.survived).toBe(true);
    expect(summary.logged).toBeGreaterThanOrEqual(1);
    expect(summary.fatal).toBe(0);
    expect(summary.sources).toContain('unhandledRejection');
    // §10.3/§13.6: no message text was written to the log record.
    expect(summary.messagesLogged).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Supervision (criterion 3 reuse, and the ops-owned table row)
// ---------------------------------------------------------------------------

describe('ALD-061: supervise() for background tasks', () => {
  it('ALD-061 criterion 3: the retry budget is ALD-021’s, not a second ad hoc one', async () => {
    const logger = new InMemoryFailureLogger();
    const slept: number[] = [];
    let calls = 0;
    const result = await supervise(
      () => {
        calls += 1;
        throw new Error('rpc endpoint unavailable');
      },
      {
        name: 'anchor-confirmation-poll',
        logger,
        clock: new FixedClock(),
        retry: {
          sleep: async (ms) => {
            slept.push(ms);
          },
        },
      },
    );

    expect(calls).toBe(DEFAULT_RETRY_ATTEMPTS);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(DEFAULT_RETRY_ATTEMPTS);
    expect(result.error?.code).toBe('supervised-task-failed');
    // Exponential backoff bounded by the anchor package's own ceiling.
    expect(slept).toEqual(
      Array.from({ length: DEFAULT_RETRY_ATTEMPTS - 1 }, (_unused, index) =>
        Math.min(DEFAULT_MAX_BACKOFF_MS, DEFAULT_INITIAL_BACKOFF_MS * 2 ** index),
      ),
    );
    expect(logger.records).toHaveLength(DEFAULT_RETRY_ATTEMPTS);
    expect(logger.records.every((record) => record.fatal === false)).toBe(true);
    expect(
      logger.records.every(
        (record) => record.taskName === 'anchor-confirmation-poll',
      ),
    ).toBe(true);
  });

  it('ALD-061: a task that recovers on a later attempt resolves with its value', async () => {
    let calls = 0;
    const result = await supervise(
      () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('transient');
        }
        return 'checkpointed';
      },
      {
        name: 'checkpoint-tick',
        clock: new FixedClock(),
        retry: { sleep: async () => undefined },
      },
    );
    expect(result).toEqual({ ok: true, value: 'checkpointed', attempts: 3 });
  });

  it('ALD-061: supervise never rejects, so a forgotten await cannot crash the host', async () => {
    const failures: string[] = [];
    const result = await supervise(
      () => Promise.reject(new Error('always fails')),
      {
        name: 'snapshot-tick',
        clock: new FixedClock(),
        retry: { attempts: 1 },
        onFailure: (error) => failures.push(error.taskName),
      },
    );
    expect(result.ok).toBe(false);
    expect(failures).toEqual(['snapshot-tick']);
    expect(failureModeHandling('background-task-failure').action).toBe(
      'log-and-continue',
    );
  });

  it('ALD-061: an invalid retry budget is refused rather than silently widened', async () => {
    await expect(
      supervise(() => undefined, { name: 't', retry: { attempts: 0 } }),
    ).rejects.toThrowError(/at least 1/u);
  });
});
