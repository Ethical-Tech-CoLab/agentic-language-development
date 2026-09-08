/**
 * ALD-058 — the telemetry event pipeline (SPECIFICATION.md §14.1).
 *
 * §14.1: "The Nursery Controller dashboard records every API request (method,
 * path, status, duration) in the existing DTSF telemetry log, plus run-specific
 * metrics: turns/minute, rejection rate, affect-window utilization, checkpoint
 * latency, and anchor-confirmation latency." The per-request half lives here;
 * the run-metric half is computed on demand from the evidence store in
 * `metrics.ts`, because §13/§14.6 make the evidence store — not a telemetry
 * table — the authoritative source for anything about a run.
 *
 * Three properties this module owes its callers:
 *
 * 1. **`path` is the matched route pattern, never the raw request path.**
 *    A raw path carries run ids and, on the Baby routes, ids drawn from
 *    scenario state; a pattern (`/runs/:id/step`) carries none. The run id is
 *    stored in its own `runId` column so a dashboard can still filter by run
 *    (criterion 3) without the telemetry log becoming a second, unaudited
 *    copy of run content (SPEC §13.6, §14.6).
 * 2. **Recording never blocks or fails the request** (criterion 2). `record()`
 *    is synchronous-by-contract, returns `void`, and every implementation here
 *    swallows its own failures into `errorCount`. {@link guardTelemetrySink}
 *    additionally contains a sink that throws, returns a rejecting promise, or
 *    returns a promise that never settles — the caller neither awaits nor sees
 *    any of it.
 * 3. **The telemetry store is never the evidence store.** `SqliteTelemetrySink`
 *    opens its own SQLite file with its own append-only triggers. Nothing in
 *    this module can write to `ald.sqlite`.
 *
 * No telemetry record ever reaches a Baby context, and none carries an
 * observation, a proposal, a rejected payload, or free text.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '@ald/types';

import { TelemetryError } from './errors.js';

/** Bumped only if the stored record shape changes incompatibly. */
export const TELEMETRY_RECORD_VERSION = 1;

const isoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { message: 'must be an ISO-8601 timestamp' },
);
const nonEmptyString = z.string().min(1);

/**
 * One recorded API request (SPEC §14.1). `path` is the route pattern; `runId`
 * and `actorRole` are the two run/authorization dimensions a dashboard needs
 * and are the only request-derived values stored beyond the four §14.1 fields.
 */
export const TelemetryRecordSchema = z
  .object({
    version: z.literal(TELEMETRY_RECORD_VERSION),
    recordedAt: isoDateTime,
    /** DTSF twin name: `nursery`, `baby-a`, `baby-b`. */
    twin: nonEmptyString,
    method: nonEmptyString,
    /** Matched route PATTERN (`/runs/:id/step`), never the raw path. */
    path: nonEmptyString,
    status: z.number().int().min(100).max(599),
    durationMs: z.number().min(0).finite(),
    runId: nonEmptyString.optional(),
    actorRole: nonEmptyString.optional(),
  })
  .strict();

export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>;

/**
 * What a caller hands {@link TelemetrySink.record}. `version` is supplied by
 * the sink and `recordedAt` defaults to the sink's clock, so a route handler
 * needs no clock of its own.
 */
export interface TelemetryRecordInput {
  twin: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  runId?: string;
  actorRole?: string;
  recordedAt?: string;
}

/** Inclusive time range and/or run filter (criterion 3). */
export interface TelemetryQuery {
  runId?: string;
  twin?: string;
  /** Inclusive lower bound, ISO-8601. */
  from?: string;
  /** Inclusive upper bound, ISO-8601. */
  to?: string;
  /** Maximum records returned, oldest first. */
  limit?: number;
}

/**
 * The telemetry sink contract. `record` MUST NOT throw and MUST NOT be
 * awaited by the caller: SPEC §14.1 telemetry is informational, and criterion
 * 2 requires that a broken sink cannot fail or slow the request it describes.
 */
export interface TelemetrySink {
  record(input: TelemetryRecordInput): void;
  query(query?: TelemetryQuery): TelemetryRecord[];
  /** Records this sink could not store. Never resets; monitoring reads it. */
  readonly errorCount: number;
  close(): void;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

function buildRecord(
  input: TelemetryRecordInput,
  clock: Clock,
): TelemetryRecord {
  const candidate = {
    version: TELEMETRY_RECORD_VERSION,
    recordedAt: input.recordedAt ?? clock.now(),
    twin: input.twin,
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.actorRole === undefined ? {} : { actorRole: input.actorRole }),
  };
  const parsed = TelemetryRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TelemetryError(
      'invalid-telemetry-record',
      'Telemetry record does not satisfy TelemetryRecordSchema',
      { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    );
  }
  return parsed.data;
}

