/**
 * `nursery` twin pack: the Nursery Controller's DTSF surface
 * (SPECIFICATION.md §12.5, §12.6; BACKLOG ALD-049, ALD-050).
 *
 * `init(context)` builds one Prototype Mode (§5.1) `NurseryRuntimeImpl` per
 * process — a real SQLite-backed evidence store, the real
 * `EvidenceCheckpointService` (`@ald/checkpoint`), `anchorPolicy: 'skip'`
 * (no Base anchor in this harness), and the real `@ald/verifier` — and
 * registers it with `@ald/orchestrator`'s process-wide registry so
 * `baby-a`/`baby-b` can reach the same runtime without importing this pack
 * or each other (Mode P convenience only; see `registry.ts`).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
  RunConfigSchema,
  type BehaviorPack,
  type BehaviorPackContext,
  type BehaviorPackResult,
  type CheckpointService,
  type Clock,
  type Intervention,
  type LedgerEvent,
  type RunSummary,
  type SignerRegistry,
  type StateMutation,
  type TwinEvent,
  type TwinRequest,
} from '@ald/types';
import {
  createNurseryRuntime,
  setNurseryRuntime,
  type NurseryRuntimeImpl,
} from '@ald/orchestrator';
import {
  openEvidenceDatabase,
  type SqliteEvidenceWriter,
} from '@ald/evidence';
import { EvidenceCheckpointService } from '@ald/checkpoint';
import { verifyBundle } from '@ald/verifier';
import { InMemorySignerRegistry } from '@ald/hashing';
import { RUN_ID_PATTERN, ScenarioBundleRegistry } from '@ald/scenario';
import {
  asRecord,
  createRouter,
  failure,
  InvalidRequestError,
  requireString,
  success,
  type RouteDefinition,
} from './http.js';

export const NURSERY_ROUTE_PATTERNS = [
  '/runs',
  '/runs/:id',
  '/runs/:id/step',
  '/runs/:id/transcript',
  '/runs/:id/ledgers',
  '/runs/:id/audit',
  '/runs/:id/checkpoints',
  '/runs/:id/pause',
  '/runs/:id/resume',
  '/runs/:id/abort',
  '/runs/:id/annotate',
  '/runs/:id/verification-report',
  '/runs/:id/verify',
  '/session/snapshot',
  '/session/restore',
  '/session/delta',
] as const;

/** State-Map keys `init(context)` reads to configure the runtime (Mode P). */
const DATABASE_PATH_KEY = 'databasePath';
const BUNDLE_ROOT_KEY = 'bundleRoot';
const SOFTWARE_COMMIT_KEY = 'softwareCommit';

/** Verbatim per SPEC §17.1's Mode P/Mode R claim-boundary requirement. */
const VERIFIER_VERSION = '0.1.0';

interface NurseryInternals {
  runtime: NurseryRuntimeImpl;
  bundleRoot: string;
  writeProofFiles: (runId: string, bundleDir: string) => Promise<void>;
}

/** Stashed on `BehaviorPackContext.state` so the static route table below can reach it. */
const INTERNALS_KEY = 'nurseryInternals';

function internalsFrom(context: BehaviorPackContext): NurseryInternals {
  const internals = context.state.get(INTERNALS_KEY) as
    | NurseryInternals
    | undefined;
  if (internals === undefined) {
    throw new Error(
      'NurseryPack.init(context) has not run yet; no runtime is configured',
    );
  }
  return internals;
}

function parseIntervention(body: unknown, actorId: string): Intervention {
  const record = asRecord(body, 'intervention body');
  const reasonCode = requireString(record, 'reasonCode');
  const details = record['details'];
  return {
    actorId,
    reasonCode,
    ...(details === undefined
      ? {}
      : { details: details as Record<string, unknown> }),
  };
}

/**
 * SPEC §13.2 fixes the evidence layout as `evidence/runs/<run-id>/`; a
 * traversing `runId` (`../`, an absolute path, a NUL byte) escapes that
 * layout because `NurseryRuntimeImpl` derives the bundle directory with a
 * bare `join(bundleRoot, 'runs', runId)` (no containment check of its own).
 * `RUN_ID_PATTERN` (`@ald/scenario`, already the allowlist §10.1 enforces on
 * every Observation's `runId`) is necessary but not sufficient here — it
 * still admits `/` and `.` — so this also rejects the path-traversal
 * metacharacters directly, before `createRun` ever touches the filesystem.
 */
