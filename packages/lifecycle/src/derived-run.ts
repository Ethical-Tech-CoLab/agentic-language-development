/**
 * Derived-run configuration and lineage (SPECIFICATION.md §7.4 Derived Runs
 * and Lineage; BACKLOG ALD-028).
 *
 * A derived run is a new run initialized from an immutable parent checkpoint
 * for partner replacement, longitudinal comparison, rollback controls, or
 * replication. It is a distinct run: a new `runId`, its own event chains
 * starting at sequence 1, and read-only references to the parent by hash.
 *
 * SPEC §7.4 reserves the §7.3 integrity-failure vocabulary for a different
 * condition, so every identifier and message in this module says
 * "derived run" or "branch" instead.
 */
import type { RunConfig } from '@ald/types';

import { assertValidRunConfig } from './run-config.js';

/** Thrown when a child configuration violates a §7.4 lineage requirement. */
export class LineageError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'LineageError';
    this.field = field;
  }
}

export interface DerivedRunOptions {
  /** Parent policy checkpoint the child Baby A starts from (§7.4). */
  babyAInitialPolicyRef: string;
  /** Parent policy checkpoint the child Baby B starts from (§7.4). */
  babyBInitialPolicyRef: string;
  /**
   * Pre-registered changes to the child configuration — for example a
   * replacement learner for one Baby (E30) or a different seed (E50).
   * `runId`, `parentRunId`, `derivedFromCheckpointHash`, and both
   * `initialPolicyRef` values are owned by this function and cannot be
   * overridden.
   */
  overrides?: Partial<RunConfig>;
}

/** The four §7.4 lineage fields, all required together. */
export interface RunLineage {
  runId: string;
  parentRunId: string;
  derivedFromCheckpointHash: string;
  babyAInitialPolicyRef: string;
  babyBInitialPolicyRef: string;
}

/** True when every §7.4 lineage field is present. */
export function isDerivedRunConfig(config: RunConfig): boolean {
  return (
    config.parentRunId !== undefined &&
    config.derivedFromCheckpointHash !== undefined &&
    config.babyA.initialPolicyRef !== undefined &&
    config.babyB.initialPolicyRef !== undefined
  );
}

/**
 * Read the §7.4 lineage of a child configuration. Throws
 * {@link LineageError} if any field is missing, so callers that need lineage
 * never see a half-populated record.
 */
export function readLineage(config: RunConfig): RunLineage {
  const { parentRunId, derivedFromCheckpointHash } = config;
  const babyAInitialPolicyRef = config.babyA.initialPolicyRef;
  const babyBInitialPolicyRef = config.babyB.initialPolicyRef;

  if (parentRunId === undefined) {
    throw new LineageError(
      'parentRunId',
      'derived run configuration is missing parentRunId (SPECIFICATION.md §7.4)',
    );
  }
  if (derivedFromCheckpointHash === undefined) {
    throw new LineageError(
      'derivedFromCheckpointHash',
      'derived run configuration is missing derivedFromCheckpointHash (SPECIFICATION.md §7.4)',
    );
  }
  if (babyAInitialPolicyRef === undefined) {
    throw new LineageError(
      'babyA.initialPolicyRef',
      'derived run configuration is missing babyA.initialPolicyRef (SPECIFICATION.md §7.4)',
    );
  }
  if (babyBInitialPolicyRef === undefined) {
    throw new LineageError(
      'babyB.initialPolicyRef',
      'derived run configuration is missing babyB.initialPolicyRef (SPECIFICATION.md §7.4)',
    );
  }

  return {
    runId: config.runId,
    parentRunId,
    derivedFromCheckpointHash,
    babyAInitialPolicyRef,
    babyBInitialPolicyRef,
  };
}

/**
 * ALD-028: build the child `RunConfig` for a derived run.
 *
 * The child inherits every parent field, then applies the pre-registered
 * `overrides`, then the four lineage bindings, which always win. The result is
 * validated with the ALD-023 rules before it is returned.
 */
export function createDerivedRunConfig(
  parent: RunConfig,
  parentCheckpointHash: string,
  childRunId: string,
  options: DerivedRunOptions,
): RunConfig {
  if (childRunId.length === 0) {
    throw new LineageError('runId', 'a derived run requires its own runId');
  }
  if (childRunId === parent.runId) {
    throw new LineageError(
      'runId',
      `a derived run must not reuse the parent run identifier "${parent.runId}" ` +
        '(SPECIFICATION.md §7.4)',
    );
  }

  const overrides = options.overrides ?? {};
  const merged: RunConfig = {
    ...parent,
    ...overrides,
    runId: childRunId,
    parentRunId: parent.runId,
    derivedFromCheckpointHash: parentCheckpointHash,
    babyA: {
      ...parent.babyA,
      ...overrides.babyA,
      initialPolicyRef: options.babyAInitialPolicyRef,
    },
    babyB: {
      ...parent.babyB,
      ...overrides.babyB,
      initialPolicyRef: options.babyBInitialPolicyRef,
    },
  };

  return assertValidRunConfig(merged).config;
}

/**
 * ALD-028: assert that `child` is a well-formed descendant of `parent`.
 *
 * Rejects a reused parent `runId`, a lineage record that points at a
 * different parent, and any missing lineage field. It does not touch parent
 * evidence: the parent bundle is read-only and referenced by hash (§7.4).
 */
export function assertLineage(child: RunConfig, parent: RunConfig): RunLineage {
  const lineage = readLineage(child);

  if (child.runId === parent.runId) {
    throw new LineageError(
      'runId',
      `a derived run must not reuse the parent run identifier "${parent.runId}" ` +
        '(SPECIFICATION.md §7.4)',
    );
  }
  if (lineage.parentRunId !== parent.runId) {
    throw new LineageError(
      'parentRunId',
      `derived run "${child.runId}" records parentRunId "${lineage.parentRunId}" but was ` +
        `checked against parent "${parent.runId}" (SPECIFICATION.md §7.4)`,
    );
  }

  assertValidRunConfig(child);
  return lineage;
}
