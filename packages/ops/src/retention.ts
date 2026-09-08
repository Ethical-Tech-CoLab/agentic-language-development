/**
 * ALD-062 — the retention enforcement job (SPECIFICATION.md §14.6).
 *
 * §14.6, verbatim on the only thing this job may delete:
 *
 * - "Sealed, anchored, public-research run bundles: retained indefinitely
 *   (immutable evidence; deletion would contradict the append-only claim)."
 * - "Development/qualification runs not declared public and not anchored to
 *   Base mainnet: default retention 30 days (`prototypeRetentionDays`), after
 *   which the bundle MAY be purged, provided the run's disposition and
 *   metadata row remain in `run_metadata` (index entries are never deleted,
 *   only bulk payloads for non-public development runs)."
 *
 * So the job touches exported *files* and never a SQLite row. It opens no
 * write connection to the evidence store at all — the reader interface it
 * takes is read-only ({@link RetentionReader}), which is what makes ALD-062
 * criterion 2 ("run_metadata, ledger/channel/audit/intervention rows,
 * checkpoint manifests, and anchor receipts remain queryable after purge")
 * true by construction rather than by care.
 *
 * ### What "bulk payload" means here (a BACKLOG §15 decision)
 *
 * `docs/evidence-bundle-format.md` §1 lists the bundle layout. This job purges
 * {@link PURGEABLE_BUNDLE_ENTRIES} — the four large per-event transcripts and
 * the `proofs/` and `policies/` trees — and retains everything the backlog
 * item names as preserved: `run-manifest.json`, `checkpoints/`, `anchors/`,
 * `configuration/`, `prompts/`, `experiment-record.json`,
 * `verification-report.json`, `analysis/`, and the two audit transcripts
 * (`intervention-log.jsonl`, `audit-ledger.jsonl`). Every purged file is
 * hashed before deletion and the hash is recorded, so the deletion is
 * tamper-evident and the file is regenerable from the store by re-exporting
 * the run.
 *
 * ### Audit trail (criterion 3)
 *
 * The purge is recorded in an append-only, hash-chained
 * `retention-log.jsonl` at the bundle root rather than as an
 * `intervention_log` row. The reason is integrity, not convenience: a purge
 * happens long after the run sealed, and `intervention_log` is a hash-chained
 * exported stream whose tail is already covered by the run's final,
 * potentially anchored checkpoint (LEDGER §15 — a second tail after the final
 * checkpoint is indistinguishable from a fork). Appending there would either
 * invalidate the anchored tip or require a second final checkpoint. The
 * retention log is therefore its own chain, and the job additionally accepts
 * an `interventionAudit` hook for the one case where an in-store record is
 * safe (a run that is still writable and has no final checkpoint yet).
 */
import {
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';
import { canonicalJson, hashCanonical, sha256Bytes, encodeHash } from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  RunConfigSchema,
  type Clock,
  type EvidenceReader,
  type Sha256Hash,
} from '@ald/types';

import { RetentionError } from './errors.js';

/**
 * Hash domain of a `retention-log.jsonl` entry.
 *
 * Centralized in `HASH_DOMAINS`; this alias remains public so retention-log
 * verifiers can reproduce the entry hash without duplicating a string.
 */
export const RETENTION_LOG_HASH_DOMAIN = HASH_DOMAINS.retentionLogEntry;

/** Marker file that declares a bundle public research output (§14.6). */
export const PUBLIC_RELEASE_MARKER = 'PUBLIC-RELEASE.json';

/** Tombstone written into a purged bundle directory. */
export const PURGE_TOMBSTONE = 'RETENTION-PURGED.json';

/** Append-only retention audit log, at the bundle root. */
export const RETENTION_LOG_FILE = 'retention-log.jsonl';

/**
 * Bundle entries the job may delete, relative to `<bundleRoot>/runs/<runId>`.
 * A directory entry is removed recursively. See the module doc for why this
 * exact set, and `packages/ops/README.md` for the retained set.
 */
