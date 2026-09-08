/**
 * ALD-060 — snapshot and restore (SPECIFICATION.md §14.4).
 *
 * §14.4: "automatic snapshots every 300 seconds
 * (`DTSF_SNAPSHOT_INTERVAL_MS`, configurable), a final snapshot on graceful
 * shutdown (SIGINT/SIGTERM), and `autoRestore()` on startup loading the
 * latest snapshot. Ledger/channel/checkpoint state additionally has its own
 * independent integrity chain (§13), so a DTSF snapshot restore MUST be
 * followed by the recovery procedure in §7.3 (verify committed prefix before
 * accepting new writes), not treated as a substitute for it."
 *
 * That sentence fixes the division of labour implemented here:
 *
 * - a snapshot is **derived state only** — run ids, lifecycle state, turn and
 *   budget cursors, exported policies, and the chain heads as they stood. It
 *   is never authoritative: the evidence store is (SPEC §13, LEDGER §3).
 * - restore therefore never replays a snapshot into the store. It writes each
 *   run's recorded policy back to the `policies/<role>-latest.json` seam the
 *   runtime already reloads, then calls the runtime's own `recover(runId)`,
 *   which is the §7.3 procedure (verify the committed prefix, continue at the
 *   next sequence, append an explicit `recovery` event).
 * - the snapshot's own integrity claim is only "these are the heads I saw":
 *   {@link verifySnapshotPrefix} re-reads the committed prefix and re-walks it
 *   with `validateChain`, so ALD-060 criterion 3 ("matches, byte-for-byte in
 *   the chain-walk sense") is checked against the store rather than asserted.
 *
 * The recovery event and its mandatory checkpoint (§7.3, §14.2) are appended
 * *after* the snapshot's prefix, which is why criterion 3 is expressed as
 * "the snapshot's prefix is intact and still walks", not "the heads are
 * unchanged": a restore that left no trace would contradict §7.3.
 */
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { z } from 'zod';
import type { ChainValidationResult } from '@ald/hashing';
import {
  canonicalJson,
  hashCanonical,
  isSignedStream,
  parseCanonicalJson,
  validateChain,
} from '@ald/hashing';
import {
  EVENT_STREAMS,
  GENESIS_HASH,
  HASH_DOMAINS,
  STREAM_SIGNER,
  type BabyRole,
  type Clock,
  type EventStream,
  type EvidenceReader,
  type LearnerAdapter,
  type RunState,
  type RunSummary,
  type Sha256Hash,
} from '@ald/types';

import { SnapshotError } from './errors.js';
import { turnPhaseCounts } from './metrics.js';

/** SPEC §14.4 default cadence: 300 seconds. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 300_000;

/** SPEC §14.4 names this environment variable; it is read, never written. */
export const SNAPSHOT_INTERVAL_ENV_VAR = 'DTSF_SNAPSHOT_INTERVAL_MS';

export const RUNTIME_SNAPSHOT_VERSION = 1;

const isoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { message: 'must be an ISO-8601 timestamp' },
);
const nonEmptyString = z.string().min(1);
const hashString = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const ChainHeadSnapshotSchema = z
  .object({ size: z.number().int().min(0), lastEntryHash: hashString })
  .strict();

const RuntimeSnapshotRunSchema = z
  .object({
    runId: nonEmptyString,
    state: nonEmptyString,
    /** Next turn index to execute. */
    turn: z.number().int().min(0),
    trainingCount: z.number().int().min(0),
    evaluationCount: z.number().int().min(0),
    configurationHash: hashString,
    /**
     * `exportPolicy()` of each Baby's adapter. Canonicalizable by contract
     * (SPEC §6.2), and never prompt text, raw model output, or a seed.
     */
    policies: z
      .object({ babyA: z.unknown(), babyB: z.unknown() })
      .strict(),
    /** `hashCanonical(HASH_DOMAINS.policyCheckpoint, policy)` per role. */
    policyHashes: z
      .object({ babyA: hashString, babyB: hashString })
      .strict(),
    lastCheckpointHash: hashString.nullable(),
    chainHeads: z.record(z.string(), ChainHeadSnapshotSchema),
  })
  .strict();

