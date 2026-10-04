#!/usr/bin/env node
/**
 * ALD-079 — independent operator execution of docs/snapshot-restore-runbook.md.
 *
 * Follows the runbook's Preparation (1-5) and Restore (1-6) steps verbatim
 * against a scratch runtime under the OS temp directory, asserts every
 * runbook Restore gate, and writes the Validation-record artifact the runbook
 * requires (snapshot path/digest, software commit, database checksums,
 * start/end time, per-run AutoRestoreResult, operator identity).
 *
 * Fails closed: any gate failure exits nonzero before traffic would resume.
 * Never touches real data: everything lives under one mkdtemp scratch root.
 *
 * Usage:
 *   node scripts/run-ald079-independent-restore.mjs --out <record.json> [--turns N] [--keep]
 *
 * Requires a workspace build first (`pnpm run build`) for the @ald/* dist entry points.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { openEvidenceDatabase } from '../packages/evidence/dist/index.js';
import { InMemorySignerRegistry } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { autoRestore, readSnapshotFile, takeSnapshot } from '@ald/ops';
import {
  createNurseryRuntime,
  simpleCheckpointFactory,
} from '@ald/orchestrator';

const RUNBOOK_PATH = 'docs/snapshot-restore-runbook.md';

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/run-ald079-independent-restore.mjs --out <record.json> [--turns N] [--run-id ID] [--keep]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { out: undefined, turns: 8, runId: 'ald079-independent-restore-1', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[(i += 1)];
    else if (arg === '--turns') args.turns = Number(argv[(i += 1)]);
    else if (arg === '--run-id') args.runId = argv[(i += 1)];
    else if (arg === '--keep') args.keep = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (!args.out) usage('--out <record.json> is required');
  if (!Number.isSafeInteger(args.turns) || args.turns < 1) usage('--turns must be a positive integer');
  if (!args.runId) usage('--run-id must be non-empty');
  return args;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function check(condition, message) {
  if (!condition) throw new Error(`RUNBOOK GATE FAILED: ${message}`);
  return true;
}

/** Wall clock: what a human operator has (no deterministic test clock). */
const wallClock = { now: () => new Date().toISOString() };

const args = parseArgs(process.argv.slice(2));
const startedAt = wallClock.now();
const softwareCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runbookBytes = await readFile(RUNBOOK_PATH);
const runbookSha256 = sha256Hex(runbookBytes);
const snapshotIntervalMs = process.env.DTSF_SNAPSHOT_INTERVAL_MS ?? '300000 (SPEC §14.4 default; env unset)';

// --- Preparation 1: one scratch recovery unit (evidence db + bundle root + snapshot dir). ---
const scratchRoot = await mkdtemp(join(tmpdir(), 'ald079-independent-restore-'));
const databasePath = join(scratchRoot, 'evidence.sqlite');
const bundleRoot = scratchRoot;
const snapshotDirectory = join(scratchRoot, 'session');
check(resolve(databasePath).startsWith(`${resolve(scratchRoot)}/`), 'database must live inside the scratch recovery unit');
check(resolve(snapshotDirectory).startsWith(`${resolve(scratchRoot)}/`), 'snapshot dir must live inside the scratch recovery unit');

// Same signer access across the restart, per Restore step 2.
const registries = new Map();
const signerProvider = (runId) => {
  const existing = registries.get(runId);
  if (existing) return existing;
  const created = InMemorySignerRegistry.generate(runId);
  registries.set(runId, created);
  return created;
};

function openRuntime() {
  const database = openEvidenceDatabase(databasePath);
  const runtime = createNurseryRuntime({
    database,
    bundleRoot,
    softwareCommit,
    checkpointFactory: simpleCheckpointFactory({ clock: wallClock, softwareCommit }),
    signerProvider,
    clock: wallClock,
    anchorPolicy: 'skip',
  });
  return { database, runtime };
}

function checkpointAndClose(database) {
  database.database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
}

async function databaseSha256() {
  return `sha256:${sha256Hex(await readFile(databasePath))}`;
}

// --- Live phase: create a real run and step it (external stepping paused for the manual snapshot). ---
let opened = openRuntime();
const config = buildRunConfig({
  deploymentMode: 'prototype',
  protocolGitCommit: 'git:ald079-independent-validation',
  babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
  babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
  learningSignal: 'extrinsic-task',
  runId: args.runId,
  experimentId: 'E11',
  randomSeed: `seed-${args.runId}`,
  maxTurnsPerRun: 40,
  evaluationTurns: 4,
  checkpointEventInterval: 8,
});
await opened.runtime.createRun(config);
for (let turn = 0; turn < args.turns; turn += 1) {
  await opened.runtime.step(args.runId);
}

// --- Preparation 4: manual recovery snapshot through the @ald/ops operator service. ---
const { snapshot, path: snapshotPath } = await takeSnapshot(opened.runtime, snapshotDirectory, {
  clock: wallClock,
  softwareCommit,
});

// --- Preparation 5: the snapshot is usable only if readSnapshotFile accepts it. ---
const loaded = await readSnapshotFile(snapshotPath);
check(loaded.digest === snapshot.digest, 'readSnapshotFile must return the snapshot just written');

const [snapshottedRun] = snapshot.runs;
check(snapshottedRun?.runId === args.runId, 'snapshot must record the live run');
const checkpointsBefore = opened.runtime.writerFor(args.runId).readCheckpoints(args.runId);

// --- Restore 1: stop the old runtime cleanly; preserve the original until validation completes. ---
checkpointAndClose(opened.database);
const dbChecksumBeforeRestore = await databaseSha256();
const pristineCopy = `${scratchRoot}.pristine`;
await cp(scratchRoot, pristineCopy, { recursive: true });