export const PURGEABLE_BUNDLE_ENTRIES: readonly string[] = [
  'baby-a-ledger.jsonl',
  'baby-b-ledger.jsonl',
  'channel-transcript.jsonl',
  'affect-transcript.jsonl',
  'turn-records.jsonl',
  'proofs',
  'policies',
];

const isoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  { message: 'must be an ISO-8601 timestamp' },
);

/** `<bundleDir>/PUBLIC-RELEASE.json`, written by an operator, read here. */
export const PublicReleaseMarkerSchema = z
  .object({
    version: z.literal(1),
    declaredAt: isoDateTime,
    declaredBy: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type PublicReleaseMarker = z.infer<typeof PublicReleaseMarkerSchema>;

/** One purged file, hashed before deletion. */
export interface PurgedFileRecord {
  /** Path relative to the run's bundle directory. */
  path: string;
  bytes: number;
  sha256: Sha256Hash;
}

export const RetentionLogEntrySchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().min(1),
    recordedAt: isoDateTime,
    runId: z.string().min(1),
    actorId: z.string().min(1),
    reasonCode: z.literal('retention-purge'),
    retentionDays: z.number().int().min(0),
    ageDays: z.number().min(0),
    dryRun: z.boolean(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          bytes: z.number().int().min(0),
          sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        })
        .strict(),
    ),
    bytesFreed: z.number().int().min(0),
    previousEntryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    entryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

export type RetentionLogEntry = z.infer<typeof RetentionLogEntrySchema>;

/** The read-only evidence slice the job consults. Nothing writable. */
export type RetentionReader = Pick<
  EvidenceReader,
  'listRuns' | 'readRunMetadata' | 'readAnchorReceipts' | 'readCheckpoints'
>;

export type RetentionSkipReason =
  /** `prototypeRetentionDays === 0` disables purging for the run (§18). */
  | 'retention-disabled'
  /** `PUBLIC-RELEASE.json` is present: retained indefinitely. */
  | 'public-release'
  /** A Base mainnet anchor receipt exists: retained indefinitely. */
  | 'mainnet-anchored'
  /** The run is younger than its retention window. */
  | 'within-retention'
  /** No bundle directory exists (never exported, or already purged). */
  | 'no-bundle'
  /** No purgeable entry remains in the bundle. */
  | 'already-purged'
  /** The run id is not in `run_metadata`. */
  | 'unknown-run';

export interface RunRetentionDecision {
  runId: string;
  purged: boolean;
  reason: RetentionSkipReason | 'eligible';
  retentionDays: number;
  /** Days between {@link lastActivityAt} and `now`. */
  ageDays: number;
  /** Newest of the last checkpoint's `createdAt` and the run's `createdAt`. */
  lastActivityAt: string;
  publicRelease: boolean;
  mainnetAnchored: boolean;
  files: PurgedFileRecord[];
  bytesFreed: number;
  /** Retention-log entry written for this run, when one was. */
  auditEntryHash?: Sha256Hash;
}

export interface RetentionJobResult {
  version: 1;
  ranAt: string;
  dryRun: boolean;
  runsConsidered: number;
  runsPurged: number;
  bytesFreed: number;
  decisions: RunRetentionDecision[];
}

export interface RunRetentionOptions {
  evidence: RetentionReader;
  /** Bundles live at `<bundleRoot>/runs/<runId>`. */
  bundleRoot: string;
  clock: Clock;
  /** Nothing is deleted; the decisions and hashes are still computed. */
  dryRun?: boolean;
  /** Restrict the job to these run ids. Default: every run in the index. */
  runIds?: readonly string[];
  /** Recorded as the actor of each retention-log entry. */
  actorId?: string;
  /**
   * Optional in-store audit hook, for the case the module doc describes: a
   * run that is still writable and has no final checkpoint. Never called for
   * a sealed run. A throwing hook does not fail the job; the retention-log
   * entry is the authoritative record either way.
   */
  interventionAudit?: (
    runId: string,
    details: Record<string, unknown>,
  ) => Promise<unknown>;
}

