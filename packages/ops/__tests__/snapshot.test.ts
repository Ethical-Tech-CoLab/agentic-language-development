/**
 * ALD-060 — snapshot and restore (SPECIFICATION.md §14.4, §7.3).
 *
 * Criterion 1: a manual snapshot produces a file set a restore can consume.
 * Criterion 2: restarting after a snapshot restores to that snapshot's state.
 * Criterion 3: a restored run's evidence state matches the snapshot's in the
 * ALD-008 chain-walk sense — the snapshot's committed prefix is present, its
 * head hash is unchanged, and `validateChain` still walks it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { canonicalJson, hashCanonical, parseCanonicalJson } from '@ald/hashing';
import { EVENT_STREAMS, HASH_DOMAINS } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  autoRestore,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  installShutdownSnapshot,
  latestSnapshotPath,
  listSnapshots,
  readSnapshotFile,
  RuntimeSnapshotSchema,
  SNAPSHOT_INTERVAL_ENV_VAR,
  snapshotDigest,
  snapshotIntervalFromEnv,
  SnapshotScheduler,
  takeSnapshot,
  verifySnapshotPrefix,
  type RuntimeSnapshot,
  type SnapshotTimer,
} from '@ald/ops';

import {
  createHarness,
  FixedClock,
  scratchRlConfig,
  type Harness,
} from './support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function snapshotDir(root: string): string {
  return join(root, 'session');
}

/** A `scratch-rl` run stepped `turns` times, so its policies are non-trivial. */
async function runWithPolicy(
  runId: string,
  turns: number,
): Promise<{ harness: Harness; runId: string }> {
  const created = await createHarness();
  harness = created;
  await created.runtime.createRun(
    scratchRlConfig({
      runId,
      experimentId: 'E11',
      randomSeed: `seed-${runId}`,
      maxTurnsPerRun: 40,
      evaluationTurns: 4,
      checkpointEventInterval: 8,
    }),
  );
  for (let index = 0; index < turns; index += 1) {
    await created.runtime.step(runId);
  }
  return { harness: created, runId };
}

describe('ALD-060 criterion 1: a manual snapshot is consumable', () => {
  it('ALD-060: takeSnapshot writes a canonical, digest-bound file readSnapshotFile accepts', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-run-1', 6);
    const directory = snapshotDir(live.root);

    const { snapshot, path } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });

    // Canonical JSON plus exactly one trailing newline, like every other
    // artifact in this project.
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).toBe(canonicalJson(snapshot));
    expect(RuntimeSnapshotSchema.parse(parseCanonicalJson(text.trimEnd()))).toEqual(
      snapshot,
    );

    const loaded = await readSnapshotFile(path);
    expect(loaded).toEqual(snapshot);
    expect(snapshotDigest(loaded)).toBe(loaded.digest);
    expect(loaded.digest).toBe(
      hashCanonical(HASH_DOMAINS.runtimeSnapshot, {
        version: snapshot.version,
        takenAt: snapshot.takenAt,
        softwareCommit: snapshot.softwareCommit,
        runs: snapshot.runs,
      }),
    );

    const [run] = loaded.runs;
    expect(run?.runId).toBe(runId);
    expect(run?.state).toBe('running');
    expect(run?.turn).toBe(6);
    expect(run?.trainingCount).toBe(6);
    expect(run?.evaluationCount).toBe(0);
    expect(run?.lastCheckpointHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // Every stream the evidence store knows is recorded, so nothing is
    // silently outside the chain-walk check.
    expect(Object.keys(run?.chainHeads ?? {}).sort()).toEqual(
      [...EVENT_STREAMS].sort(),
    );
    expect(run?.policyHashes.babyA).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('ALD-060: a snapshot whose body was edited is rejected, not used', async () => {
    const { harness: live } = await runWithPolicy('snap-run-2', 2);
    const directory = snapshotDir(live.root);
    const { path, snapshot } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });

    const tampered: RuntimeSnapshot = {
      ...snapshot,
      runs: snapshot.runs.map((run) => ({ ...run, turn: run.turn + 100 })),
    };
    await writeFile(path, `${canonicalJson(tampered)}\n`, 'utf8');

    await expect(readSnapshotFile(path)).rejects.toMatchObject({
      code: 'snapshot-digest-mismatch',
    });
  });

  it('ALD-060: a non-JSON or schema-invalid snapshot is a typed error', async () => {
    const { harness: live } = await runWithPolicy('snap-run-3', 1);
    const directory = snapshotDir(live.root);
    const { path } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });

    await writeFile(path, 'not json at all\n', 'utf8');
    await expect(readSnapshotFile(path)).rejects.toMatchObject({
      code: 'snapshot-invalid',
    });

    await writeFile(path, `${canonicalJson({ version: 2 })}\n`, 'utf8');
    await expect(readSnapshotFile(path)).rejects.toMatchObject({
      code: 'snapshot-invalid',
    });

    await expect(
      readSnapshotFile(join(directory, 'does-not-exist.json')),
    ).rejects.toMatchObject({ code: 'snapshot-not-found' });
  });

  it('ALD-060: listSnapshots and latestSnapshotPath order chronologically', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-run-4', 2);
    const directory = snapshotDir(live.root);

    const first = await takeSnapshot(live.runtime, directory, { clock: live.clock });
    await live.runtime.step(runId);
    const second = await takeSnapshot(live.runtime, directory, { clock: live.clock });

    const names = await listSnapshots(directory);
    expect(names).toHaveLength(2);
    expect(await latestSnapshotPath(directory)).toBe(second.path);
    expect(first.path).not.toBe(second.path);
    expect(await listSnapshots(join(live.root, 'no-such-dir'))).toEqual([]);
    expect(await latestSnapshotPath(join(live.root, 'no-such-dir'))).toBeUndefined();
  });
});

