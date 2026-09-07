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
import { join } from 'node:path';

import {
  RunConfigSchema,
  type BehaviorPack,
  type BehaviorPackContext,
  type BehaviorPackResult,
  type CheckpointService,
  type Clock,
  type Intervention,
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
import {
  asRecord,
  createRouter,
  failure,
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
    handler: ({ context }) => {
      const { runtime } = internalsFrom(context);
      return success({ runs: runtime.listRuns() });
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
    handler: async ({ params, actorId, context }) => {
      const { runtime } = internalsFrom(context);
      const runId = params['id'] ?? '';
      const ledgers = runtime.ledgers(runId);
      await runtime
        .recordHumanView(runId, { actorId, reasonCode: 'read-ledgers' })
        .catch(() => undefined);
      return success({ ledgers });
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
      const raw = await readFile(
        join(bundleRoot, 'session', `${snapshotId}.json`),
        'utf8',
      );
      const runs = JSON.parse(raw) as RunSummary[];
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
    handler: async ({ request, context }) => {
      const { runtime, bundleRoot } = internalsFrom(context);
      const since = request.query['since'];
      if (since === undefined || since.length === 0) {
        return failure(
          'INVALID_REQUEST',
          '"since" query parameter (a snapshotId) is required',
        );
      }
      const raw = await readFile(
        join(bundleRoot, 'session', `${since}.json`),
        'utf8',
      );
      const prior = JSON.parse(raw) as RunSummary[];
      const priorByRunId = new Map(prior.map((run) => [run.runId, run]));
      const changed = runtime.listRuns().filter((run) => {
        const before = priorByRunId.get(run.runId);
        return (
          before === undefined ||
          before.state !== run.state ||
          before.turn !== run.turn
        );
      });
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