export const RuntimeSnapshotSchema = z
  .object({
    version: z.literal(RUNTIME_SNAPSHOT_VERSION),
    takenAt: isoDateTime,
    softwareCommit: nonEmptyString,
    runs: z.array(RuntimeSnapshotRunSchema),
    digest: hashString,
  })
  .strict();

export type ChainHeadSnapshot = z.infer<typeof ChainHeadSnapshotSchema>;
export type RuntimeSnapshotRun = z.infer<typeof RuntimeSnapshotRunSchema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

/**
 * The runtime surface a snapshot needs. `NurseryRuntimeImpl` satisfies it
 * structurally; nothing here imports the orchestrator, so a Mode R remote
 * runtime client can be snapshotted through the same interface.
 */
export interface SnapshotSource {
  listRuns(): RunSummary[];
  adaptersFor(runId: string): Readonly<Record<BabyRole, LearnerAdapter>>;
  writerFor(runId: string): SnapshotEvidenceReader;
}

/** The read-only evidence slice a snapshot and its verification need. */
export type SnapshotEvidenceReader = Pick<
  EvidenceReader,
  'chainHead' | 'readEvents' | 'readCheckpoints' | 'readRunSigners'
> & { readonly softwareCommit?: string };

function policyHash(policy: unknown): Sha256Hash {
  return hashCanonical(HASH_DOMAINS.policyCheckpoint, policy ?? null);
}

function chainHeadsOf(
  evidence: SnapshotEvidenceReader,
  runId: string,
): Record<string, ChainHeadSnapshot> {
  const heads: Record<string, ChainHeadSnapshot> = {};
  for (const stream of EVENT_STREAMS) {
    const head = evidence.chainHead(runId, stream);
    heads[stream] = { size: head.size, lastEntryHash: head.lastEntryHash };
  }
  return heads;
}

export interface BuildSnapshotOptions {
  runtime: SnapshotSource;
  clock: Clock;
  /** Recorded verbatim; defaults to a run writer's own `softwareCommit`. */
  softwareCommit?: string;
}

/**
 * Builds the snapshot object without writing it. Pure apart from the reads it
 * performs, so a caller can hash or diff a snapshot it never persists.
 */
export function buildRuntimeSnapshot(
  options: BuildSnapshotOptions,
): RuntimeSnapshot {
  const summaries = options.runtime.listRuns();
  const runs: RuntimeSnapshotRun[] = [];
  let observedCommit: string | undefined;

  for (const summary of [...summaries].sort((left, right) =>
    left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
  )) {
    const evidence = options.runtime.writerFor(summary.runId);
    observedCommit ??= evidence.softwareCommit;
    const adapters = options.runtime.adaptersFor(summary.runId);
    const babyA = adapters['baby-a'].exportPolicy();
    const babyB = adapters['baby-b'].exportPolicy();
    const counts = turnPhaseCounts(evidence, summary.runId);
    const checkpoints = evidence.readCheckpoints(summary.runId);
    runs.push({
      runId: summary.runId,
      state: summary.state,
      turn: summary.turn,
      trainingCount: counts.trainingCount,
      evaluationCount: counts.evaluationCount,
      configurationHash: summary.configurationHash,
      policies: { babyA, babyB },
      policyHashes: { babyA: policyHash(babyA), babyB: policyHash(babyB) },
      lastCheckpointHash: checkpoints.at(-1)?.checkpointHash ?? null,
      chainHeads: chainHeadsOf(evidence, summary.runId),
    });
  }

  const body = {
    version: RUNTIME_SNAPSHOT_VERSION as typeof RUNTIME_SNAPSHOT_VERSION,
    takenAt: options.clock.now(),
    softwareCommit: options.softwareCommit ?? observedCommit ?? 'unknown',
    runs,
  };
  return {
    ...body,
    digest: hashCanonical(HASH_DOMAINS.runtimeSnapshot, body),
  };
}

