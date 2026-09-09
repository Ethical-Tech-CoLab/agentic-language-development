/**
 * Child-process fixture for ALD-060's SPEC §14.4 requirement of "a final
 * snapshot on graceful shutdown (SIGINT/SIGTERM)".
 *
 * Run by `packages/ops/__tests__/snapshot.test.ts` under `tsx`. It installs
 * the real shutdown handler over a minimal `SnapshotSource` double — a real
 * evidence store is not what is under test here, the signal path is — sends
 * an IPC readiness message, and waits. The parent sends SIGTERM only after
 * that handshake; this process must write
 * exactly one snapshot file and exit 0.
 *
 * Imports only `../../src/snapshot.js` (which reaches no further than
 * `@ald/types` and `@ald/hashing`), so the fixture does not depend on any
 * other package's build output.
 */
import { GENESIS_HASH, type EventStream } from '@ald/types';

import { installShutdownSnapshot } from '../../src/snapshot.js';

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write('usage: shutdown-snapshot-child.ts <directory>\n');
  process.exit(2);
}

const heads = { size: 0, lastEntryHash: GENESIS_HASH };

const runtime = {
  listRuns: () => [
    {
      runId: 'child-run',
      experimentId: 'E03',
      deploymentMode: 'prototype' as const,
      state: 'running' as const,
      turn: 3,
      configurationHash: `sha256:${'a'.repeat(64)}`,
    },
  ],
  adaptersFor: () => ({
    'baby-a': { exportPolicy: () => ({ kind: 'child', role: 'a' }) },
    'baby-b': { exportPolicy: () => ({ kind: 'child', role: 'b' }) },
  }),
  writerFor: () => ({
    softwareCommit: 'git:child-fixture',
    chainHead: (_runId: string, stream: EventStream) => ({ stream, ...heads }),
    readEvents: () => [],
    readCheckpoints: () => [],
    readRunSigners: () => [],
  }),
} as unknown as Parameters<typeof installShutdownSnapshot>[0]['runtime'];

installShutdownSnapshot({
  runtime,
  directory,
  clock: { now: () => new Date().toISOString() },
  exitCode: 0,
});

// Keep the event loop alive until the signal arrives.
const keepAlive = setInterval(() => undefined, 1_000);
process.on('exit', () => clearInterval(keepAlive));

if (typeof process.send !== 'function') {
  throw new Error('shutdown snapshot fixture requires an IPC channel');
}
process.send({ type: 'shutdown-snapshot-ready' });
