/**
 * Process-wide Nursery Runtime registry, Prototype Mode only.
 *
 * SPECIFICATION.md §12 describes the DTSF twin routes as thin dispatchers
 * onto the Nursery Controller runtime (`NurseryRuntime`, §12.5-§12.6). In
 * Mode P (§5.1) every twin pack runs in the same process, so the runtime
 * that `twins/packs/nursery` constructs in `init()` is looked up here by the
 * `nursery`, `baby-a`, and `baby-b` behavior packs instead of each twin
 * owning a separate instance or the twins importing one another directly.
 *
 * This registry MUST NOT be used to bridge Mode R (§5.2): a research-grade
 * deployment gives each twin its own process/container, and route handlers
 * there would reach the runtime over the network, not through process
 * globals. Nothing here enforces that boundary; it is a Mode P convenience
 * only (BACKLOG ALD-049).
 *
 * Typed against the concrete runtime, not the narrower `NurseryRuntime`
 * contract in `@ald/types`: twin routes also need `adaptersFor`,
 * `bundleDirFor`, `recordHumanView`, `annotate`, and `recover`, which are
 * part of `NurseryRuntimeImpl`'s public surface but not the minimal
 * contract other consumers (e.g. a future remote Mode R client) implement.
 */
import type { NurseryRuntimeImpl } from './nursery-runtime.js';

let currentRuntime: NurseryRuntimeImpl | undefined;

/** Thrown by {@link getNurseryRuntime} before any pack has called {@link setNurseryRuntime}. */
export class RuntimeNotInitializedError extends Error {
  constructor() {
    super(
      'No NurseryRuntime is registered. In Mode P, the `nursery` twin pack ' +
        "calls setNurseryRuntime(...) from its init(context) before any " +
        'route can be served; make sure the nursery twin is initialized ' +
        'before baby-a/baby-b route dispatch, or (in tests) call ' +
        'setNurseryRuntime(...) directly before exercising a pack.',
    );
    this.name = 'RuntimeNotInitializedError';
  }
}

/**
 * Registers the process-wide runtime instance. The `nursery` twin pack's
 * `init(context)` calls this once per process; a later call replaces the
 * registered runtime (used by tests that build a fresh runtime per case).
 */
export function setNurseryRuntime(runtime: NurseryRuntimeImpl): void {
  currentRuntime = runtime;
}

/**
 * Returns the registered runtime, or throws {@link RuntimeNotInitializedError}
 * if {@link setNurseryRuntime} has not been called yet in this process.
 */
export function getNurseryRuntime(): NurseryRuntimeImpl {
  if (currentRuntime === undefined) {
    throw new RuntimeNotInitializedError();
  }
  return currentRuntime;
}

/** Clears the registered runtime. Test teardown only. */
export function resetNurseryRuntime(): void {
  currentRuntime = undefined;
}