/** Recomputes a snapshot's digest over everything but the digest field. */
export function snapshotDigest(snapshot: RuntimeSnapshot): Sha256Hash {
  const { digest, ...body } = snapshot;
  void digest;
  return hashCanonical(HASH_DOMAINS.runtimeSnapshot, body);
}

/**
 * File name of one snapshot: the ISO instant with `:`/`.` replaced by `-`,
 * then the first eight hex characters of the digest. Sorting the directory
 * lexically therefore sorts it chronologically, and two snapshots taken in
 * the same millisecond with different content cannot collide.
 */
export function snapshotFileName(snapshot: RuntimeSnapshot): string {
  const stamp = snapshot.takenAt.replace(/[:.]/gu, '-');
  const digest8 = snapshot.digest.slice('sha256:'.length, 'sha256:'.length + 8);
  return `${stamp}-${digest8}.json`;
}

function assertInside(directory: string, candidate: string): void {
  const root = resolve(directory);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new SnapshotError(
      'snapshot-path-escape',
      'snapshot path resolves outside the snapshot directory',
      { name: basename(candidate) },
    );
  }
}

export interface TakeSnapshotResult {
  snapshot: RuntimeSnapshot;
  path: string;
}

/**
 * ALD-060 criterion 1: the manual "take snapshot now" action. Writes one
 * canonical JSON file (RFC 8785 + trailing newline, like every other artifact
 * in this project) that {@link readSnapshotFile} and {@link autoRestore}
 * consume unchanged.
 */
export async function takeSnapshot(
  runtime: SnapshotSource,
  directory: string,
  options: { clock: Clock; softwareCommit?: string },
): Promise<TakeSnapshotResult> {
  const snapshot = buildRuntimeSnapshot({
    runtime,
    clock: options.clock,
    ...(options.softwareCommit === undefined
      ? {}
      : { softwareCommit: options.softwareCommit }),
  });
  await mkdir(directory, { recursive: true });
  const path = join(directory, snapshotFileName(snapshot));
  assertInside(directory, path);
  await writeFile(path, `${canonicalJson(snapshot)}\n`, 'utf8');
  return { snapshot, path };
}

/** Snapshot file names in the directory, oldest first. Empty when absent. */
export async function listSnapshots(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.json')).sort();
}

/** Path of the newest snapshot, or `undefined` when the directory is empty. */
export async function latestSnapshotPath(
  directory: string,
): Promise<string | undefined> {
  const names = await listSnapshots(directory);
  const newest = names.at(-1);
  return newest === undefined ? undefined : join(directory, newest);
}

/**
 * Reads, schema-checks, and digest-checks one snapshot file. A digest
 * mismatch is an error rather than a warning: a snapshot whose body was
 * edited cannot be used to decide whether a store matches it.
 */
