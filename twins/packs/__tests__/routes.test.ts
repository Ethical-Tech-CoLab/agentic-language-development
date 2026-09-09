/**
 * DTSF route tests for `nursery`, `baby-a`, `baby-b` (SPECIFICATION.md
 * §12.1-§12.6; BACKLOG ALD-048, ALD-049, ALD-050, ALD-051, ALD-052).
 *
 * Replaces `scaffolds.test.ts`'s 501/'scaffold' placeholder assertions with
 * the real route surface: manifest/capability checks, unprefixed route
 * patterns, an exhaustive role x route auth matrix (§12.2), the §12.3
 * response/error envelope, a full Prototype Mode lifecycle through the
 * nursery pack, the Baby routes returning real schema-valid envelopes, the
 * §4.2 Baby-to-Baby isolation guarantee (also closing the second half of
 * ALD-029 criterion 1), and a session snapshot/restore/delta round trip.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRunConfig, type RunConfigOverrides } from '@ald/lifecycle';
import { getNurseryRuntime, resetNurseryRuntime } from '@ald/orchestrator';
import {
  LedgerDraftEnvelopeSchema,
  TurnProposalEnvelopeSchema,
  type BehaviorPack,
  type BehaviorPackContext,
  type RunConfig,
  type TwinRequest,
} from '@ald/types';

import BabyAPack, { BABY_A_ROUTE_PATTERNS } from '../baby-a/behavior/pack.js';
import BabyBPack, { BABY_B_ROUTE_PATTERNS } from '../baby-b/behavior/pack.js';
import NurseryPack, { NURSERY_ROUTE_PATTERNS } from '../nursery/behavior/pack.js';
import { ROLES, roleSatisfies, type Role } from '../nursery/behavior/http.js';

interface TwinManifest {
  metadata: { name: string };
  behaviorPack: { entrypoint: string };
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** Hard rule 6: every SQLite/bundle path in these tests comes from `mkdtemp`. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetNurseryRuntime();
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeContext(
  twinName: string,
  state: Map<string, unknown> = new Map(),
): BehaviorPackContext {
  return { twinName, seed: 1, state };
}

interface NurseryHarness {
  pack: NurseryPack;
  bundleRoot: string;
}

/** One Prototype Mode nursery runtime, in-memory database, temp bundle root. */
async function createNurseryHarness(): Promise<NurseryHarness> {
  const bundleRoot = await tempDir('ald-nursery-test-');
  const state = new Map<string, unknown>();
  state.set('databasePath', ':memory:');
  state.set('bundleRoot', bundleRoot);
  state.set('softwareCommit', 'git:routes-test');
  const pack = new NurseryPack();
  await pack.init(makeContext('nursery', state));
  return { pack, bundleRoot };
}

async function createBabyA(): Promise<BabyAPack> {
  const pack = new BabyAPack();
  await pack.init(makeContext('baby-a'));
  return pack;
}

async function createBabyB(): Promise<BabyBPack> {
  const pack = new BabyBPack();
  await pack.init(makeContext('baby-b'));
  return pack;
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

function authHeaders(role: Role, token = `dev-${role}`): Record<string, string> {
  return { 'x-ald-role': role, 'x-ald-service-token': token };
}

let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `run-${String(runCounter)}`;
}

/** SPEC §18 defaults plus a symmetric no-learning pair (chance-baseline track). */
function noLearningRunConfig(overrides: RunConfigOverrides): RunConfig {
  return buildRunConfig({
    deploymentMode: 'prototype',
    protocolGitCommit: 'git:test-protocol',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    ...overrides,
  });
}

async function createRunViaRoute(nursery: NurseryHarness, config: RunConfig) {
  return nursery.pack.handleRequest(
    request({
      method: 'POST',
      path: '/runs',
      headers: authHeaders('researcher-operator'),
      body: config,
    }),
    new Map(),
  );
}

// ---------------------------------------------------------------------------
// Manifests and route conventions
// ---------------------------------------------------------------------------