describe('ALD-060 criteria 2 and 3: restart, restore, and chain-walk equality', () => {
  it('ALD-060: a restart after a snapshot restores the run to the snapshot state', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-restore-1', 8);
    const directory = snapshotDir(live.root);
    const { snapshot } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });
    const policiesBefore = {
      babyA: hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        live.runtime.adaptersFor(runId)['baby-a'].exportPolicy(),
      ),
      babyB: hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        live.runtime.adaptersFor(runId)['baby-b'].exportPolicy(),
      ),
    };

    // Restart: a second runtime over the same store, as a process restart is.
    const restarted = live.restart();
    harness = restarted;
    expect(restarted.runtime.listRuns()).toEqual([]);

    const result = await autoRestore(() => restarted.runtime, {
      directory,
      bundleRoot: restarted.root,
    });

    expect(result.restored).toBe(true);
    expect(result.snapshot?.digest).toBe(snapshot.digest);
    expect(result.runs).toHaveLength(1);
    const [restoredRun] = result.runs;
    expect(restoredRun?.error).toBeUndefined();
    expect(restoredRun?.restoredState).toBe('running');
    expect(restoredRun?.turnMatches).toBe(true);
    expect(restoredRun?.policyMatches).toEqual({
      'baby-a': true,
      'baby-b': true,
    });
    expect(restoredRun?.policyFilesWritten).toEqual(['baby-a', 'baby-b']);
    expect(result.ok).toBe(true);

    // The live adapters really carry the snapshot's policy again.
    expect(
      hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        restarted.runtime.adaptersFor(runId)['baby-a'].exportPolicy(),
      ),
    ).toBe(policiesBefore.babyA);
    expect(
      hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        restarted.runtime.adaptersFor(runId)['baby-b'].exportPolicy(),
      ),
    ).toBe(policiesBefore.babyB);
    expect(restarted.runtime.getRun(runId)?.turn).toBe(snapshot.runs[0]?.turn);

    // §7.3: the restore ran the recovery procedure, which appends an explicit
    // recovery event — so the run is resumable.
    const audit = restarted.runtime.auditLog(runId);
    expect(audit.at(-1)?.eventType).toBe('recovery');
    await expect(restarted.runtime.step(runId)).resolves.toMatchObject({
      turn: snapshot.runs[0]?.turn,
    });
  });

  it('ALD-060 criterion 3: every stream of the restored run matches the snapshot in the chain-walk sense', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-restore-2', 6);
    const directory = snapshotDir(live.root);
    const { snapshot } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });

    const restarted = live.restart();
    harness = restarted;
    const result = await autoRestore(() => restarted.runtime, {
      directory,
      bundleRoot: restarted.root,
    });
    expect(result.runs[0]?.prefix.ok).toBe(true);

    const checks = verifySnapshotPrefix(
      restarted.runtime.writerFor(runId),
      snapshot,
    );
    expect(checks).toHaveLength(1);
    const [runCheck] = checks;
    expect(runCheck?.ok).toBe(true);
    expect(runCheck?.streams.map((stream) => stream.stream).sort()).toEqual(
      [...EVENT_STREAMS].sort(),
    );
    for (const stream of runCheck?.streams ?? []) {
      expect(stream.prefixIntact).toBe(true);
      expect(stream.chainWalkOk).toBe(true);
      expect(stream.violations).toEqual([]);
      // The prefix is intact; §7.3's own recovery event legitimately extends
      // the intervention chain past it.
      expect(stream.observed.size).toBeGreaterThanOrEqual(stream.expected.size);
      if (stream.stream !== 'intervention') {
        expect(stream.observed.lastEntryHash).toBe(stream.expected.lastEntryHash);
      }
    }
    const intervention = runCheck?.streams.find(
      (stream) => stream.stream === 'intervention',
    );
    expect(intervention?.observed.size).toBeGreaterThan(
      intervention?.expected.size ?? 0,
    );
  });

  it('ALD-060: a snapshot that predates further turns restores the snapshot policy, and says so about the turn cursor', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-restore-3', 4);
    const directory = snapshotDir(live.root);
    const { snapshot } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });
    // The store keeps growing after the snapshot; it is append-only and
    // authoritative, so recovery follows the store, not the snapshot.
    for (let index = 0; index < 3; index += 1) {
      await live.runtime.step(runId);
    }

    const restarted = live.restart();
    harness = restarted;
    const result = await autoRestore(() => restarted.runtime, {
      directory,
      bundleRoot: restarted.root,
    });

    const [restoredRun] = result.runs;
    // The policy is the snapshot's (that is what a restore means)...
    expect(restoredRun?.policyMatches).toEqual({
      'baby-a': true,
      'baby-b': true,
    });
    // ...and the turn cursor is the store's, reported honestly rather than
    // silently rewound (SPEC §14.4: a snapshot restore is not a substitute
    // for the §7.3 recovery procedure).
    expect(restoredRun?.turnMatches).toBe(false);
    expect(restarted.runtime.getRun(runId)?.turn).toBe(7);
    expect(snapshot.runs[0]?.turn).toBe(4);
    expect(restoredRun?.prefix.ok).toBe(true);
  });

  it('ALD-060: restorePolicies:false leaves the runtime to reload its own latest policy', async () => {
    const { harness: live, runId } = await runWithPolicy('snap-restore-4', 4);
    const directory = snapshotDir(live.root);
    await takeSnapshot(live.runtime, directory, { clock: live.clock });
    for (let index = 0; index < 3; index += 1) {
      await live.runtime.step(runId);
    }
    const laterPolicy = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      live.runtime.adaptersFor(runId)['baby-a'].exportPolicy(),
    );

    const restarted = live.restart();
    harness = restarted;
    const result = await autoRestore(() => restarted.runtime, {
      directory,
      bundleRoot: restarted.root,
      restorePolicies: false,
    });

    expect(result.runs[0]?.policyFilesWritten).toEqual([]);
    expect(result.runs[0]?.policyMatches['baby-a']).toBe(false);
    expect(
      hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        restarted.runtime.adaptersFor(runId)['baby-a'].exportPolicy(),
      ),
    ).toBe(laterPolicy);
  });

  it('ALD-060: autoRestore reports "no snapshot" instead of inventing one', async () => {
    const { harness: live } = await runWithPolicy('snap-restore-5', 1);
    const result = await autoRestore(() => live.runtime, {
      directory: join(live.root, 'session'),
      bundleRoot: live.root,
    });
    expect(result).toEqual({
      restored: false,
      reason: 'no-snapshot',
      runs: [],
      ok: false,
    });
  });

  it('ALD-060: a run the snapshot names but the store does not is reported, not thrown', async () => {
    const { harness: live } = await runWithPolicy('snap-restore-6', 2);
    const directory = snapshotDir(live.root);
    const { snapshot, path } = await takeSnapshot(live.runtime, directory, {
      clock: live.clock,
    });
    // Rewrite the snapshot naming a run this store has never seen.
    const body = {
      version: snapshot.version,
      takenAt: snapshot.takenAt,
      softwareCommit: snapshot.softwareCommit,
      runs: snapshot.runs.map((run) => ({ ...run, runId: 'never-existed' })),
    };
    await writeFile(
      path,
      `${canonicalJson({
        ...body,
        digest: hashCanonical(HASH_DOMAINS.runtimeSnapshot, body),
      })}\n`,
      'utf8',
    );

    const restarted = live.restart();
    harness = restarted;
    const result = await autoRestore(() => restarted.runtime, {
      directory,
      bundleRoot: restarted.root,
    });
    expect(result.restored).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.runs[0]?.error?.code).toBe('unknown-run');
    expect(result.runs[0]?.prefix.ok).toBe(false);
  });
});