export async function readSnapshotFile(path: string): Promise<RuntimeSnapshot> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new SnapshotError('snapshot-not-found', 'snapshot file is not readable', {
      name: basename(path),
    });
  }
  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(text.trimEnd());
  } catch {
    throw new SnapshotError('snapshot-invalid', 'snapshot file is not valid JSON', {
      name: basename(path),
    });
  }
  const result = RuntimeSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    throw new SnapshotError(
      'snapshot-invalid',
      'snapshot file does not satisfy RuntimeSnapshotSchema',
      {
        name: basename(path),
        issues: result.error.issues.map((issue) => issue.path.join('.')),
      },
    );
  }
  const snapshot = result.data;
  const recomputed = snapshotDigest(snapshot);
  if (recomputed !== snapshot.digest) {
    throw new SnapshotError(
      'snapshot-digest-mismatch',
      'snapshot digest does not match its content',
      { name: basename(path), recorded: snapshot.digest, recomputed },
    );
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Chain-walk verification (ALD-060 criterion 3)
// ---------------------------------------------------------------------------

export interface StreamPrefixCheck {
  stream: EventStream;
  /** Snapshot's recorded head for this stream. */
  expected: ChainHeadSnapshot;
  /** Store's head now. `size` may exceed the snapshot's after recovery. */
  observed: ChainHeadSnapshot;
  /** The snapshot's prefix is present and its last entry hash matches. */
  prefixIntact: boolean;
  /** `validateChain` over the snapshot's prefix reported no violation. */
  chainWalkOk: boolean;
  violations: string[];
}

export interface RunPrefixCheck {
  runId: string;
  ok: boolean;
  streams: StreamPrefixCheck[];
}

/**
 * Re-reads each snapshotted run's committed prefix and checks two things per
 * stream: the entry at the snapshot's `size` still has the snapshot's
 * `lastEntryHash` (the prefix was not rewritten), and `validateChain` over
 * that prefix reports no violation (it still walks — canonical entry hashes,
 * links, signatures, strictly increasing sequences).
 *
 * `validateChain` reads each stream's own link field, so the channel's
 * `previousChannelHash` is handled (SPEC §11.5). The unsigned `intervention`
 * stream is walked without signature checks (LEDGER §6).
 */
export function verifySnapshotPrefix(
  evidence: SnapshotEvidenceReader,
  snapshot: RuntimeSnapshot,
): RunPrefixCheck[] {
  return snapshot.runs.map((run) => {
    const publicKeys = new Map(
      evidence
        .readRunSigners(run.runId)
        .map((signer) => [signer.domain, signer.publicKey]),
    );
    const streams: StreamPrefixCheck[] = [];
    for (const stream of EVENT_STREAMS) {
      const expected = run.chainHeads[stream];
      if (expected === undefined) {
        continue;
      }
      const head = evidence.chainHead(run.runId, stream);
      const observed: ChainHeadSnapshot = {
        size: head.size,
        lastEntryHash: head.lastEntryHash,
      };
      const prefix =
        expected.size === 0
          ? []
          : evidence
              .readEvents(run.runId, stream, { toSequence: expected.size })
              .map(
                (event) =>
                  parseCanonicalJson(event.canonicalJson) as Record<
                    string,
                    unknown
                  >,
              );
      const signingKey = isSignedStream(stream)
        ? publicKeys.get(STREAM_SIGNER[stream])
        : undefined;
      const walked: ChainValidationResult =
        expected.size === 0
          ? { ok: true, size: 0, lastEntryHash: GENESIS_HASH, violations: [] }
          : validateChain(stream, prefix, {
              runId: run.runId,
              ...(signingKey === undefined
                ? {}
                : { publicKey: signingKey, requireSignatures: true }),
            });
      streams.push({
        stream,
        expected,
        observed,
        prefixIntact:
          walked.size === expected.size &&
          walked.lastEntryHash === expected.lastEntryHash &&
          head.size >= expected.size,
        chainWalkOk: walked.ok,
        violations: walked.violations.map(
          (violation) => `${violation.code}@${String(violation.sequence)}`,
        ),
      });
    }
    return {
      runId: run.runId,
      ok: streams.every((check) => check.prefixIntact && check.chainWalkOk),
      streams,
    };
  });
}

// ---------------------------------------------------------------------------
// Restore (ALD-060 criterion 2)
// ---------------------------------------------------------------------------

/** `docs/evidence-bundle-format.md` §1: the rolling per-role policy file. */
export function policyFileName(role: BabyRole): string {
  return `${role}-latest.json`;
}

/**
 * Writes a snapshot's recorded policies into `<bundleRoot>/runs/<runId>/
 * policies/<role>-latest.json` — the exact seam `NurseryRuntimeImpl.recover`
 * reads and passes to `LearnerAdapter.init` as `initialPolicy` (the same seam
 * SPEC §7.4 derived runs use). This is why restore needs no orchestrator
 * change: the runtime already re-installs adapter state from that file, so a
 * restore only has to make the file say what the snapshot says.
 *
 * A run whose policy is `undefined` (an adapter with no exportable state) is
 * skipped rather than written as `null`.
 */
export async function restorePolicyFiles(
  bundleRoot: string,
  run: RuntimeSnapshotRun,
): Promise<BabyRole[]> {
  const directory = join(bundleRoot, 'runs', run.runId, 'policies');
  assertInside(bundleRoot, directory);
  const written: BabyRole[] = [];
  const entries: [BabyRole, unknown][] = [
    ['baby-a', run.policies.babyA],
    ['baby-b', run.policies.babyB],
  ];
  let created = false;
  for (const [role, policy] of entries) {
    if (policy === undefined) {
      continue;
    }
    if (!created) {
      await mkdir(directory, { recursive: true });
      created = true;
    }
    await writeFile(
      join(directory, policyFileName(role)),
      `${canonicalJson(policy)}\n`,
      'utf8',
    );
    written.push(role);
  }
  return written;
}

export interface RestoredRun {
  runId: string;
  /** Lifecycle state the snapshot recorded. */
  snapshotState: string;
  /** Lifecycle state after the §7.3 recovery procedure ran; absent on failure. */
  restoredState?: RunState;
  turnMatches: boolean;
  /** Per-role: the restored adapter's policy hash equals the snapshot's. */
  policyMatches: Record<BabyRole, boolean>;
  policyFilesWritten: BabyRole[];
  prefix: RunPrefixCheck;
  /** Set when `recover(runId)` itself failed; the run is reported, not thrown. */
  error?: { code: string; message: string };
}

export interface AutoRestoreResult {
  restored: boolean;
  reason?: 'no-snapshot';
  snapshotPath?: string;
  snapshot?: RuntimeSnapshot;
  runs: RestoredRun[];
  /** Every run's prefix was intact, walked, and its policies came back. */
  ok: boolean;
}

/**
 * The runtime surface restore needs: the §7.3 recovery entry point plus the
 * reads {@link SnapshotSource} already requires.
 */
export interface RestoreTarget extends SnapshotSource {
  recover(runId: string): Promise<RunSummary>;
  getRun(runId: string): RunSummary | undefined;
}

export interface AutoRestoreOptions {
  /** Directory `takeSnapshot` wrote to. */
  directory: string;
  /** `<bundleRoot>/runs/<runId>` is where each run's policy files live. */
  bundleRoot: string;
  /**
   * Set `false` to run the §7.3 recovery without pre-seeding the policy files
   * (the runtime then reloads whatever the run last wrote itself).
   */
  restorePolicies?: boolean;
}

/**
 * SPEC §14.4's `autoRestore()`: load the latest snapshot, re-install each
 * run's policy state through the documented seam, and then run the §7.3
 * recovery procedure per run. Never a substitute for §7.3 — it *invokes* it.
 *
 * A run the snapshot names but the store does not (a snapshot copied to a
 * fresh machine) is reported with an `error` rather than aborting the whole
 * restore, so one unusable run cannot strand the others.
 */
export async function autoRestore(
  runtimeFactory: () => RestoreTarget | Promise<RestoreTarget>,
  options: AutoRestoreOptions,
): Promise<AutoRestoreResult> {
  const path = await latestSnapshotPath(options.directory);
  if (path === undefined) {
    return { restored: false, reason: 'no-snapshot', runs: [], ok: false };
  }
  const snapshot = await readSnapshotFile(path);
  const runtime = await runtimeFactory();
  const runs: RestoredRun[] = [];

  for (const run of snapshot.runs) {
    const policyFilesWritten =
      options.restorePolicies === false
        ? []
        : await restorePolicyFiles(options.bundleRoot, run);
    let restoredState: RunState | undefined;
    let failure: { code: string; message: string } | undefined;
    try {
      restoredState = (await runtime.recover(run.runId)).state;
    } catch (error) {
      failure = {
        code:
          error instanceof Error && 'code' in error
            ? String((error as { code?: unknown }).code)
            : 'recover-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const prefix: RunPrefixCheck =
      failure === undefined
        ? (verifySnapshotPrefix(runtime.writerFor(run.runId), {
            ...snapshot,
            runs: [run],
          })[0] ?? { runId: run.runId, ok: false, streams: [] })
        : { runId: run.runId, ok: false, streams: [] };

    const policyMatches: Record<BabyRole, boolean> = {
      'baby-a': false,
      'baby-b': false,
    };
    if (failure === undefined) {
      const adapters = runtime.adaptersFor(run.runId);
      policyMatches['baby-a'] =
        policyHash(adapters['baby-a'].exportPolicy()) ===
        run.policyHashes.babyA;
      policyMatches['baby-b'] =
        policyHash(adapters['baby-b'].exportPolicy()) ===
        run.policyHashes.babyB;
    }

    runs.push({
      runId: run.runId,
      snapshotState: run.state,
      ...(restoredState === undefined ? {} : { restoredState }),
      turnMatches: (runtime.getRun(run.runId)?.turn ?? -1) === run.turn,
      policyMatches,
      policyFilesWritten,
      prefix,
      ...(failure === undefined ? {} : { error: failure }),
    });
  }

  return {
    restored: true,
    snapshotPath: path,
    snapshot,
    runs,
    ok:
      runs.length > 0 &&
      runs.every(
        (run) =>
          run.error === undefined &&
          run.prefix.ok &&
          run.policyMatches['baby-a'] &&
          run.policyMatches['baby-b'],
      ),
  };
}

// ---------------------------------------------------------------------------
// Periodic and shutdown snapshots (SPEC §14.4)
// ---------------------------------------------------------------------------

/** Opaque handle returned by {@link SnapshotTimer.setInterval}. */
export type SnapshotTimerHandle = unknown;

/** The timer slice the scheduler uses; injectable so tests need no real time. */
export interface SnapshotTimer {
  setInterval(callback: () => void, ms: number): SnapshotTimerHandle;
  clearInterval(handle: SnapshotTimerHandle): void;
}

/**
 * Default timer. `unref` matches `@ald/checkpoint`'s scheduler: a snapshot
 * timer nobody stopped must never be the only reason a process stays alive.
 */
export const nodeSnapshotTimer: SnapshotTimer = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Reads {@link SNAPSHOT_INTERVAL_ENV_VAR}. An unset, empty, or unparseable
 * value falls back to the §14.4 default rather than failing the process: a
 * bad cadence must not be able to stop a server from starting, and the
 * fallback is reported through `onError`.
 */
export function snapshotIntervalFromEnv(
  source: Record<string, string | undefined> = process.env,
  onError?: (error: unknown) => void,
): number {
  const raw = source[SNAPSHOT_INTERVAL_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SNAPSHOT_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
    onError?.(
      new Error(
        `${SNAPSHOT_INTERVAL_ENV_VAR} must be an integer of at least 1000 ms; using the §14.4 default`,
      ),
    );
    return DEFAULT_SNAPSHOT_INTERVAL_MS;
  }
  return parsed;
}

export interface SnapshotSchedulerOptions {
  runtime: SnapshotSource;
  directory: string;
  clock: Clock;
  intervalMs?: number;
  softwareCommit?: string;
  timer?: SnapshotTimer;
  onSnapshot?: (result: TakeSnapshotResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * SPEC §14.4's periodic snapshots. Like `@ald/checkpoint`'s
 * `CheckpointScheduler`, every attempt runs through one promise chain (so two
 * ticks cannot write over each other), the timer callback cannot throw, and
 * the chain never rejects — a snapshot failure is reported to `onError` and
 * the next tick tries again.
 */
export class SnapshotScheduler {
  readonly intervalMs: number;
  readonly #options: SnapshotSchedulerOptions;
  readonly #timer: SnapshotTimer;
  #handle: SnapshotTimerHandle | undefined;
  #chain: Promise<void> = Promise.resolve();
  #snapshots = 0;
  #failures = 0;

  constructor(options: SnapshotSchedulerOptions) {
    this.#options = options;
    this.intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new RangeError('intervalMs must be a positive integer');
    }
    this.#timer = options.timer ?? nodeSnapshotTimer;
  }

  get running(): boolean {
    return this.#handle !== undefined;
  }

  get snapshotCount(): number {
    return this.#snapshots;
  }

  get failureCount(): number {
    return this.#failures;
  }

  /** Resolves once every snapshot triggered so far has settled. */
  get pending(): Promise<void> {
    return this.#chain;
  }

  /** Takes one snapshot through the serialized chain. Never rejects. */
  trigger(): void {
    this.#chain = this.#chain.catch(() => undefined).then(async () => {
      try {
        const result = await takeSnapshot(
          this.#options.runtime,
          this.#options.directory,
          {
            clock: this.#options.clock,
            ...(this.#options.softwareCommit === undefined
              ? {}
              : { softwareCommit: this.#options.softwareCommit }),
          },
        );
        this.#snapshots += 1;
        try {
          this.#options.onSnapshot?.(result);
        } catch (error) {
          this.#report(error);
        }
      } catch (error) {
        this.#failures += 1;
        this.#report(error);
      }
    });
  }

  start(): void {
    if (this.#handle !== undefined) {
      return;
    }
    this.#handle = this.#timer.setInterval(() => {
      try {
        this.trigger();
      } catch (error) {
        this.#report(error);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.#handle === undefined) {
      return;
    }
    this.#timer.clearInterval(this.#handle);
    this.#handle = undefined;
  }

  #report(error: unknown): void {
    try {
      this.#options.onError?.(error);
    } catch {
      // A reporter that throws has nowhere safer to report that.
    }
  }
}

/** The `process` slice {@link installShutdownSnapshot} needs. */
export interface SignalProcess {
  on(signal: string, listener: () => void): unknown;
  off?(signal: string, listener: () => void): unknown;
  exit(code?: number): never;
}

export interface ShutdownSnapshotOptions extends SnapshotSchedulerOptions {
  process?: SignalProcess;
  signals?: readonly string[];
  /** Exit code after the final snapshot; `false` leaves the process running. */
  exitCode?: number | false;
}

/**
 * SPEC §14.4: "a final snapshot on graceful shutdown (SIGINT/SIGTERM)".
 *
 * The handler is idempotent — a second SIGINT while the final snapshot is in
 * flight does not start a second one — and the snapshot failure path still
 * exits, because a shutdown that hangs on a failed write is worse than a
 * shutdown without a snapshot (the evidence store, not the snapshot, is
 * authoritative).
 */
export function installShutdownSnapshot(options: ShutdownSnapshotOptions): {
  uninstall(): void;
  /** Resolves when the final snapshot has settled. Tests await this. */
  finalSnapshot(): Promise<TakeSnapshotResult | undefined>;
} {
  const host = options.process ?? process;
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  let started: Promise<TakeSnapshotResult | undefined> | undefined;

  const run = (): Promise<TakeSnapshotResult | undefined> => {
    started ??= (async () => {
      try {
        const result = await takeSnapshot(options.runtime, options.directory, {
          clock: options.clock,
          ...(options.softwareCommit === undefined
            ? {}
            : { softwareCommit: options.softwareCommit }),
        });
        try {
          options.onSnapshot?.(result);
        } catch {
          // Observer failures never change the shutdown path.
        }
        return result;
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // As above.
        }
        return undefined;
      }
    })();
    return started;
  };

  const listeners = new Map<string, () => void>();
  for (const signal of signals) {
    const listener = (): void => {
      void run().then(() => {
        if (options.exitCode !== false) {
          host.exit(options.exitCode ?? 0);
        }
      });
    };
    listeners.set(signal, listener);
    host.on(signal, listener);
  }

  return {
    uninstall: () => {
      for (const [signal, listener] of listeners) {
        host.off?.(signal, listener);
      }
      listeners.clear();
    },
    finalSnapshot: run,
  };
}
