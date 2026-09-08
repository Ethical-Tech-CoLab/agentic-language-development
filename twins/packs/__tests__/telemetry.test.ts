/**
 * ALD-058 criterion 1 and 2 across the real DTSF twin packs
 * (SPECIFICATION.md §14.1, §12.1-§12.6).
 *
 * Criterion 1 ("every API request across all twin routes produces a telemetry
 * record with the fields §14.1 requires") is asserted by driving the `nursery`,
 * `baby-a`, and `baby-b` packs — all three of which dispatch through
 * `createRouter` in `nursery/behavior/http.ts` — with a telemetry sink on the
 * context state, and checking the records that come out.
 *
 * Criterion 2 ("telemetry recording failures never block or fail the
 * underlying request") is asserted by fault injection: sinks that throw,
 * reject, and hang forever.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildRunConfig, type RunConfigOverrides } from '@ald/lifecycle';
import { InMemoryTelemetrySink, type TelemetryRecord } from '@ald/ops';
import { resetNurseryRuntime } from '@ald/orchestrator';
import type {
  BehaviorPackContext,
  RunConfig,
  TwinRequest,
} from '@ald/types';

import BabyAPack from '../baby-a/behavior/pack.js';
import BabyBPack from '../baby-b/behavior/pack.js';
import NurseryPack from '../nursery/behavior/pack.js';
import {
  TELEMETRY_SINK_STATE_KEY,
  UNMATCHED_ROUTE_PATTERN,
  type Role,
} from '../nursery/behavior/http.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ald-telemetry-twins-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetNurseryRuntime();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeContext(
  twinName: string,
  state: Map<string, unknown>,
): BehaviorPackContext {
  return { twinName, seed: 1, state };
}

function request(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}): TwinRequest {
  return {
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    query: input.query ?? {},
    body: input.body,
  };
}

function authHeaders(role: Role): Record<string, string> {
  return { 'x-ald-role': role, 'x-ald-service-token': `dev-${role}` };
}

function noLearningRunConfig(overrides: RunConfigOverrides): RunConfig {
  return buildRunConfig({
    deploymentMode: 'prototype',
    protocolGitCommit: 'git:telemetry-test',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    ...overrides,
  });
}

interface Stand {
  nursery: NurseryPack;
  babyA: BabyAPack;
  babyB: BabyBPack;
  sink: InMemoryTelemetrySink;
  bundleRoot: string;
}

/**
 * All three packs share one sink so the records prove "every API request
 * across all twin routes", not just the nursery's.
 */
async function createStand(
  sinkOverride?: { record(record: unknown): unknown },
): Promise<Stand> {
  const bundleRoot = await tempDir();
  const sink = new InMemoryTelemetrySink();
  const install = sinkOverride ?? sink;

  const nurseryState = new Map<string, unknown>([
    ['databasePath', ':memory:'],
    ['bundleRoot', bundleRoot],
    ['softwareCommit', 'git:telemetry-test'],
    [TELEMETRY_SINK_STATE_KEY, install],
  ]);
  const nursery = new NurseryPack();
  await nursery.init(makeContext('nursery', nurseryState));

  const babyA = new BabyAPack();
  await babyA.init(
    makeContext('baby-a', new Map([[TELEMETRY_SINK_STATE_KEY, install]])),
  );
  const babyB = new BabyBPack();
  await babyB.init(
    makeContext('baby-b', new Map([[TELEMETRY_SINK_STATE_KEY, install]])),
  );

  return { nursery, babyA, babyB, sink, bundleRoot };
}

function pathsOf(records: readonly TelemetryRecord[]): string[] {
  return records.map((record) => record.path);
}

