/**
 * ALD-058 — telemetry event pipeline (SPECIFICATION.md §14.1).
 *
 * Covers the sink half of all three acceptance criteria; the "every API
 * request across all twin routes" half of criterion 1 is driven through the
 * real packs in `twins/packs/__tests__/telemetry.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  guardTelemetrySink,
  InMemoryTelemetrySink,
  SqliteTelemetrySink,
  TelemetryRecordSchema,
  type TelemetryRecordInput,
  type TelemetrySink,
} from '@ald/ops';

import { FixedClock, StepClock } from './support.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ald-ops-telemetry-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function request(overrides: Partial<TelemetryRecordInput> = {}): TelemetryRecordInput {
  return {
    twin: 'nursery',
    method: 'POST',
    path: '/runs/:id/step',
    status: 200,
    durationMs: 12.5,
    runId: 'run-1',
    actorRole: 'researcher-operator',
    ...overrides,
  };
}

describe('ALD-058 telemetry record shape (SPEC §14.1)', () => {
  it('ALD-058: a record carries the four §14.1 fields plus run id and role', () => {
    const sink = new InMemoryTelemetrySink({ clock: new FixedClock() });
    sink.record(request());
    const [record] = sink.query();
    expect(record).toEqual({
      version: 1,
      recordedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      twin: 'nursery',
      method: 'POST',
      path: '/runs/:id/step',
      status: 200,
      durationMs: 12.5,
      runId: 'run-1',
      actorRole: 'researcher-operator',
    });
    expect(TelemetryRecordSchema.parse(record)).toEqual(record);
  });

  it('ALD-058: the schema rejects unknown fields, so no scenario state can ride along', () => {
    expect(
      TelemetryRecordSchema.safeParse({
        ...request(),
        version: 1,
        recordedAt: new Date().toISOString(),
        observation: [1, 2, 3],
      }).success,
    ).toBe(false);
  });

  it('ALD-058 criterion 2: a malformed record is counted, never thrown', () => {
    const sink = new InMemoryTelemetrySink({ clock: new FixedClock() });
    sink.record(request({ status: 999 }));
    sink.record(request({ durationMs: Number.NaN }));
    sink.record(request({ twin: '' }));
    expect(sink.errorCount).toBe(3);
    expect(sink.query()).toHaveLength(0);
  });
});

describe('ALD-058 criterion 3: queryable by run id and by time range', () => {
  for (const kind of ['in-memory', 'sqlite'] as const) {
    it(`ALD-058: ${kind} sink filters by run id and inclusive time range`, async () => {
      const clock = new StepClock(Date.UTC(2026, 0, 1), 60_000);
      const sink: TelemetrySink =
        kind === 'in-memory'
          ? new InMemoryTelemetrySink({ clock })
          : new SqliteTelemetrySink({ path: join(await tempDir(), 't.sqlite'), clock });

      // t0 t1 t2 for run-1 ... t3 for run-2
      sink.record(request({ runId: 'run-1', path: '/runs/:id/step' }));
      sink.record(request({ runId: 'run-1', path: '/runs/:id/pause' }));
      sink.record(request({ runId: 'run-1', path: '/runs/:id/resume' }));
      sink.record(request({ runId: 'run-2', path: '/runs/:id/step' }));
      sink.record(request({ runId: undefined, twin: 'baby-a', path: '/act' }));

      expect(sink.errorCount).toBe(0);
      expect(sink.query({ runId: 'run-1' }).map((r) => r.path)).toEqual([
        '/runs/:id/step',
        '/runs/:id/pause',
        '/runs/:id/resume',
      ]);
      expect(sink.query({ runId: 'run-2' })).toHaveLength(1);
      expect(sink.query({ twin: 'baby-a' }).map((r) => r.runId)).toEqual([
        undefined,
      ]);

      const t1 = new Date(Date.UTC(2026, 0, 1) + 60_000).toISOString();
      const t2 = new Date(Date.UTC(2026, 0, 1) + 120_000).toISOString();
      expect(sink.query({ from: t1, to: t2 }).map((r) => r.path)).toEqual([
        '/runs/:id/pause',
        '/runs/:id/resume',
      ]);
      expect(sink.query({ from: t1, to: t2, runId: 'run-1' })).toHaveLength(2);
      expect(sink.query({ limit: 2 })).toHaveLength(2);
      sink.close();
    });
  }

  it('ALD-058: an impossible time range is a typed error, not silent nonsense', () => {
    const sink = new InMemoryTelemetrySink({ clock: new FixedClock() });
    expect(() =>
      sink.query({
        from: new Date(Date.UTC(2026, 0, 2)).toISOString(),
        to: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      }),
    ).toThrowError(/from must not be after/u);
    expect(() => sink.query({ limit: -1 })).toThrowError(/non-negative/u);
    expect(() => sink.query({ from: 'not-a-date' })).toThrowError(/ISO-8601/u);
  });
});

describe('ALD-058: the telemetry store is never the evidence store', () => {
  it('ALD-058: SqliteTelemetrySink opens its own file with only its own table', async () => {
    const dir = await tempDir();
    const sink = new SqliteTelemetrySink({
      path: join(dir, 'telemetry.sqlite'),
      clock: new FixedClock(),
    });
    sink.record(request());
    sink.close();

    const database = new Database(join(dir, 'telemetry.sqlite'), {
      readonly: true,
    });
    const tables = database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    database.close();
    expect(tables).toContain('telemetry_records');
    for (const evidenceTable of [
      'ledger_events',
      'channel_events',
      'run_metadata',
      'checkpoint_manifests',
    ]) {
      expect(tables).not.toContain(evidenceTable);
    }
  });

  it('ALD-058: the telemetry table is append-only (UPDATE and DELETE rejected)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'telemetry.sqlite');
    const sink = new SqliteTelemetrySink({ path, clock: new FixedClock() });
    sink.record(request());
    sink.close();

    const database = new Database(path);
    database.pragma('recursive_triggers = ON');
    expect(() =>
      database.prepare('UPDATE telemetry_records SET status = 500').run(),
    ).toThrowError(/append-only table: telemetry_records/u);
    expect(() => database.prepare('DELETE FROM telemetry_records').run()).toThrowError(
      /append-only table: telemetry_records/u,
    );
    expect(
      database
        .prepare<[], { count: number }>(
          'SELECT COUNT(*) AS count FROM telemetry_records',
        )
        .get()?.count,
    ).toBe(1);
    database.close();
  });
});

describe('ALD-058 criterion 2: fault injection on the sink', () => {
  const cases: {
    label: string;
    build: () => TelemetrySink;
    expectErrors: boolean;
  }[] = [
    {
      label: 'a sink whose record() throws',
      expectErrors: true,
      build: () => ({
        record: () => {
          throw new Error('sink is broken');
        },
        query: () => [],
        errorCount: 0,
        close: () => undefined,
      }),
    },
    {
      label: 'a sink whose record() returns a rejected promise',
      expectErrors: true,
      build: () => ({
        record: () => Promise.reject(new Error('sink rejected')) as unknown as void,
        query: () => [],
        errorCount: 0,
        close: () => undefined,
      }),
    },
    {
      label: 'a sink whose record() returns a promise that never settles',
      expectErrors: false,
      build: () => ({
        record: () => new Promise<void>(() => undefined) as unknown as void,
        query: () => [],
        errorCount: 0,
        close: () => undefined,
      }),
    },
    {
      label: 'a sink whose close() throws',
      expectErrors: true,
      build: () => ({
        record: () => undefined,
        query: () => [],
        errorCount: 0,
        close: () => {
          throw new Error('close is broken');
        },
      }),
    },
  ];

  for (const testCase of cases) {
    it(`ALD-058: guardTelemetrySink contains ${testCase.label}`, async () => {
      const seen: unknown[] = [];
      const guarded = guardTelemetrySink(testCase.build(), {
        onError: (error) => seen.push(error),
      });
      const startedAt = Date.now();
      expect(() => guarded.record(request())).not.toThrow();
      guarded.close();
      // No await anywhere: a hanging sink cannot slow the caller.
      expect(Date.now() - startedAt).toBeLessThan(200);
      // Give a rejected promise a turn to settle into the attached catch.
      await Promise.resolve();
      await Promise.resolve();
      if (testCase.expectErrors) {
        expect(guarded.errorCount).toBeGreaterThan(0);
        expect(seen.length).toBeGreaterThan(0);
      } else {
        expect(guarded.errorCount).toBe(0);
      }
    });
  }

  it('ALD-058: a throwing onError observer cannot escape the guard', () => {
    const guarded = guardTelemetrySink(
      {
        record: () => {
          throw new Error('sink is broken');
        },
        query: () => [],
        errorCount: 0,
        close: () => undefined,
      },
      {
        onError: () => {
          throw new Error('logger is broken too');
        },
      },
    );
    expect(() => guarded.record(request())).not.toThrow();
    expect(guarded.errorCount).toBe(1);
  });

  it('ALD-058: a closed sink counts further records instead of throwing', () => {
    const sink = new InMemoryTelemetrySink({ clock: new FixedClock() });
    sink.close();
    expect(() => sink.record(request())).not.toThrow();
    expect(sink.errorCount).toBe(1);
  });

  it('ALD-058: the in-memory sink is bounded so a long run cannot exhaust memory', () => {
    const sink = new InMemoryTelemetrySink({
      clock: new StepClock(Date.UTC(2026, 0, 1), 1),
      capacity: 3,
    });
    for (let index = 0; index < 10; index += 1) {
      sink.record(request({ path: `/runs/:id/p${String(index)}` }));
    }
    expect(sink.size).toBe(3);
    expect(sink.query().map((r) => r.path)).toEqual([
      '/runs/:id/p7',
      '/runs/:id/p8',
      '/runs/:id/p9',
    ]);
  });
});