function assertPathSafeRunId(runId: string): void {
  if (
    !RUN_ID_PATTERN.test(runId) ||
    runId.includes('/') ||
    runId.includes('\\') ||
    runId.includes('..') ||
    runId.includes('\0')
  ) {
    throw new InvalidRequestError(
      `"runId" must be a path-safe opaque identifier (SPEC §13.2); got ${JSON.stringify(runId)}`,
    );
  }
}

/**
 * Opaque shape `POST /session/snapshot` mints (see its handler below):
 * an ISO timestamp with `:`/`.` replaced by `-`, then `-`, then 8 lowercase
 * hex characters. Deliberately does not admit `/`, `\`, or `.` at all, so a
 * traversal segment cannot be built from allowed characters regardless of
 * the resolved-path check that follows.
 */
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * SPEC §12.2/§12.6: `/session/restore` and `/session/delta` take a
 * caller-supplied snapshot id and read `<bundleRoot>/session/<id>.json`.
 * Validates the id against the exact minted shape and then requires the
 * resolved path to still live inside `<bundleRoot>/session` — belt and
 * suspenders against a traversal segment, since the pattern above already
 * excludes every character a traversal needs.
 */
function resolveSnapshotPath(bundleRoot: string, snapshotId: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new InvalidRequestError(
      '"snapshotId" must be an opaque identifier minted by POST /session/snapshot',
    );
  }
  const sessionDir = resolve(bundleRoot, 'session');
  const candidate = resolve(sessionDir, `${snapshotId}.json`);
  if (!candidate.startsWith(`${sessionDir}${sep}`)) {
    throw new InvalidRequestError(
      '"snapshotId" must resolve inside the session directory',
    );
  }
  return candidate;
}

/** True for a `readFile` rejection caused by a missing file. */
function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Reads and parses a minted session snapshot file. Never surfaces the
 * server-absolute path or raw file bytes in an error message (SPEC §12.3) —
 * `mapError`'s generic `SyntaxError`/`ENOENT` handling would otherwise leak
 * both for this one call site, since Node's `JSON.parse` message embeds the
 * offending bytes and an `ENOENT` message embeds the absolute path.
 */