describe('ALD-058 criterion 1: every twin route produces a telemetry record', () => {
  it('ALD-058: the nursery routes record method, route pattern, status, duration and run id', async () => {
    const stand = await createStand();
    const runId = 'telemetry-run-1';
    const config = noLearningRunConfig({
      runId,
      experimentId: 'E03',
      randomSeed: 'seed-telemetry-1',
      maxTurnsPerRun: 2,
      evaluationTurns: 1,
      communicationCondition: 'disabled',
    });

    const created = await stand.nursery.handleRequest(
      request({
        method: 'POST',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
        body: config,
      }),
      new Map(),
    );
    expect(created.response.status).toBe(201);

    const stepped = await stand.nursery.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    expect(stepped.response.status).toBe(200);

    const read = await stand.nursery.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(read.response.status).toBe(200);

    const records = stand.sink.query();
    expect(pathsOf(records)).toEqual([
      '/runs',
      '/runs/:id/step',
      '/runs/:id',
    ]);
    expect(records.map((record) => record.method)).toEqual([
      'POST',
      'POST',
      'GET',
    ]);
    expect(records.map((record) => record.status)).toEqual([201, 200, 200]);
    for (const record of records) {
      expect(record.twin).toBe('nursery');
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(record.durationMs)).toBe(true);
      expect(Date.parse(record.recordedAt)).not.toBeNaN();
    }
    // The run id travels in its own field, never inside `path`.
    expect(records[1]?.runId).toBe(runId);
    expect(records[2]?.runId).toBe(runId);
    expect(records[1]?.actorRole).toBe('internal-controller');
    for (const record of records) {
      expect(record.path).not.toContain(runId);
    }
  });

  it('ALD-058: baby-a and baby-b routes record under their own twin names', async () => {
    const stand = await createStand();
    const runId = 'telemetry-run-2';
    await stand.nursery.handleRequest(
      request({
        method: 'POST',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
        body: noLearningRunConfig({
          runId,
          experimentId: 'E03',
          randomSeed: 'seed-telemetry-2',
          maxTurnsPerRun: 2,
          evaluationTurns: 1,
          communicationCondition: 'disabled',
        }),
      }),
      new Map(),
    );

    const ledger = await stand.babyA.handleRequest(
      request({
        method: 'GET',
        path: '/ledger',
        headers: authHeaders('researcher-viewer'),
        query: { runId },
      }),
      new Map(),
    );
    expect(ledger.response.status).toBe(200);

    const reset = await stand.babyB.handleRequest(
      request({
        method: 'POST',
        path: '/reset',
        headers: authHeaders('internal-controller'),
        body: { runId },
      }),
      new Map(),
    );
    // A documented in-envelope gap, not a telemetry problem (SPEC §12.4).
    expect(reset.response.status).toBe(409);

    const babyRecords = stand.sink
      .query()
      .filter((record) => record.twin !== 'nursery');
    expect(babyRecords).toHaveLength(2);
    expect(babyRecords[0]).toMatchObject({
      twin: 'baby-a',
      method: 'GET',
      path: '/ledger',
      status: 200,
      actorRole: 'researcher-viewer',
    });
    expect(babyRecords[1]).toMatchObject({
      twin: 'baby-b',
      method: 'POST',
      path: '/reset',
      status: 409,
      actorRole: 'internal-controller',
    });
    // Baby routes carry no run id in the path (SPEC §12.4), so none is stored.
    expect(babyRecords[0]?.runId).toBeUndefined();
    expect(babyRecords[1]?.runId).toBeUndefined();
  });

  it('ALD-058: rejected requests are recorded too, and never leak a raw path', async () => {
    const stand = await createStand();

    const unauthenticated = await stand.nursery.handleRequest(
      request({ method: 'GET', path: '/runs/secret-run-id' }),
      new Map(),
    );
    expect(unauthenticated.response.status).toBe(401);

    const forbidden = await stand.nursery.handleRequest(
      request({
        method: 'POST',
        path: '/runs/secret-run-id/pause',
        headers: authHeaders('researcher-viewer'),
        body: { reasonCode: 'x' },
      }),
      new Map(),
    );
    expect(forbidden.response.status).toBe(403);

    const unmatched = await stand.nursery.handleRequest(
      request({
        method: 'GET',
        path: '/no/such/route/at/all',
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(unmatched.response.status).toBe(404);

    const wrongMethod = await stand.nursery.handleRequest(
      request({
        method: 'DELETE',
        path: '/runs/secret-run-id',
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(wrongMethod.response.status).toBe(404);

    const records = stand.sink.query();
    expect(records.map((record) => [record.path, record.status])).toEqual([
      ['/runs/:id', 401],
      ['/runs/:id/pause', 403],
      [UNMATCHED_ROUTE_PATTERN, 404],
      ['/runs/:id', 404],
    ]);
    for (const record of records) {
      expect(record.path).not.toContain('secret-run-id');
      expect(record.path).not.toContain('/no/such/route');
    }
    // An unauthenticated request has no authenticated role to record.
    expect(records[0]?.actorRole).toBeUndefined();
    expect(records[1]?.actorRole).toBe('researcher-viewer');
  });

  it('ALD-058: no record is produced when the host installs no sink', async () => {
    const bundleRoot = await tempDir();
    const nursery = new NurseryPack();
    await nursery.init(
      makeContext(
        'nursery',
        new Map<string, unknown>([
          ['databasePath', ':memory:'],
          ['bundleRoot', bundleRoot],
          ['softwareCommit', 'git:telemetry-test'],
        ]),
      ),
    );
    const result = await nursery.handleRequest(
      request({
        method: 'GET',
        path: '/runs',
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(result.response.status).toBe(200);
  });

  it('ALD-058: a non-sink value on the state key is ignored, not called', async () => {
    const stand = await createStand({ record: 'not a function' } as never);
    const result = await stand.nursery.handleRequest(
      request({
        method: 'GET',
        path: '/runs',
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(result.response.status).toBe(200);
  });
});

describe('ALD-058 criterion 2: a broken sink never blocks or fails a request', () => {
  const HANG_GUARD_MS = 1_000;

  const faults: { label: string; sink: { record(record: unknown): unknown } }[] = [
    {
      label: 'throws synchronously',
      sink: {
        record: () => {
          throw new Error('telemetry sink is broken');
        },
      },
    },
    {
      label: 'returns a rejected promise',
      sink: { record: () => Promise.reject(new Error('telemetry rejected')) },
    },
    {
      label: 'returns a promise that never settles',
      sink: { record: () => new Promise(() => undefined) },
    },
  ];

  for (const fault of faults) {
    it(`ALD-058: a sink that ${fault.label} leaves the route unaffected`, async () => {
      const stand = await createStand(fault.sink);
      const startedAt = Date.now();
      const result = await stand.nursery.handleRequest(
        request({
          method: 'GET',
          path: '/runs',
          headers: authHeaders('researcher-viewer'),
        }),
        new Map(),
      );
      const elapsed = Date.now() - startedAt;
      expect(result.response.status).toBe(200);
      expect(result.response.body).toMatchObject({ ok: true });
      expect(elapsed).toBeLessThan(HANG_GUARD_MS);
    });
  }

  it('ALD-058: a sink that throws does not prevent the next request from being served', async () => {
    let calls = 0;
    const stand = await createStand({
      record: () => {
        calls += 1;
        throw new Error('still broken');
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const result = await stand.nursery.handleRequest(
        request({
          method: 'GET',
          path: '/runs',
          headers: authHeaders('researcher-viewer'),
        }),
        new Map(),
      );
      expect(result.response.status).toBe(200);
    }
    expect(calls).toBe(3);
  });
});