describe('ALD-060: periodic snapshots (SPEC §14.4 cadence)', () => {
  it('ALD-060: the default cadence is the §14.4 300 s, and the env var overrides it', () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL_MS).toBe(300_000);
    expect(snapshotIntervalFromEnv({})).toBe(300_000);
    expect(
      snapshotIntervalFromEnv({ [SNAPSHOT_INTERVAL_ENV_VAR]: '60000' }),
    ).toBe(60_000);
    const errors: unknown[] = [];
    expect(
      snapshotIntervalFromEnv({ [SNAPSHOT_INTERVAL_ENV_VAR]: 'soon' }, (error) =>
        errors.push(error),
      ),
    ).toBe(300_000);
    expect(errors).toHaveLength(1);
    expect(
      snapshotIntervalFromEnv({ [SNAPSHOT_INTERVAL_ENV_VAR]: '10' }, (error) =>
        errors.push(error),
      ),
    ).toBe(300_000);
    expect(errors).toHaveLength(2);
  });

  it('ALD-060: the scheduler snapshots on each tick and never lets a failure escape', async () => {
    const { harness: live } = await runWithPolicy('snap-sched-1', 2);
    const directory = snapshotDir(live.root);

    let tick: (() => void) | undefined;
    const timer: SnapshotTimer = {
      setInterval: (callback) => {
        tick = callback;
        return 'handle';
      },
      clearInterval: () => {
        tick = undefined;
      },
    };
    const errors: unknown[] = [];
    const scheduler = new SnapshotScheduler({
      runtime: live.runtime,
      directory,
      clock: live.clock,
      intervalMs: 1_000,
      timer,
      onError: (error) => errors.push(error),
      onSnapshot: () => {
        throw new Error('observer is broken');
      },
    });

    scheduler.start();
    expect(scheduler.running).toBe(true);
    tick?.();
    await scheduler.pending;
    tick?.();
    await scheduler.pending;
    scheduler.stop();

    expect(scheduler.snapshotCount).toBe(2);
    expect(scheduler.failureCount).toBe(0);
    // A throwing observer is reported, never mistaken for a failed snapshot.
    expect(errors).toHaveLength(2);
    expect(await listSnapshots(directory)).toHaveLength(2);
  });

  it('ALD-060: a snapshot write failure is counted and the next tick still runs', async () => {
    const { harness: live } = await runWithPolicy('snap-sched-2', 1);
    let failing = true;
    const errors: unknown[] = [];
    const scheduler = new SnapshotScheduler({
      runtime: {
        listRuns: () => {
          if (failing) {
            throw new Error('runtime is unavailable');
          }
          return live.runtime.listRuns();
        },
        adaptersFor: (runId) => live.runtime.adaptersFor(runId),
        writerFor: (runId) => live.runtime.writerFor(runId),
      },
      directory: snapshotDir(live.root),
      clock: live.clock,
      intervalMs: 1_000,
      onError: (error) => errors.push(error),
    });

    scheduler.trigger();
    await scheduler.pending;
    expect(scheduler.failureCount).toBe(1);
    expect(errors).toHaveLength(1);

    failing = false;
    scheduler.trigger();
    await scheduler.pending;
    expect(scheduler.snapshotCount).toBe(1);
  });
});