describe('DTSF twin pack manifests', () => {
  const packs = [
    {
      name: 'baby-a',
      Pack: BabyAPack,
      routePatterns: BABY_A_ROUTE_PATTERNS,
      capabilities: ['learner-routes', 'prototype-mode'],
    },
    {
      name: 'baby-b',
      Pack: BabyBPack,
      routePatterns: BABY_B_ROUTE_PATTERNS,
      capabilities: ['learner-routes', 'prototype-mode'],
    },
    {
      name: 'nursery',
      Pack: NurseryPack,
      routePatterns: NURSERY_ROUTE_PATTERNS,
      capabilities: [
        'run-lifecycle',
        'evidence-routes',
        'verification-routes',
        'session-snapshot',
        'prototype-mode',
      ],
    },
  ] as const;

  it.each(packs)(
    'loads the $name manifest and matches describeCapabilities()',
    async ({ name, Pack, capabilities }) => {
      const manifestPath = fileURLToPath(
        new URL(`../${name}/twin.yaml`, import.meta.url),
      );
      const manifest = parse(await readFile(manifestPath, 'utf8')) as TwinManifest;
      expect(manifest.metadata.name).toBe(name);
      expect(manifest.behaviorPack.entrypoint).toBe('./behavior/pack.ts');
      expect(manifest.capabilities).toEqual(capabilities);

      const pack = new Pack();
      expect(pack.describeCapabilities()).toEqual(capabilities);
    },
  );

  it.each(packs)(
    'registers only unprefixed $name routes (SPEC §12.1)',
    ({ name, routePatterns }) => {
      expect(routePatterns.length).toBeGreaterThan(0);
      for (const pattern of routePatterns) {
        expect(pattern.startsWith('/')).toBe(true);
        expect(pattern.startsWith(`/${name}`)).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Role x route matrix (SPEC §12.2, §12.4-§12.6; ALD-051)
// ---------------------------------------------------------------------------

interface RouteCase {
  method: string;
  path: string;
  roles: Role[];
}

const NURSERY_CASES: RouteCase[] = [
  { method: 'POST', path: '/runs', roles: ['researcher-operator'] },
  { method: 'POST', path: '/runs/:id/step', roles: ['internal-controller'] },
  { method: 'GET', path: '/runs', roles: ['researcher-viewer'] },
  { method: 'GET', path: '/runs/:id', roles: ['researcher-viewer'] },
  { method: 'GET', path: '/runs/:id/transcript', roles: ['researcher-viewer'] },
  { method: 'GET', path: '/runs/:id/ledgers', roles: ['researcher-viewer'] },
  { method: 'GET', path: '/runs/:id/audit', roles: ['researcher-viewer'] },
  { method: 'GET', path: '/runs/:id/checkpoints', roles: ['researcher-viewer'] },
  { method: 'POST', path: '/runs/:id/pause', roles: ['researcher-operator'] },
  { method: 'POST', path: '/runs/:id/resume', roles: ['researcher-operator'] },
  { method: 'POST', path: '/runs/:id/abort', roles: ['researcher-operator'] },
  { method: 'POST', path: '/runs/:id/annotate', roles: ['researcher-operator'] },
  {
    method: 'GET',
    path: '/runs/:id/verification-report',
    roles: ['researcher-viewer'],
  },
  { method: 'POST', path: '/runs/:id/verify', roles: ['researcher-operator'] },
  { method: 'POST', path: '/session/snapshot', roles: ['researcher-operator'] },
  { method: 'POST', path: '/session/restore', roles: ['researcher-operator'] },
  { method: 'GET', path: '/session/delta', roles: ['researcher-viewer'] },
];

const BABY_CASES: RouteCase[] = [
  { method: 'POST', path: '/observe', roles: ['internal-controller'] },
  { method: 'POST', path: '/act', roles: ['internal-gateway'] },
  { method: 'POST', path: '/deliver', roles: ['internal-gateway'] },
  { method: 'POST', path: '/outcome', roles: ['internal-controller'] },
  { method: 'GET', path: '/ledger', roles: ['researcher-viewer'] },
  { method: 'POST', path: '/reset', roles: ['internal-controller'] },
];

function withId(path: string): string {
  return path.replace(':id', 'rt-matrix-run');
}

/**
 * The router authenticates and authorizes before it ever parses the body, so
 * these 401/403 checks never need a real run or a schema-valid payload — see
 * `createRouter` in `nursery/behavior/http.ts`.
 */
async function assertRoleGuard(
  pack: BehaviorPack,
  cases: readonly RouteCase[],
): Promise<void> {
  for (const routeCase of cases) {
    const path = withId(routeCase.path);
    const label = `${routeCase.method} ${path}`;

    const noToken = await pack.handleRequest(
      request({ method: routeCase.method, path }),
      new Map(),
    );
    expect(noToken.response.status, `${label} (no headers)`).toBe(401);
    expect(noToken.response.body).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });

    const badToken = await pack.handleRequest(
      request({
        method: routeCase.method,
        path,
        headers: {
          'x-ald-role': routeCase.roles[0] as string,
          'x-ald-service-token': 'not-the-right-token',
        },
      }),
      new Map(),
    );
    expect(badToken.response.status, `${label} (bad token)`).toBe(401);

    for (const role of ROLES) {
      if (roleSatisfies(role, routeCase.roles)) {
        continue;
      }
      const forbidden = await pack.handleRequest(
        request({ method: routeCase.method, path, headers: authHeaders(role) }),
        new Map(),
      );
      expect(forbidden.response.status, `${label} role=${role}`).toBe(403);
      expect(forbidden.response.body).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    }
  }
}

describe('Role guard matrix (SPEC §12.2)', () => {
  it('nursery rejects missing/invalid credentials and every non-permitted role', async () => {
    const nursery = await createNurseryHarness();
    await assertRoleGuard(nursery.pack, NURSERY_CASES);
  });

  it('baby-a rejects missing/invalid credentials and every non-permitted role', async () => {
    const babyA = await createBabyA();
    await assertRoleGuard(babyA, BABY_CASES);
  });

  it('baby-b rejects missing/invalid credentials and every non-permitted role', async () => {
    const babyB = await createBabyB();
    await assertRoleGuard(babyB, BABY_CASES);
  });

  it('researcher-operator is also accepted wherever researcher-viewer is (SPEC §12.2)', async () => {
    const nursery = await createNurseryHarness();
    const res = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
      }),
      new Map(),
    );
    expect(res.response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error envelope shape (SPEC §12.3; ALD-052)
// ---------------------------------------------------------------------------

describe('Response and error envelope (SPEC §12.3)', () => {
  it('404 NOT_FOUND for an unknown run', async () => {
    const nursery = await createNurseryHarness();
    const res = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/runs/does-not-exist',
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(res.response.status).toBe(404);
    expect(res.response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('400 INVALID_REQUEST for a malformed RunConfig body', async () => {
    const nursery = await createNurseryHarness();
    const res = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
        body: { not: 'a run config' },
      }),
      new Map(),
    );
    expect(res.response.status).toBe(400);
    expect(res.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('400 INVALID_REQUEST for a body that is not valid JSON', async () => {
    const nursery = await createNurseryHarness();
    const res = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
        body: '{ this is not json',
      }),
      new Map(),
    );
    expect(res.response.status).toBe(400);
    expect(res.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('accepts a body delivered as a JSON string, not only a parsed object', async () => {
    const nursery = await createNurseryHarness();
    const config = noLearningRunConfig({
      runId: nextRunId(),
      experimentId: 'E03',
      randomSeed: 'seed-string-body',
      maxTurnsPerRun: 2,
      evaluationTurns: 2,
    });
    const res = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/runs',
        headers: authHeaders('researcher-operator'),
        body: JSON.stringify(config),
      }),
      new Map(),
    );
    expect(res.response.status).toBe(201);
    expect(res.response.body).toMatchObject({ ok: true });
  });

  it('409 CONFLICT for a duplicate run id', async () => {
    const nursery = await createNurseryHarness();
    const config = noLearningRunConfig({
      runId: nextRunId(),
      experimentId: 'E03',
      randomSeed: 'seed-duplicate',
      maxTurnsPerRun: 2,
      evaluationTurns: 2,
    });
    const first = await createRunViaRoute(nursery, config);
    expect(first.response.status).toBe(201);
    const second = await createRunViaRoute(nursery, config);
    expect(second.response.status).toBe(409);
    expect(second.response.body).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('409 CONFLICT (not 501) for baby-a /reset (SPEC §12.3 has no server-fault member)', async () => {
    const babyA = await createBabyA();
    const res = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/reset',
        headers: authHeaders('internal-controller'),
        body: { runId: 'whatever' },
      }),
      new Map(),
    );
    expect(res.response.status).toBe(409);
    expect(res.response.body).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('400 INVALID_REQUEST (not an unhandled rejection) for malformed percent-encoding in a path parameter', async () => {
    const nursery = await createNurseryHarness();
    // No auth headers at all: the malformed segment must be rejected by
    // `matchPath` before `authenticate` runs (SPEC §12.3 has no server-fault
    // member, so this must never surface as an unhandled `URIError`).
    const res = await nursery.pack.handleRequest(
      request({ method: 'GET', path: '/runs/%E0%A4%A/transcript' }),
      new Map(),
    );
    expect(res.response.status).toBe(400);
    expect(res.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('400 INVALID_REQUEST for a runId that would escape the configured bundle root', async () => {
    const nursery = await createNurseryHarness();
    const config = noLearningRunConfig({
      runId: '../../ald-escaped-bundle',
      experimentId: 'E03',
      randomSeed: 'seed-run-id-escape',
      maxTurnsPerRun: 2,
      evaluationTurns: 2,
    });
    const res = await createRunViaRoute(nursery, config);
    expect(res.response.status).toBe(400);
    expect(res.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});

// ---------------------------------------------------------------------------
// Full Prototype Mode lifecycle through the nursery pack (ALD-049, ALD-050)
// ---------------------------------------------------------------------------

describe('Full prototype-mode lifecycle (SPEC §7.2, §12.5, §12.6)', () => {
  it('creates, steps, reads, pauses, resumes, and verifies a run', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    // `maxTurnsPerRun` is raised above the 3 steps this test takes so the
    // run stays in `running` through the pause/resume exercise: SPEC §7.2's
    // transition table only admits `pause` from `running`, not `evaluating`.
    const config = noLearningRunConfig({
      runId,
      experimentId: 'E03',
      randomSeed: 'seed-full-flow',
      maxTurnsPerRun: 5,
      evaluationTurns: 5,
    });

    const created = await createRunViaRoute(nursery, config);
    expect(created.response.status).toBe(201);
    expect(created.response.body).toMatchObject({
      ok: true,
      run: { runId, state: 'running', turn: 0 },
    });

    for (let i = 0; i < 3; i += 1) {
      const stepResult = await nursery.pack.handleRequest(
        request({
          method: 'POST',
          path: `/runs/${runId}/step`,
          headers: authHeaders('internal-controller'),
        }),
        new Map(),
      );
      expect(stepResult.response.status, `step ${String(i)}`).toBe(200);
      expect(stepResult.response.body).toMatchObject({ ok: true });
    }

    for (const path of ['transcript', 'ledgers', 'audit', 'checkpoints']) {
      const res = await nursery.pack.handleRequest(
        request({
          method: 'GET',
          path: `/runs/${runId}/${path}`,
          headers: authHeaders('researcher-viewer'),
        }),
        new Map(),
      );
      expect(res.response.status, path).toBe(200);
      expect(res.response.body).toMatchObject({ ok: true });
    }

    const transcript = (
      (
        await nursery.pack.handleRequest(
          request({
            method: 'GET',
            path: `/runs/${runId}/transcript`,
            headers: authHeaders('researcher-viewer'),
          }),
          new Map(),
        )
      ).response.body as { transcript: unknown[] }
    ).transcript;
    expect(transcript.length).toBeGreaterThan(0);

    const paused = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/pause`,
        headers: { ...authHeaders('researcher-operator'), 'x-ald-actor': 'test-operator' },
        body: { reasonCode: 'manual-check', details: { note: 'routes.test.ts' } },
      }),
      new Map(),
    );
    expect(paused.response.status).toBe(200);
    expect(paused.response.body).toMatchObject({ ok: true, run: { state: 'paused' } });

    const resumed = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/resume`,
        headers: authHeaders('researcher-operator'),
        body: { reasonCode: 'manual-check-resume' },
      }),
      new Map(),
    );
    expect(resumed.response.status).toBe(200);
    expect(resumed.response.body).toMatchObject({ ok: true, run: { state: 'running' } });

    const got = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(got.response.status).toBe(200);
    expect(got.response.body).toMatchObject({ ok: true, run: { runId, turn: 3 } });

    const listed = await nursery.pack.handleRequest(
      request({ method: 'GET', path: '/runs', headers: authHeaders('researcher-viewer') }),
      new Map(),
    );
    expect(listed.response.status).toBe(200);
    const runs = (listed.response.body as { runs: { runId: string }[] }).runs;
    expect(runs.map((run) => run.runId)).toContain(runId);

    const verified = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/verify`,
        headers: authHeaders('researcher-operator'),
      }),
      new Map(),
    );
    expect(verified.response.status).toBe(200);
    const report = (
      verified.response.body as {
        report: {
          version: number;
          runId: string;
          exitCode: number;
          checks: Record<string, boolean>;
          gaps: string[];
        };
      }
    ).report;
    expect(report.version).toBe(1);
    expect(report.runId).toBe(runId);
    // Not `exitCode: 0`: a real bundle with more than one checkpoint always
    // has `consistencyProofsValid: false` here — a pre-existing cross-package
    // gap between `@ald/checkpoint` and `@ald/verifier` outside this pack's
    // paths (see this task's contractDeviations). The route's job is to
    // return the real report the verifier produced, not to launder it.
    expect(typeof report.exitCode).toBe('number');
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(report.checks.anchorTxConfirmed).toBe(false);

    const reportGet = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/verification-report`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(reportGet.response.status).toBe(200);
    expect(
      (reportGet.response.body as { report: { runId: string } }).report.runId,
    ).toBe(runId);
  });

  it('404 for a verification report that has never been written', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-no-report',
        maxTurnsPerRun: 2,
        evaluationTurns: 2,
      }),
    );
    const res = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/verification-report`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(res.response.status).toBe(404);
    expect(res.response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('aborts a run (terminal transition, SPEC §7.2/§7.3)', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-abort',
        maxTurnsPerRun: 2,
        evaluationTurns: 2,
      }),
    );
    const aborted = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/abort`,
        headers: authHeaders('researcher-operator'),
        body: { reasonCode: 'test-abort' },
      }),
      new Map(),
    );
    expect(aborted.response.status).toBe(200);
    expect(aborted.response.body).toMatchObject({
      ok: true,
      run: { state: 'aborted-sealed' },
    });
  });

  it('POST /runs/:id/annotate records an audited annotate event (SPEC §14.2)', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-annotate',
        maxTurnsPerRun: 2,
        evaluationTurns: 2,
      }),
    );

    const annotated = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/annotate`,
        headers: { ...authHeaders('researcher-operator'), 'x-ald-actor': 'test-operator' },
        body: { reasonCode: 'manual-note', details: { note: 'looks fine' } },
      }),
      new Map(),
    );
    expect(annotated.response.status).toBe(200);
    expect(annotated.response.body).toMatchObject({
      ok: true,
      event: { eventType: 'annotate', reasonCode: 'manual-note' },
    });

    const audit = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/audit`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    const events = (
      audit.response.body as { audit: { eventType: string; reasonCode: string }[] }
    ).audit;
    expect(
      events.some(
        (event) => event.eventType === 'annotate' && event.reasonCode === 'manual-note',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ledger role-based filtering (SPEC §12.2)
// ---------------------------------------------------------------------------

describe('Ledger role-based filtering (SPEC §12.2)', () => {
  it('GET /runs/:id/ledgers exposes audit-layer content only to researcher-viewer, full content to researcher-operator', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-ledger-filter',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );
    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    const runtime = getNurseryRuntime();
    const firstLedgers = runtime.ledgers(runId);
    const sourceA = firstLedgers.babyA.find((event) => event.turn === 0);
    const sourceB = firstLedgers.babyB.find((event) => event.turn === 0);
    expect(sourceA).toBeDefined();
    expect(sourceB).toBeDefined();
    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    await runtime.interpretAuditBatch({
      runId,
      interpreterVersion: 'route-test-v1',
      entries: [
        {
          babyId: 'A',
          sourceEntryHash: sourceA?.entryHash ?? '',
          content: { term: 'S01', hypothesis: 'target', evidence: 'turn 0' },
        },
        {
          babyId: 'B',
          sourceEntryHash: sourceB?.entryHash ?? '',
          content: { term: 'S01', hypothesis: 'target', evidence: 'turn 0' },
        },
      ],
    });

    const asViewer = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/ledgers`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    expect(asViewer.response.status).toBe(200);
    const viewerBody = asViewer.response.body as {
      ledgers: {
        babyA: { source: string }[];
        babyB: { source: string }[];
      };
      agentNativeEventCounts: { babyA: number; babyB: number };
    };
    expect(
      viewerBody.ledgers.babyA.every(
        (event) => event.source === 'generated-analysis',
      ),
    ).toBe(true);
    expect(
      viewerBody.ledgers.babyB.every(
        (event) => event.source === 'generated-analysis',
      ),
    ).toBe(true);
    // The `no-learning` track's own ledger content is agent-native; the
    // audit layer exposes only its count, never its content (SPEC §12.2).
    expect(viewerBody.agentNativeEventCounts.babyA).toBeGreaterThan(0);
    expect(viewerBody.agentNativeEventCounts.babyB).toBeGreaterThan(0);

    const asOperator = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/ledgers`,
        headers: authHeaders('researcher-operator'),
      }),
      new Map(),
    );
    expect(asOperator.response.status).toBe(200);
    const operatorBody = asOperator.response.body as {
      ledgers: {
        babyA: { contentSchema: string }[];
        babyB: { contentSchema: string }[];
      };
      auditLedgers: { babyA: { source: string }[]; babyB: { source: string }[] };
    };
    // researcher-operator is granted the raw agent-native internals too
    // (SPEC §12.2: "unless also granted researcher-operator").
    expect(
      operatorBody.ledgers.babyA.some(
        (event) => event.contentSchema === 'agent-native-ledger',
      ),
    ).toBe(true);
    expect(operatorBody.auditLedgers.babyA[0]?.source).toBe(
      'generated-analysis',
    );
  });
});