const MS_PER_DAY = 86_400_000;

function assertInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const target = resolve(candidate);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new RetentionError(
      'retention-path-escape',
      'retention target resolves outside the configured bundle root',
      { target: relative(resolvedRoot, target) },
    );
  }
}

/** True when `<bundleDir>/PUBLIC-RELEASE.json` exists and is a valid marker. */
export async function readPublicReleaseMarker(
  bundleDir: string,
): Promise<PublicReleaseMarker | undefined> {
  try {
    const text = await readFile(join(bundleDir, PUBLIC_RELEASE_MARKER), 'utf8');
    const parsed = PublicReleaseMarkerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const contents = await readFile(path);
  return {
    bytes: contents.byteLength,
    sha256: encodeHash(sha256Bytes(contents)),
  };
}

/**
 * Every file under `entry`, relative to `bundleDir`, with its size and plain
 * SHA-256 (no domain separator, so any tool reproduces it — the same
 * convention `docs/evidence-bundle-format.md` §10 uses for attachments).
 */
async function describeEntry(
  bundleDir: string,
  entry: string,
): Promise<PurgedFileRecord[]> {
  const target = join(bundleDir, entry);
  let info;
  try {
    info = await stat(target);
  } catch {
    return [];
  }
  if (info.isFile()) {
    const { bytes, sha256 } = await hashFile(target);
    return [{ path: entry, bytes, sha256 }];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const records: PurgedFileRecord[] = [];
  const children = await readdir(target, { withFileTypes: true });
  for (const child of children.sort((left, right) =>
    left.name < right.name ? -1 : 1,
  )) {
    records.push(...(await describeEntry(bundleDir, join(entry, child.name))));
  }
  return records;
}

// ---------------------------------------------------------------------------
// Retention log (criterion 3)
// ---------------------------------------------------------------------------

/**
 * Append-only, hash-chained JSONL log of every purge. Chained the same way
 * every other stream in this project is (`previousEntryHash` -> `entryHash`
 * over the canonical unsigned entry), so a deleted or edited line is
 * detectable by {@link readRetentionLog}.
 */
export class RetentionAuditLog {
  readonly path: string;

  constructor(
    bundleRoot: string,
    private readonly clock: Clock,
  ) {
    this.path = join(resolve(bundleRoot), RETENTION_LOG_FILE);
  }

  async append(input: {
    runId: string;
    actorId: string;
    retentionDays: number;
    ageDays: number;
    dryRun: boolean;
    files: readonly PurgedFileRecord[];
    bytesFreed: number;
  }): Promise<RetentionLogEntry> {
    const existing = await readRetentionLog(this.path);
    const previous = existing.entries.at(-1);
    const unsigned = {
      version: 1 as const,
      sequence: (previous?.sequence ?? 0) + 1,
      recordedAt: this.clock.now(),
      runId: input.runId,
      actorId: input.actorId,
      reasonCode: 'retention-purge' as const,
      retentionDays: input.retentionDays,
      ageDays: input.ageDays,
      dryRun: input.dryRun,
      files: input.files.map((file) => ({ ...file })),
      bytesFreed: input.bytesFreed,
      previousEntryHash: previous?.entryHash ?? GENESIS_HASH,
    };
    const entry: RetentionLogEntry = RetentionLogEntrySchema.parse({
      ...unsigned,
      entryHash: hashCanonical(RETENTION_LOG_HASH_DOMAIN, unsigned),
    });
    await writeFile(this.path, `${canonicalJson(entry)}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
    return entry;
  }
}

export interface RetentionLogReadResult {
  entries: RetentionLogEntry[];
  /** Chain violations found while reading; empty for an intact log. */
  violations: string[];
}

/** Reads and re-walks the retention log. Never throws on a damaged log. */
export async function readRetentionLog(
  path: string,
): Promise<RetentionLogReadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { entries: [], violations: [] };
  }
  const entries: RetentionLogEntry[] = [];
  const violations: string[] = [];
  let previous = GENESIS_HASH;
  let expected = 1;
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = RetentionLogEntrySchema.safeParse(
      safeJsonParse(line) ?? undefined,
    );
    if (!parsed.success) {
      violations.push(`line ${String(index + 1)}: not a retention log entry`);
      continue;
    }
    const entry = parsed.data;
    const { entryHash, ...unsigned } = entry;
    const recomputed = hashCanonical(RETENTION_LOG_HASH_DOMAIN, unsigned);
    if (recomputed !== entryHash) {
      violations.push(`entry ${String(entry.sequence)}: entry hash mismatch`);
    }
    if (entry.previousEntryHash !== previous) {
      violations.push(`entry ${String(entry.sequence)}: does not chain`);
    }
    if (entry.sequence !== expected) {
      violations.push(
        `entry ${String(entry.sequence)}: expected sequence ${String(expected)}`,
      );
    }
    previous = entryHash;
    expected = entry.sequence + 1;
    entries.push(entry);
  }
  return { entries, violations };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Purges only the bulk payloads of runs that are (a) not declared public,
 * (b) not anchored to Base mainnet, and (c) older than their own
 * `prototypeRetentionDays`. Records every decision, whether or not it purged.
 *
 * The result object is canonicalizable, so a host can archive it next to the
 * retention log. `dryRun` computes everything — including the file hashes —
 * and deletes nothing, which is how an operator reviews a purge before
 * running it for real.
 */
export async function runRetentionJob(
  options: RunRetentionOptions,
): Promise<RetentionJobResult> {
  const dryRun = options.dryRun ?? false;
  const actorId = options.actorId ?? 'retention-job';
  const ranAt = options.clock.now();
  const nowMs = Date.parse(ranAt);
  if (Number.isNaN(nowMs)) {
    throw new RetentionError(
      'retention-invalid-options',
      'clock.now() must return an ISO-8601 timestamp',
    );
  }
  const bundleRoot = resolve(options.bundleRoot);
  const auditLog = new RetentionAuditLog(bundleRoot, options.clock);
  const runIds = options.runIds ?? options.evidence.listRuns();
  const decisions: RunRetentionDecision[] = [];

  for (const runId of runIds) {
    decisions.push(
      await decideAndPurge({
        runId,
        bundleRoot,
        nowMs,
        dryRun,
        actorId,
        auditLog,
        options,
      }),
    );
  }

  return {
    version: 1,
    ranAt,
    dryRun,
    runsConsidered: decisions.length,
    runsPurged: decisions.filter((decision) => decision.purged).length,
    bytesFreed: decisions.reduce(
      (total, decision) => total + decision.bytesFreed,
      0,
    ),
    decisions,
  };
}

interface DecideInput {
  runId: string;
  bundleRoot: string;
  nowMs: number;
  dryRun: boolean;
  actorId: string;
  auditLog: RetentionAuditLog;
  options: RunRetentionOptions;
}

async function decideAndPurge(input: DecideInput): Promise<RunRetentionDecision> {
  const { runId, bundleRoot, nowMs, dryRun, options } = input;
  const metadata = options.evidence.readRunMetadata(runId);
  const bundleDir = join(bundleRoot, 'runs', runId);
  assertInsideRoot(bundleRoot, bundleDir);

  const base = {
    runId,
    purged: false,
    retentionDays: 0,
    ageDays: 0,
    lastActivityAt: metadata?.createdAt ?? new Date(nowMs).toISOString(),
    publicRelease: false,
    mainnetAnchored: false,
    files: [] as PurgedFileRecord[],
    bytesFreed: 0,
  };

  if (metadata === undefined) {
    return { ...base, reason: 'unknown-run' };
  }

  const config = RunConfigSchema.parse(JSON.parse(metadata.configurationJson));
  const retentionDays = config.prototypeRetentionDays;
  const checkpoints = options.evidence.readCheckpoints(runId);
  const lastActivityAt = newestTimestamp([
    metadata.createdAt,
    ...checkpoints.map((manifest) => manifest.createdAt),
  ]);
  const ageDays = Math.max(0, (nowMs - Date.parse(lastActivityAt)) / MS_PER_DAY);
  const publicRelease = (await readPublicReleaseMarker(bundleDir)) !== undefined;
  const mainnetAnchored = options.evidence
    .readAnchorReceipts(runId)
    .some((receipt) => receipt.network === 'base-mainnet');

  const decision = {
    ...base,
    retentionDays,
    ageDays,
    lastActivityAt,
    publicRelease,
    mainnetAnchored,
  };

  if (retentionDays === 0) {
    return { ...decision, reason: 'retention-disabled' };
  }
  if (publicRelease) {
    return { ...decision, reason: 'public-release' };
  }
  if (mainnetAnchored) {
    return { ...decision, reason: 'mainnet-anchored' };
  }
  if (ageDays < retentionDays) {
    return { ...decision, reason: 'within-retention' };
  }

  let bundleExists = true;
  try {
    bundleExists = (await stat(bundleDir)).isDirectory();
  } catch {
    bundleExists = false;
  }
  if (!bundleExists) {
    return { ...decision, reason: 'no-bundle' };
  }

  const files: PurgedFileRecord[] = [];
  for (const entry of PURGEABLE_BUNDLE_ENTRIES) {
    files.push(...(await describeEntry(bundleDir, entry)));
  }
  if (files.length === 0) {
    return { ...decision, reason: 'already-purged' };
  }
  const bytesFreed = files.reduce((total, file) => total + file.bytes, 0);

  if (!dryRun) {
    for (const entry of PURGEABLE_BUNDLE_ENTRIES) {
      const target = join(bundleDir, entry);
      assertInsideRoot(bundleRoot, target);
      await rm(target, { recursive: true, force: true });
    }
    await writeFile(
      join(bundleDir, PURGE_TOMBSTONE),
      `${canonicalJson({
        version: 1,
        purgedAt: options.clock.now(),
        runId,
        reasonCode: 'retention-purge',
        retentionDays,
        files,
        bytesFreed,
        note:
          'Bulk payloads purged under SPEC §14.6. The run index, ledger, ' +
          'channel, audit, and intervention rows, checkpoint manifests, and ' +
          'anchor receipts remain in the evidence store; re-exporting the ' +
          'run regenerates these files.',
      })}\n`,
      'utf8',
    );
  }

  const entry = await input.auditLog.append({
    runId,
    actorId: input.actorId,
    retentionDays,
    ageDays,
    dryRun,
    files,
    bytesFreed,
  });

  if (options.interventionAudit !== undefined && checkpointIsNotFinal(checkpoints)) {
    try {
      await options.interventionAudit(runId, {
        reasonCode: 'retention-purge',
        retentionLogEntryHash: entry.entryHash,
        files: files.length,
        bytesFreed,
      });
    } catch {
      // The retention log is the authoritative record; an in-store audit
      // record is a convenience for a run that is still writable.
    }
  }

  return {
    ...decision,
    purged: !dryRun,
    reason: 'eligible',
    files,
    bytesFreed,
    auditEntryHash: entry.entryHash,
  };
}

function newestTimestamp(candidates: readonly string[]): string {
  let best = candidates[0] ?? new Date(0).toISOString();
  let bestMs = Date.parse(best);
  for (const candidate of candidates.slice(1)) {
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms) && (Number.isNaN(bestMs) || ms > bestMs)) {
      best = candidate;
      bestMs = ms;
    }
  }
  return best;
}

/** LEDGER §15: a run with a `run-sealed`/`run-aborted` manifest is closed. */
function checkpointIsNotFinal(
  checkpoints: readonly { reason: string }[],
): boolean {
  return !checkpoints.some(
    (manifest) =>
      manifest.reason === 'run-sealed' || manifest.reason === 'run-aborted',
  );
}