function assertQuery(query: TelemetryQuery | undefined): void {
  if (query?.from !== undefined && Number.isNaN(Date.parse(query.from))) {
    throw new TelemetryError(
      'invalid-telemetry-query',
      'query.from must be an ISO-8601 timestamp',
    );
  }
  if (query?.to !== undefined && Number.isNaN(Date.parse(query.to))) {
    throw new TelemetryError(
      'invalid-telemetry-query',
      'query.to must be an ISO-8601 timestamp',
    );
  }
  if (
    query?.from !== undefined &&
    query.to !== undefined &&
    Date.parse(query.from) > Date.parse(query.to)
  ) {
    throw new TelemetryError(
      'invalid-telemetry-query',
      'query.from must not be after query.to',
    );
  }
  if (
    query?.limit !== undefined &&
    (!Number.isSafeInteger(query.limit) || query.limit < 0)
  ) {
    throw new TelemetryError(
      'invalid-telemetry-query',
      'query.limit must be a non-negative integer',
    );
  }
}

function matches(record: TelemetryRecord, query: TelemetryQuery): boolean {
  if (query.runId !== undefined && record.runId !== query.runId) {
    return false;
  }
  if (query.twin !== undefined && record.twin !== query.twin) {
    return false;
  }
  const at = Date.parse(record.recordedAt);
  if (query.from !== undefined && at < Date.parse(query.from)) {
    return false;
  }
  if (query.to !== undefined && at > Date.parse(query.to)) {
    return false;
  }
  return true;
}

export interface InMemoryTelemetrySinkOptions {
  clock?: Clock;
  /** Ring-buffer bound; the oldest record is dropped past it. Default 100000. */
  capacity?: number;
}

/**
 * Process-local sink for tests, the Mode P dashboard's short window, and any
 * host that does not want a second SQLite file.
 */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly #records: TelemetryRecord[] = [];
  readonly #clock: Clock;
  readonly #capacity: number;
  #errors = 0;
  #closed = false;

  constructor(options: InMemoryTelemetrySinkOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#capacity = options.capacity ?? 100_000;
  }

  get errorCount(): number {
    return this.#errors;
  }

  get size(): number {
    return this.#records.length;
  }

  record(input: TelemetryRecordInput): void {
    if (this.#closed) {
      this.#errors += 1;
      return;
    }
    try {
      this.#records.push(buildRecord(input, this.#clock));
      if (this.#records.length > this.#capacity) {
        this.#records.shift();
      }
    } catch {
      // Criterion 2: a malformed record is counted, never raised.
      this.#errors += 1;
    }
  }

  query(query: TelemetryQuery = {}): TelemetryRecord[] {
    assertQuery(query);
    const selected = this.#records.filter((record) => matches(record, query));
    return query.limit === undefined ? selected : selected.slice(0, query.limit);
  }

  close(): void {
    this.#closed = true;
  }
}

export interface SqliteTelemetrySinkOptions {
  /** Telemetry database path. MUST NOT be the evidence store's path. */
  path: string;
  clock?: Clock;
}

/**
 * The telemetry log's own append-only SQLite file: WAL journal, `UPDATE` and
 * `DELETE` rejected by trigger exactly as the evidence store's event tables
 * are (LEDGER §3), and no foreign key into the evidence schema — the two
 * stores never share a file, a connection, or a transaction.
 */
export class SqliteTelemetrySink implements TelemetrySink {
  readonly path: string;
  readonly #database: Database.Database;
  readonly #clock: Clock;
  #errors = 0;
  #closed = false;

  constructor(options: SqliteTelemetrySinkOptions) {
    const resolved =
      options.path === ':memory:' ? options.path : resolve(options.path);
    if (resolved !== ':memory:') {
      mkdirSync(dirname(resolved), { recursive: true });
    }
    this.path = resolved;
    this.#clock = options.clock ?? systemClock;
    this.#database = new Database(resolved);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('recursive_triggers = ON');
    this.#database.exec(TELEMETRY_SCHEMA_SQL);
  }

  get errorCount(): number {
    return this.#errors;
  }

  record(input: TelemetryRecordInput): void {
    if (this.#closed) {
      this.#errors += 1;
      return;
    }
    try {
      const record = buildRecord(input, this.#clock);
      this.#database
        .prepare(
          `INSERT INTO telemetry_records (
             version, recorded_at, twin, method, path, status, duration_ms,
             run_id, actor_role
           ) VALUES (
             @version, @recordedAt, @twin, @method, @path, @status, @durationMs,
             @runId, @actorRole
           )`,
        )
        .run({
          version: record.version,
          recordedAt: record.recordedAt,
          twin: record.twin,
          method: record.method,
          path: record.path,
          status: record.status,
          durationMs: record.durationMs,
          runId: record.runId ?? null,
          actorRole: record.actorRole ?? null,
        });
    } catch {
      // Criterion 2: a disk-full, locked, or malformed write is counted and
      // dropped. The request it describes is unaffected.
      this.#errors += 1;
    }
  }