// ---------------------------------------------------------------------------
// Human-view audit coverage (SPEC §14.2)
// ---------------------------------------------------------------------------

describe('Human-view audit coverage (SPEC §14.2)', () => {
  it('GET /runs records a human-view event for every listed run', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-human-view-list',
        maxTurnsPerRun: 2,
        evaluationTurns: 2,
      }),
    );

    const listed = await nursery.pack.handleRequest(
      request({ method: 'GET', path: '/runs', headers: authHeaders('researcher-viewer') }),
      new Map(),
    );
    expect(listed.response.status).toBe(200);

    const audit = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/audit`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    const events = (
      audit.response.body as { audit: { eventType: string; reasonCode: string }[] }
    ).audit;
    expect(
      events.some(
        (event) => event.eventType === 'human-view' && event.reasonCode === 'read-run-list',
      ),
    ).toBe(true);
  });

  it('GET /session/delta records a human-view event for every reported run', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-human-view-delta',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );
    const snapshot = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/session/snapshot',
        headers: authHeaders('researcher-operator'),
      }),
      new Map(),
    );
    const snapshotId = (snapshot.response.body as { snapshotId: string }).snapshotId;
    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    const delta = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/session/delta',
        headers: authHeaders('researcher-viewer'),
        query: { since: snapshotId },
      }),
      new Map(),
    );
    expect(delta.response.status).toBe(200);

    const audit = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/audit`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    const events = (
      audit.response.body as { audit: { eventType: string; reasonCode: string }[] }
    ).audit;
    expect(
      events.some(
        (event) =>
          event.eventType === 'human-view' && event.reasonCode === 'read-session-delta',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session snapshot / restore / delta (SPEC §12.6, §14.4)
// ---------------------------------------------------------------------------

describe('Session snapshot, restore, and delta (SPEC §12.6, §14.4)', () => {
  it('round-trips a snapshot through restore and delta', async () => {
    const nursery = await createNurseryHarness();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-session',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const snapshot = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/session/snapshot',
        headers: authHeaders('researcher-operator'),
      }),
      new Map(),
    );
    expect(snapshot.response.status).toBe(201);
    const snapshotId = (snapshot.response.body as { snapshotId: string }).snapshotId;
    expect(typeof snapshotId).toBe('string');

    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );

    const delta = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/session/delta',
        headers: authHeaders('researcher-viewer'),
        query: { since: snapshotId },
      }),
      new Map(),
    );
    expect(delta.response.status).toBe(200);
    const changed = (delta.response.body as { changed: { runId: string }[] }).changed;
    expect(changed.map((run) => run.runId)).toContain(runId);

    const restored = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/session/restore',
        headers: authHeaders('researcher-operator'),
        body: { snapshotId },
      }),
      new Map(),
    );
    expect(restored.response.status).toBe(200);
    const restoredRuns = (restored.response.body as { runs: { runId: string }[] }).runs;
    expect(restoredRuns.map((run) => run.runId)).toContain(runId);

    const missingDelta = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/session/delta',
        headers: authHeaders('researcher-viewer'),
        query: { since: 'no-such-snapshot' },
      }),
      new Map(),
    );
    expect(missingDelta.response.status).toBe(404);
  });

  it('rejects a traversing snapshotId instead of reading a file outside bundleRoot (SPEC §13.2)', async () => {
    const nursery = await createNurseryHarness();
    const outsideDir = await tempDir('ald-outside-session-');
    await writeFile(join(outsideDir, 'evil.json'), '[]', 'utf8');
    const traversal = `../${outsideDir}/evil`;

    const restored = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: '/session/restore',
        headers: authHeaders('researcher-operator'),
        body: { snapshotId: traversal },
      }),
      new Map(),
    );
    expect(restored.response.status).toBe(400);
    expect(restored.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(restored.response.body)).not.toContain(outsideDir);

    const delta = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/session/delta',
        headers: authHeaders('researcher-viewer'),
        query: { since: traversal },
      }),
      new Map(),
    );
    expect(delta.response.status).toBe(400);
    expect(delta.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('404 for a well-formed but absent snapshot never echoes the server-absolute path', async () => {
    const nursery = await createNurseryHarness();
    const missing = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: '/session/delta',
        headers: authHeaders('researcher-viewer'),
        query: { since: 'well-formed-but-absent' },
      }),
      new Map(),
    );
    expect(missing.response.status).toBe(404);
    expect(JSON.stringify(missing.response.body)).not.toContain(nursery.bundleRoot);
  });
});

