/**
 * Minimal FIFO async mutex.
 *
 * LEDGER §3 requires every write to be serialized through one evidence-writer
 * service: sequence assignment reads the chain head and must not observe a
 * head another write is about to advance. Signatures are awaited inside the
 * critical section, so the lock has to survive `await` points — a synchronous
 * SQLite transaction alone is not enough.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `task` once every previously queued task has settled. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