  query(query: TelemetryQuery = {}): TelemetryRecord[] {
    assertQuery(query);
    if (this.#closed) {
      throw new TelemetryError(
        'telemetry-sink-closed',
        'SqliteTelemetrySink.query called after close()',
      );
    }
    const clauses: string[] = [];
    const parameters: Record<string, string | number> = {};
    if (query.runId !== undefined) {
      clauses.push('run_id = @runId');
      parameters.runId = query.runId;
    }
    if (query.twin !== undefined) {
      clauses.push('twin = @twin');
      parameters.twin = query.twin;
    }
    if (query.from !== undefined) {
      clauses.push('recorded_at >= @from');
      parameters.from = new Date(Date.parse(query.from)).toISOString();
    }
    if (query.to !== undefined) {
      clauses.push('recorded_at <= @to');
      parameters.to = new Date(Date.parse(query.to)).toISOString();
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const limit = query.limit === undefined ? '' : ' LIMIT @limit';
    if (query.limit !== undefined) {
      parameters.limit = query.limit;
    }
    const rows = this.#database
      .prepare<
        Record<string, string | number>,
        {
          version: number;
          recorded_at: string;
          twin: string;
          method: string;
          path: string;
          status: number;
          duration_ms: number;
          run_id: string | null;
          actor_role: string | null;
        }
      >(
        `SELECT version, recorded_at, twin, method, path, status, duration_ms,
                run_id, actor_role
           FROM telemetry_records${where}
          ORDER BY recorded_at, id${limit}`,
      )
      .all(parameters);
    return rows.map((row) =>
      TelemetryRecordSchema.parse({
        version: row.version,
        recordedAt: row.recorded_at,
        twin: row.twin,
        method: row.method,
        path: row.path,
        status: row.status,
        durationMs: row.duration_ms,
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        ...(row.actor_role === null ? {} : { actorRole: row.actor_role }),
      }),
    );
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }
}

/**
 * Append-only telemetry schema. The triggers mirror LEDGER §3's
 * accident-prevention control: a dashboard bug cannot rewrite the request log
 * it reads. `recorded_at` timestamps are stored as ISO-8601 so a lexical
 * comparison is also a chronological one.
 */
const TELEMETRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version      INTEGER NOT NULL,
  recorded_at  TEXT    NOT NULL,
  twin         TEXT    NOT NULL,
  method       TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  status       INTEGER NOT NULL,
  duration_ms  REAL    NOT NULL,
  run_id       TEXT,
  actor_role   TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_records_run
  ON telemetry_records (run_id, recorded_at);
CREATE INDEX IF NOT EXISTS telemetry_records_time
  ON telemetry_records (recorded_at);
CREATE TRIGGER IF NOT EXISTS telemetry_records_no_update
  BEFORE UPDATE ON telemetry_records
BEGIN
  SELECT RAISE(ABORT, 'append-only table: telemetry_records');
END;
CREATE TRIGGER IF NOT EXISTS telemetry_records_no_delete
  BEFORE DELETE ON telemetry_records
BEGIN
  SELECT RAISE(ABORT, 'append-only table: telemetry_records');
END;
`;

export interface GuardTelemetrySinkOptions {
  /** Called with whatever the wrapped sink threw or rejected with. */
  onError?: (error: unknown) => void;
}

/**
 * Wraps any sink — including a third-party one that does not honour the
 * `record` contract — so that criterion 2 holds regardless: a throw is
 * swallowed and counted, a returned promise is never awaited (so a sink that
 * hangs cannot slow the request), and a rejection is attached to a `catch`
 * so it can never surface as an `unhandledRejection`.
 */
export function guardTelemetrySink(
  inner: TelemetrySink,
  options: GuardTelemetrySinkOptions = {},
): TelemetrySink {
  let errors = 0;
  const report = (error: unknown): void => {
    errors += 1;
    try {
      options.onError?.(error);
    } catch {
      // A logger that itself throws has nowhere safer to report that.
    }
  };
  return {
    record(input) {
      try {
        // A sink may (incorrectly) return a promise; never await it.
        const returned: unknown = inner.record(input);
        if (
          typeof returned === 'object' &&
          returned !== null &&
          typeof (returned as { then?: unknown }).then === 'function'
        ) {
          void (returned as Promise<unknown>).then(undefined, report);
        }
      } catch (error) {
        report(error);
      }
    },
    query(query) {
      return inner.query(query);
    },
    get errorCount() {
      return errors + inner.errorCount;
    },
    close() {
      try {
        inner.close();
      } catch (error) {
        report(error);
      }
    },
  };
}
