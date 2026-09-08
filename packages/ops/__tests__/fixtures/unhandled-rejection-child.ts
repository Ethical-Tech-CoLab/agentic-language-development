/**
 * Child-process fixture for ALD-061 criterion 2: "An unhandled rejection
 * thrown from a background task (e.g., a failed anchor confirmation poll) is
 * caught, logged, and does not crash the server process, confirmed by a
 * fault-injection test."
 *
 * Run by `packages/ops/__tests__/failure-policy.test.ts` under `tsx`. It
 * installs the real process handlers, then starts a background task that
 * rejects without any `await` or `.catch()` — the exact shape §14.5 names —
 * and a second one that throws synchronously from a timer callback. If the
 * handlers did their job, this process is still alive afterwards and prints a
 * JSON summary before exiting 0.
 *
 * Imports only `../../src/failure-policy.js`, whose transitive imports are
 * `@ald/anchor`, `@ald/orchestrator`, `@ald/hashing`, and `@ald/types`.
 */
import {
  InMemoryFailureLogger,
  installProcessFailureHandlers,
} from '../../src/failure-policy.js';

const logger = new InMemoryFailureLogger();
const handlers = installProcessFailureHandlers({
  logger,
  // A fatal classification would exit; nothing here is in the fatal set, so
  // reaching the summary below is itself the assertion.
  onFatal: () => {
    process.stdout.write('UNEXPECTED FATAL\n');
    process.exit(1);
  },
});

/** A background task exactly as §14.5 describes: nothing awaits it. */
function failedAnchorConfirmationPoll(): void {
  void Promise.reject(new Error('rpc endpoint unavailable: 0x-secret-payload'));
}

/** A background timer callback that throws synchronously. */
function crashingCheckpointTick(): void {
  setTimeout(() => {
    throw new Error('checkpoint scheduler tick failed');
  }, 5);
}

failedAnchorConfirmationPoll();
crashingCheckpointTick();

setTimeout(() => {
  process.stdout.write(
    `${JSON.stringify({
      survived: true,
      logged: handlers.loggedCount,
      fatal: handlers.fatalCount,
      sources: logger.records.map((record) => record.source),
      messagesLogged: logger.records.filter(
        (record) => record.message !== undefined,
      ).length,
    })}\n`,
  );
  handlers.uninstall();
  process.exit(0);
}, 300);