// --- Restore 2: new runtime over the preserved store, same signer access / bundle root. ---
opened = openRuntime();
check(opened.runtime.listRuns().length === 0, 'a restarted runtime must start with no live runs');

// --- Restore 3: the runbook call, before any traffic. ---
const restoreResult = await autoRestore(() => opened.runtime, {
  directory: snapshotDirectory,
  bundleRoot,
});

// --- Restore 4: require restored === true and ok === true, per run. ---
check(restoreResult.restored === true, 'autoRestore must report restored=true');
check(restoreResult.ok === true, 'autoRestore must report ok=true');
check(restoreResult.runs.length === 1, 'autoRestore must report exactly the snapshotted run');
const [restoredRun] = restoreResult.runs;
check(restoredRun.error === undefined, `restored run must carry no error (got ${restoredRun.error?.code})`);
check(restoredRun.turnMatches === true, 'restored run turn cursor must match the snapshot');
check(
  restoredRun.policyMatches['baby-a'] === true && restoredRun.policyMatches['baby-b'] === true,
  'both restored policies must hash-match the snapshot',
);
check(restoredRun.prefix.ok === true, 'restored run prefix check must pass');

// --- Restore 5: inspect every prefix.streams entry; any violation quarantines the runtime. ---
check(restoredRun.prefix.streams.length > 0, 'prefix check must cover at least one stream');
for (const stream of restoredRun.prefix.streams) {
  check(stream.prefixIntact === true, `${stream.stream}: prefixIntact must be true`);
  check(stream.chainWalkOk === true, `${stream.stream}: chainWalkOk must be true`);
  check(stream.violations.length === 0, `${stream.stream}: violations must be empty`);
}

// --- Restore 6: recovery event + checkpoint appended after the immutable snapshot prefix. ---
const audit = opened.runtime.auditLog(args.runId);
check(audit.at(-1)?.eventType === 'recovery', 'last audit event must be the §7.3 recovery event');
const checkpointsAfter = opened.runtime.writerFor(args.runId).readCheckpoints(args.runId);
check(
  checkpointsAfter.length > checkpointsBefore.length,
  'recovery must append a checkpoint after the snapshot prefix',
);
check(
  (checkpointsAfter.at(-1)?.checkpointHash ?? null) !== snapshottedRun.lastCheckpointHash,
  'the post-restore checkpoint must extend past the snapshot head',
);
// Traffic resumes only after the checks: prove the run is resumable with one step.
const resumeStep = await opened.runtime.step(args.runId);

// --- Validation record (runbook "Validation record" section). ---
checkpointAndClose(opened.database);
const dbChecksumAfterRestore = await databaseSha256();
const endedAt = wallClock.now();

const record = {
  schemaVersion: 1,
  classification: 'ald-079-independent-restore-validation',
  researchFinding: false,
  runbook: { path: RUNBOOK_PATH, sha256: runbookSha256 },
  operator: {
    identity: 'ALDM (Muse Code session inland-parsec)',
    independence:
      'Operator is not the ALD-060 snapshot/restore implementer; this is the second-person runbook execution ALD-079 requires.',
  },
  softwareCommit,
  snapshotIntervalMs,
  startedAt,
  endedAt,
  scratch: {
    rootBasename: basename(scratchRoot),
    note: 'Ephemeral OS-temp recovery unit (evidence db + bundle root + snapshot dir); removed after validation unless --keep.',
    kept: args.keep,
  },
  snapshot: { pathBasename: basename(snapshotPath), digest: snapshot.digest, runs: snapshot.runs.length },
  database: {
    fileBasename: basename(databasePath),
    sha256BeforeRestore: dbChecksumBeforeRestore,
    sha256AfterRestore: dbChecksumAfterRestore,
    walCheckpointedBeforeHash: true,
  },
  restore: {
    restored: restoreResult.restored,
    ok: restoreResult.ok,
    snapshotPathBasename: restoreResult.snapshotPath ? basename(restoreResult.snapshotPath) : null,
    runs: restoreResult.runs.map((run) => ({
      runId: run.runId,
      snapshotState: run.snapshotState,
      restoredState: run.restoredState ?? null,
      turnMatches: run.turnMatches,
      policyMatches: run.policyMatches,
      policyFilesWritten: run.policyFilesWritten,
      error: run.error ?? null,
      prefix: {
        ok: run.prefix.ok,
        streams: run.prefix.streams.map((s) => ({
          stream: s.stream,
          expected: s.expected,
          observed: s.observed,
          prefixIntact: s.prefixIntact,
          chainWalkOk: s.chainWalkOk,
          violations: s.violations,
        })),
      },
    })),
  },
  recovery: {
    lastAuditEventType: audit.at(-1)?.eventType,
    checkpointsBefore: checkpointsBefore.length,
    checkpointsAfter: checkpointsAfter.length,
    lastCheckpointBefore: checkpointsBefore.at(-1)?.checkpointHash ?? null,
    lastCheckpointAfter: checkpointsAfter.at(-1)?.checkpointHash ?? null,
    resumeStepTurn: resumeStep.turn,
  },
  toolchain: { node: process.version, source: 'workspace @ald/* dist build at softwareCommit' },
  conclusion: 'PASS: every runbook Restore gate held; traffic resumed with one post-restore step.',
};

const { writeFile } = await import('node:fs/promises');
await writeFile(args.out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

if (!args.keep) {
  await rm(scratchRoot, { recursive: true, force: true });
  await rm(pristineCopy, { recursive: true, force: true });
} else {
  process.stdout.write(`scratch kept: ${scratchRoot}\npristine copy kept: ${pristineCopy}\n`);
}
process.stdout.write(`ALD-079 independent restore PASS: ${args.out}\n`);