async function readSnapshotFile(
  snapshotPath: string,
  snapshotId: string,
): Promise<RunSummary[]> {
  let raw: string;
  try {
    raw = await readFile(snapshotPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new SnapshotNotFoundError(snapshotId);
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as RunSummary[];
  } catch {
    throw new InvalidRequestError(
      `snapshot "${snapshotId}" is not valid JSON`,
    );
  }
}

/** Mapped to `404 NOT_FOUND` with a fixed message (never the absolute path). */
class SnapshotNotFoundError extends Error {
  constructor(readonly snapshotId: string) {
    super(`snapshot "${snapshotId}" was not found`);
    this.name = 'SnapshotNotFoundError';
  }
}

/**
 * SPEC §12.2: `researcher-viewer` reads "ledgers (audit layer only, not raw
 * agent-native internals unless also granted `researcher-operator`)" —
 * exactly the filter the Baby packs' own `GET /ledger` route already applies
 * to its single stream. This applies it to both streams for the nursery's
 * aggregate route.
 */
function auditLayerOnly(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events.filter((event) => event.contentSchema === 'human-audit-ledger');
}

function agentNativeCount(events: readonly LedgerEvent[]): number {
  return events.filter((event) => event.contentSchema === 'agent-native-ledger')
    .length;
}

/**
 * `writeProofFiles` reads only already-committed, already-signed evidence
 * (SPEC §13.3-§13.5) — it never signs anything itself — so a throwaway
 * signer registry is safe here; it is never used to produce evidence.
 */
function buildProofWriter(
  runtime: NurseryRuntimeImpl,
  clock: Clock,
  softwareCommit: string,
): (runId: string, bundleDir: string) => Promise<void> {
  return async (runId, bundleDir) => {
    const evidence: SqliteEvidenceWriter = runtime.writerFor(runId);
    const signers: SignerRegistry = InMemorySignerRegistry.generate(
      `proof-writer:${runId}`,
    );
    const service = new EvidenceCheckpointService({
      evidence,
      signers,
      clock,
      softwareCommit,
    });
    await service.writeProofFiles(runId, bundleDir);
  };
}

const routes: RouteDefinition[] = [
  {
    method: 'POST',
    pattern: '/runs',
    roles: ['researcher-operator'],
    handler: async ({ body, context }) => {
      const { runtime } = internalsFrom(context);
      const config = RunConfigSchema.parse(body);
      assertPathSafeRunId(config.runId);
      const run = await runtime.createRun(config);
      return success({ run }, 201);
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/step',
    roles: ['internal-controller'],
    handler: async ({ params, context }) => {
      const { runtime } = internalsFrom(context);
      const turnResult = await runtime.step(params['id'] ?? '');
      let run = runtime.getRun(params['id'] ?? '');
      if (run?.state === 'sealing') {
        run = await runtime.seal(params['id'] ?? '');
      }
      return success({ turnResult, run });
    },
  },
  {
    method: 'GET',
    pattern: '/runs',
    roles: ['researcher-viewer'],
    handler: async ({ actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runs = runtime.listRuns();
      // SPEC §14.2: "every human read is logged as a low-noise
      // `audit.human_view` event"; non-blocking, one per reported run.
      await Promise.all(
        runs.map((run) =>
          runtime
            .recordHumanView(run.runId, { actorId, reasonCode: 'read-run-list' })
            .catch(() => undefined),
        ),
      );
      return success({ runs });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id',
    roles: ['researcher-viewer'],
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const run = runtime.getRun(runId);
      if (run === undefined) {
        return failure('NOT_FOUND', `run "${runId}" is not loaded`);
      }
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-run-summary' })
        .catch(() => undefined);
      return success({ run });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id/transcript',
    roles: ['researcher-viewer'],
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const transcript = runtime.transcript(runId);
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-transcript' })
        .catch(() => undefined);
      return success({ transcript });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id/ledgers',
    roles: ['researcher-viewer'],
    // SPEC §12.2: `researcher-viewer` may read "ledgers (audit layer only,
    // not raw agent-native internals unless also granted
    // `researcher-operator`)"; `roleSatisfies` lets a `researcher-operator`
    // credential reach this route too (it may do everything a viewer may),
    // so `role` (the *authenticated* role, not the route's requirement) is
    // what decides which shape comes back.
    handler: async ({ params, actorId, role, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const ledgers = runtime.ledgers(runId);
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-ledgers' })
        .catch(() => undefined);
      if (role === 'researcher-operator') {
        return success({ ledgers });
      }
      return success({
        ledgers: {
          babyA: auditLayerOnly(ledgers.babyA),
          babyB: auditLayerOnly(ledgers.babyB),
        },
        agentNativeEventCounts: {
          babyA: agentNativeCount(ledgers.babyA),
          babyB: agentNativeCount(ledgers.babyB),
        },
      });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id/audit',
    roles: ['researcher-viewer'],
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const audit = runtime.auditLog(runId);
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-audit' })
        .catch(() => undefined);
      return success({ audit });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id/checkpoints',
    roles: ['researcher-viewer'],
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const checkpoints = runtime.checkpoints(runId);
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-checkpoints' })
        .catch(() => undefined);
      return success({ checkpoints });
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/pause',
    roles: ['researcher-operator'],
    handler: async ({ params, body, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const run = await runtime.pause(
        params['id'] ?? '',
        parseIntervention(body, actorId),
      );
      return success({ run });
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/resume',
    roles: ['researcher-operator'],
    handler: async ({ params, body, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const run = await runtime.resume(
        params['id'] ?? '',
        parseIntervention(body, actorId),
      );
      return success({ run });
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/abort',
    roles: ['researcher-operator'],
    handler: async ({ params, body, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const run = await runtime.abort(
        params['id'] ?? '',
        parseIntervention(body, actorId),
      );
      return success({ run });
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/annotate',
    roles: ['researcher-operator'],
    // SPEC §12.2 grants `researcher-operator` "annotation routes"; §14.2
    // names `annotate` as one of the four human interventions that must be
    // role-gated and written to `intervention_log`.
    // `NurseryRuntimeImpl.annotate` already implements the §14.2 checkpoint
    // semantics — this route is its only entry point.
    handler: async ({ params, body, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const event = await runtime.annotate(
        params['id'] ?? '',
        parseIntervention(body, actorId),
      );
      return success({ event });
    },
  },
  {
    method: 'GET',
    pattern: '/runs/:id/verification-report',
    roles: ['researcher-viewer'],
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const bundleDir = runtime.bundleDirFor(runId);
      const raw = await readFile(
        join(bundleDir, 'verification-report.json'),
        'utf8',
      );
      await runtime
        .recordHumanView(runId, {
          actorId,
          reasonCode: 'read-verification-report',
        })
        .catch(() => undefined);
      return success({ report: JSON.parse(raw) as unknown });
    },
  },
  {
    method: 'POST',
    pattern: '/runs/:id/verify',
    roles: ['researcher-operator'],
    handler: async ({ params, context }) => {
      const { runtime, writeProofFiles } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const bundleDir = runtime.bundleDirFor(runId);
      await runtime.exportBundle(runId, bundleDir);
      // `seal()` writes proof files as part of finishing a run; this route
      // must also work on a still-running run (ALD-050), so it writes them
      // itself rather than requiring the run to be sealed first.
      await writeProofFiles(runId, bundleDir);
      const report = await runtime.verify(runId, bundleDir);
      return success({ report });
    },
  },
  {
    method: 'POST',
    pattern: '/session/snapshot',
    roles: ['researcher-operator'],
    handler: async ({ context }) => {
      const { runtime, bundleRoot } = internalsFrom(context);
      const sessionDir = join(bundleRoot, 'session');
      await mkdir(sessionDir, { recursive: true });
      const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      const runs = runtime.listRuns();
      await writeFile(
        join(sessionDir, `${snapshotId}.json`),
        JSON.stringify(runs, null, 2),
        'utf8',
      );
      return success({ snapshotId }, 201);
    },
  },
  {
    method: 'POST',
    pattern: '/session/restore',
    roles: ['researcher-operator'],
    handler: async ({ body, context }) => {
      const { runtime, bundleRoot } = internalsFrom(context);
      const record = asRecord(body, 'session/restore body');
      const snapshotId = requireString(record, 'snapshotId');
      const snapshotPath = resolveSnapshotPath(bundleRoot, snapshotId);
      let runs: RunSummary[];
      try {
        runs = await readSnapshotFile(snapshotPath, snapshotId);
      } catch (error) {
        if (error instanceof SnapshotNotFoundError) {
          return failure('NOT_FOUND', error.message);
        }
        throw error;
      }
      const restored: RunSummary[] = [];
      for (const entry of runs) {
        restored.push(await runtime.recover(entry.runId));
      }
      return success({ runs: restored });
    },
  },
  {
    method: 'GET',
    pattern: '/session/delta',
    roles: ['researcher-viewer'],
    handler: async ({ request, actorId, context }) => {
      const { runtime, bundleRoot } = internalsFrom(context);
      const since = request.query['since'];
      if (since === undefined || since.length === 0) {
        return failure(
          'INVALID_REQUEST',
          '"since" query parameter (a snapshotId) is required',
        );
      }
      const snapshotPath = resolveSnapshotPath(bundleRoot, since);
      let prior: RunSummary[];
      try {
        prior = await readSnapshotFile(snapshotPath, since);
      } catch (error) {
        if (error instanceof SnapshotNotFoundError) {
          return failure('NOT_FOUND', error.message);
        }
        throw error;
      }
      const priorByRunId = new Map(prior.map((run) => [run.runId, run]));
      const changed = runtime.listRuns().filter((run) => {
        const before = priorByRunId.get(run.runId);
        return (
          before === undefined ||
          before.state !== run.state ||
          before.turn !== run.turn
        );
      });
      // SPEC §14.2: non-blocking, one human-view event per run this read
      // actually reported a delta for.
      await Promise.all(
        changed.map((run) =>
          runtime
            .recordHumanView(run.runId, {
              actorId,
              reasonCode: 'read-session-delta',
            })
            .catch(() => undefined),
        ),
      );
      return success({ since, changed });
    },
  },
];

const dispatch = createRouter(routes);

export default class NurseryPack implements BehaviorPack {
  private context!: BehaviorPackContext;

  async init(context: BehaviorPackContext): Promise<void> {
    this.context = context;

    const databasePath =
      (context.state.get(DATABASE_PATH_KEY) as string | undefined) ??
      ':memory:';
    const softwareCommit =
      (context.state.get(SOFTWARE_COMMIT_KEY) as string | undefined) ??
      'git:nursery-prototype';
    const bundleRoot =
      (context.state.get(BUNDLE_ROOT_KEY) as string | undefined) ??
      (await mkdtemp(join(tmpdir(), 'ald-nursery-')));

    const database = openEvidenceDatabase(databasePath);
    const clock: Clock = { now: () => new Date().toISOString() };
    const scenarioBundleRegistry = new ScenarioBundleRegistry({
      directory: join(bundleRoot, 'scenario-registry'),
      clock,
    });

    const checkpointFactory = (
      evidence: SqliteEvidenceWriter,
      signers: SignerRegistry,
    ): CheckpointService =>
      new EvidenceCheckpointService({
        evidence,
        signers,
        clock,
        softwareCommit,
      });

    // `proofWriter` needs the runtime it closes over (`writerFor`), but the
    // runtime does not exist until `createNurseryRuntime` returns and
    // `proofWriter` is one of its options — so this holder's `runtime`
    // property is filled in immediately after construction, and is only
    // ever read later, when `seal()` (or the `/verify` route below) calls
    // the function. A `const` object with a mutable property (rather than a
    // `let` binding) keeps this readable under `prefer-const`.
    const holder: { runtime: NurseryRuntimeImpl | undefined } = {
      runtime: undefined,
    };
    const proofWriter = async (
      runId: string,
      bundleDir: string,
    ): Promise<void> => {
      if (holder.runtime === undefined) {
        throw new Error('NurseryPack runtime is not initialized yet');
      }
      await buildProofWriter(
        holder.runtime,
        clock,
        softwareCommit,
      )(runId, bundleDir);
    };

    const runtime = createNurseryRuntime({
      database,
      softwareCommit,
      bundleRoot,
      checkpointFactory,
      clock,
      // Mode P prototype (§5.1): no Base anchor publisher is wired here, so
      // anchoring is a declared, audited governance decision, not a silent
      // omission (SPEC §7.2, §13.4).
      anchorPolicy: 'skip',
      verifier: (bundleDir) =>
        verifyBundle(bundleDir, {
          verifierVersion: VERIFIER_VERSION,
          now: () => clock.now(),
          allowUnanchored: true,
        }),
      proofWriter,
      scenarioBundleRegistry,
    });
    holder.runtime = runtime;

    setNurseryRuntime(runtime);

    const internals: NurseryInternals = {
      runtime,
      bundleRoot,
      writeProofFiles: buildProofWriter(runtime, clock, softwareCommit),
    };
    context.state.set(INTERNALS_KEY, internals);
  }

  handleRequest(
    request: TwinRequest,
    _state: Map<string, unknown>,
  ): Promise<BehaviorPackResult> {
    return dispatch(request, this.context);
  }

  emitEvents(mutations: StateMutation[]): TwinEvent[] {
    return mutations.map((mutation) => ({
      type: `${mutation.type}.${mutation.entity}`,
      source: this.context.twinName,
      timestamp: Date.now(),
      data: { key: mutation.key, value: mutation.value },
    }));
  }

  validateInvariants(_state: Map<string, unknown>): string[] {
    return [];
  }

  describeCapabilities(): string[] {
    return [
      'run-lifecycle',
      'evidence-routes',
      'verification-routes',
      'session-snapshot',
      'prototype-mode',
    ];
  }
}