describe('ALD-060: final snapshot on shutdown (SPEC §14.4 SIGINT/SIGTERM)', () => {
  it('ALD-060: a SIGTERM listener writes one final snapshot and is idempotent', async () => {
    const { harness: live } = await runWithPolicy('snap-shutdown-1', 2);
    const directory = snapshotDir(live.root);
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const installed = installShutdownSnapshot({
      runtime: live.runtime,
      directory,
      clock: new FixedClock(),
      process: {
        on: (signal, listener) => listeners.set(signal, listener),
        off: (signal) => listeners.delete(signal),
        exit: ((code?: number) => {
          exits.push(code ?? 0);
          return undefined as never;
        }) as never,
      },
    });

    expect([...listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();
    const final = await installed.finalSnapshot();
    expect(final).toBeDefined();
    // Two signals, one snapshot: the handler is idempotent.
    expect(await listSnapshots(directory)).toHaveLength(1);
    installed.uninstall();
    expect(listeners.size).toBe(0);
    expect(exits.length).toBeGreaterThan(0);
  });

  it('ALD-060: a failing final snapshot still lets the process exit', async () => {
    const { harness: live } = await runWithPolicy('snap-shutdown-2', 1);
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const errors: unknown[] = [];
    const installed = installShutdownSnapshot({
      runtime: {
        listRuns: () => {
          throw new Error('runtime is gone');
        },
        adaptersFor: (runId) => live.runtime.adaptersFor(runId),
        writerFor: (runId) => live.runtime.writerFor(runId),
      },
      directory: snapshotDir(live.root),
      clock: new FixedClock(),
      onError: (error) => errors.push(error),
      exitCode: 3,
      process: {
        on: (signal, listener) => listeners.set(signal, listener),
        exit: ((code?: number) => {
          exits.push(code ?? 0);
          return undefined as never;
        }) as never,
      },
    });

    listeners.get('SIGINT')?.();
    await installed.finalSnapshot();
    expect(errors).toHaveLength(1);
    expect(exits).toEqual([3]);
  });

  it('ALD-060: a real child process writes the final snapshot when SIGTERM arrives', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(join(tmpdir(), 'ald-ops-shutdown-'));
    const fixture = fileURLToPath(
      new URL('./fixtures/shutdown-snapshot-child.ts', import.meta.url),
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fixture, directory],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      let signalSent = false;
      child.on('message', (message: unknown) => {
        if (
          !signalSent &&
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'shutdown-snapshot-ready'
        ) {
          signalSent = true;
          child.kill('SIGTERM');
        }
      });
      child.on('error', reject);
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child process did not exit in time'));
      }, 30_000).unref();
      child.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    const names = await listSnapshots(directory);
    expect(names).toHaveLength(1);
    const snapshot = await readSnapshotFile(join(directory, names[0] ?? ''));
    expect(snapshot.runs.map((run) => run.runId)).toEqual(['child-run']);
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  }, 60_000);
});