// ---------------------------------------------------------------------------
// Baby routes (SPEC §12.4; ALD-048)
// ---------------------------------------------------------------------------

function observationBody(runId: string) {
  return {
    runId,
    observation: {
      runId,
      turn: 0,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      // One candidate row, attribute codes [0, 0], target flag 1 — the
      // shape `resolveGameShape`'s default (`attributeCount: 2`) parses as a
      // sender view (SPEC §11.2; `@ald/learners` game.ts).
      payload: [[0, 0, 1]],
      // Must satisfy `SCENARIO_REF_PATTERN` (`@ald/scenario`) now that
      // `/observe` runs `assertObservationHygiene`: `scn:<16 hex>` is the
      // opaque form `ReferentialScenarioEngine` mints (SPEC §11.2).
      scenarioRef: 'scn:0123456789abcdef',
    },
  };
}

describe('Baby routes (SPEC §12.4)', () => {
  it('observe then act on baby-a returns a schema-valid TurnProposalEnvelope', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-baby-act',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const observed = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/observe',
        headers: authHeaders('internal-controller'),
        body: observationBody(runId),
      }),
      new Map(),
    );
    expect(observed.response.status).toBe(200);
    expect(observed.response.body).toMatchObject({ ok: true });

    const acted = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/act',
        headers: authHeaders('internal-gateway'),
        body: {
          runId,
          turnBudget: {
            turn: 0,
            role: 'sender',
            responseBudgetMs: 1000,
            availableActions: ['emit_symbols'],
          },
        },
      }),
      new Map(),
    );
    expect(acted.response.status).toBe(200);
    const envelope = (acted.response.body as { envelope: unknown }).envelope;
    expect(() => TurnProposalEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('deliver and outcome succeed on baby-a', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-baby-deliver',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const delivered = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/deliver',
        headers: authHeaders('internal-gateway'),
        body: {
          runId,
          delivery: {
            runId,
            turn: 0,
            logicalSender: 'baby-b',
            carrier: 'fixed-token',
            publicArtifact: { symbols: ['S01'] },
            channelEventHash: `sha256:${'a'.repeat(64)}`,
          },
        },
      }),
      new Map(),
    );
    expect(delivered.response.status).toBe(200);
    const ledgerDraft = (delivered.response.body as { ledgerDraft: unknown }).ledgerDraft;
    expect(() => LedgerDraftEnvelopeSchema.parse(ledgerDraft)).not.toThrow();

    const outcome = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/outcome',
        headers: authHeaders('internal-controller'),
        body: {
          runId,
          outcome: {
            runId,
            turn: 0,
            role: 'sender',
            success: true,
            reward: 1,
            payload: [1],
          },
        },
      }),
      new Map(),
    );
    expect(outcome.response.status).toBe(200);
    expect(outcome.response.body).toMatchObject({ ok: true });
  });

  it('GET /ledger exposes only generated audit entries, plus an agent-native count', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-baby-ledger',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );
    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    const runtime = getNurseryRuntime();
    const source = runtime.ledgers(runId).babyA.find((event) => event.turn === 0);
    expect(source).toBeDefined();
    await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/step`,
        headers: authHeaders('internal-controller'),
      }),
      new Map(),
    );
    await runtime.interpretAuditBatch({
      runId,
      interpreterVersion: 'route-test-v1',
      entries: [
        {
          babyId: 'A',
          sourceEntryHash: source?.entryHash ?? '',
          content: { term: 'S01', hypothesis: 'target', evidence: 'turn 0' },
        },
      ],
    });

    const res = await babyA.handleRequest(
      request({
        method: 'GET',
        path: '/ledger',
        headers: authHeaders('researcher-viewer'),
        query: { runId },
      }),
      new Map(),
    );
    expect(res.response.status).toBe(200);
    const body = res.response.body as {
      ledger: { source: string }[];
      agentNativeEventCount: number;
    };
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0]?.source).toBe('generated-analysis');
    // The `no-learning` track's own ledger content is agent-native; the
    // audit layer exposes only its count, never its content (SPEC §12.4).
    expect(body.agentNativeEventCount).toBeGreaterThan(0);

    const asBabyIdentity = await babyA.handleRequest(
      request({
        method: 'GET',
        path: '/ledger',
        headers: authHeaders('internal-gateway'),
        query: { runId },
      }),
      new Map(),
    );
    expect(asBabyIdentity.response.status).toBe(403);
  });

  it('POST /observe fails closed on a hygiene violation and audits the rejection (SPEC §10.1, ALD-038)', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-hygiene-reject',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const observed = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/observe',
        headers: authHeaders('internal-controller'),
        body: {
          runId,
          observation: {
            runId,
            turn: 0,
            recipient: 'baby-a',
            encoding: 'opaque-numeric',
            payload: [[0, 0, 1]],
            // Human-language, non-opaque scenarioRef: banned tokens plus the
            // wrong shape for `SCENARIO_REF_PATTERN` (SPEC §10.1, §11.2).
            scenarioRef: 'target-is-the-red-circle',
          },
        },
      }),
      new Map(),
    );
    expect(observed.response.status).toBe(400);
    expect(observed.response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    const audit = await nursery.pack.handleRequest(
      request({
        method: 'GET',
        path: `/runs/${runId}/audit`,
        headers: authHeaders('researcher-viewer'),
      }),
      new Map(),
    );
    const events = (
      audit.response.body as { audit: { eventType: string; reasonCode: string }[] }
    ).audit;
    expect(
      events.some(
        (event) =>
          event.eventType === 'annotate' &&
          event.reasonCode === 'observation-hygiene-rejected',
      ),
    ).toBe(true);
  });

  it("POST /observe rejects an observation whose nested recipient names the other Baby, even with no top-level naming (SPEC §4.2)", async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-nested-recipient',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    // No top-level `role`/`babyId`/`recipient` key at all — only the nested
    // `observation.recipient` names the other Baby, which `guardOtherBaby`
    // alone (top-level keys only) would miss.
    const body = observationBody(runId) as Record<string, unknown>;
    (body['observation'] as Record<string, unknown>)['recipient'] = 'baby-b';

    const res = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/observe',
        headers: authHeaders('internal-controller'),
        body,
      }),
      new Map(),
    );
    expect(res.response.status).toBe(403);
    expect(res.response.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('Baby tool routes refuse a paused or terminal run with 409 CONFLICT, not a silent adapter mutation (SPEC §7.2)', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-gate-paused',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const paused = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/pause`,
        headers: authHeaders('researcher-operator'),
        body: { reasonCode: 'gate-test' },
      }),
      new Map(),
    );
    expect(paused.response.status).toBe(200);

    const actedWhilePaused = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/act',
        headers: authHeaders('internal-gateway'),
        body: {
          runId,
          turnBudget: {
            turn: 0,
            role: 'sender',
            responseBudgetMs: 1000,
            availableActions: ['emit_symbols'],
          },
        },
      }),
      new Map(),
    );
    expect(actedWhilePaused.response.status).toBe(409);
    expect(actedWhilePaused.response.body).toMatchObject({ error: { code: 'CONFLICT' } });

    const resumed = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/resume`,
        headers: authHeaders('researcher-operator'),
        body: { reasonCode: 'gate-test-resume' },
      }),
      new Map(),
    );
    expect(resumed.response.status).toBe(200);

    const aborted = await nursery.pack.handleRequest(
      request({
        method: 'POST',
        path: `/runs/${runId}/abort`,
        headers: authHeaders('researcher-operator'),
        body: { reasonCode: 'gate-test-abort' },
      }),
      new Map(),
    );
    expect(aborted.response.status).toBe(200);
    expect(aborted.response.body).toMatchObject({ run: { state: 'aborted-sealed' } });

    const outcomeAfterAbort = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/outcome',
        headers: authHeaders('internal-controller'),
        body: {
          runId,
          outcome: {
            runId,
            turn: 0,
            role: 'sender',
            success: true,
            reward: 999,
            payload: [1],
          },
        },
      }),
      new Map(),
    );
    expect(outcomeAfterAbort.response.status).toBe(409);
    expect(outcomeAfterAbort.response.body).toMatchObject({ error: { code: 'CONFLICT' } });
  });
});

// ---------------------------------------------------------------------------
// Baby-to-Baby isolation (SPEC §4.2; closes ALD-029 criterion 1's second half)
// ---------------------------------------------------------------------------

describe('Baby-to-Baby isolation (SPEC §4.2)', () => {
  it("baby-a's pack module does not import anything from baby-b", async () => {
    const source = await readFile(
      fileURLToPath(new URL('../baby-a/behavior/pack.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('baby-b/');
  });

  it("baby-b's pack module does not import anything from baby-a", async () => {
    const source = await readFile(
      fileURLToPath(new URL('../baby-b/behavior/pack.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('baby-a/');
  });

  it('a baby-a request naming baby-b as the target is refused with 403 FORBIDDEN', async () => {
    const nursery = await createNurseryHarness();
    const babyA = await createBabyA();
    const runId = nextRunId();
    await createRunViaRoute(
      nursery,
      noLearningRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed: 'seed-isolation',
        maxTurnsPerRun: 5,
        evaluationTurns: 5,
      }),
    );

    const body = observationBody(runId) as Record<string, unknown>;
    body['role'] = 'baby-b';

    const res = await babyA.handleRequest(
      request({
        method: 'POST',
        path: '/observe',
        headers: authHeaders('internal-controller'),
        body,
      }),
      new Map(),
    );
    expect(res.response.status).toBe(403);
    expect(res.response.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('there is no route, direct or otherwise, from baby-a to baby-b (ALD-029)', async () => {
    const babyA = await createBabyA();
    for (const pattern of BABY_A_ROUTE_PATTERNS) {
      expect(pattern.includes('baby-b')).toBe(false);
    }
    // The only way to reach an adapter at all is through
    // `getNurseryRuntime().adaptersFor(runId)`, keyed by this pack's own
    // fixed role — there is no code path in `baby-a`'s pack that can select
    // `adaptersFor(runId)['baby-b']`.
    const res = await babyA.handleRequest(
      request({ method: 'GET', path: '/baby-b/ledger' }),
      new Map(),
    );
    expect(res.response.status).toBe(404);
  });
});
