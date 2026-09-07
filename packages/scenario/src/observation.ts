/**
 * Observation builder (ALD-037; SPECIFICATION.md §11.2).
 *
 * §11.2 fixes the Observation shape exactly:
 *
 * ```typescript
 * interface Observation {
 *   runId: string; turn: number; recipient: "baby-a" | "baby-b";
 *   encoding: "opaque-numeric" | "pixel" | "hybrid-features";
 *   payload: number[] | number[][];   // never a human-language string field
 *   scenarioRef: string;              // opaque scenario instance id
 * }
 * ```
 *
 * This module is the only code path that produces an Observation delivered to
 * a learner (ALD-037 criterion 3). It assembles the six fields field by field
 * — never by spreading a scenario state object, which is how an extra field
 * leaks in — and then runs the §10.1 Observation Hygiene Filter, so an
 * Observation that reaches a learner has provably passed both checks.
 */
import { HASH_DOMAINS, type BabyRole, type Observation, type RunConfig } from '@ald/types';
import { hashCanonical } from '@ald/hashing';

import {
  assertObservationHygiene,
  type HygieneScanOptions,
} from './hygiene.js';

export interface ObservationBuildInput {
  runId: string;
  turn: number;
  recipient: BabyRole;
  encoding: RunConfig['observationEncoding'];
  payload: Observation['payload'];
  /** Opaque scenario instance id, `scn:<16 hex>` (SPEC §11.2). */
  scenarioRef: string;
}

/** Defensive copy so later mutation of scenario state cannot reach a learner. */
function clonePayload(payload: Observation['payload']): Observation['payload'] {
  const rows = payload as Array<number | number[]>;
  const copied = rows.map((row) => (Array.isArray(row) ? [...row] : row));
  return copied as Observation['payload'];
}

/**
 * Build one Observation for one recipient. Deterministic and total: identical
 * input yields an object whose canonical JSON is byte-identical
 * (ALD-037 criterion 2), and every payload row is copied so a later mutation
 * of scenario state cannot alter an already-delivered observation.
 */
export function buildObservation(
  input: ObservationBuildInput,
  options: HygieneScanOptions = {},
): Observation {
  const payload = clonePayload(input.payload);

  const observation: Observation = {
    runId: input.runId,
    turn: input.turn,
    recipient: input.recipient,
    encoding: input.encoding,
    payload,
    scenarioRef: input.scenarioRef,
  };

  return assertObservationHygiene(observation, options);
}

/**
 * Domain-separated hash of a built Observation, as recorded in
 * `TurnRecord.observationHashes` (SPEC §14.3).
 */
export function hashObservation(observation: Observation): string {
  return hashCanonical(HASH_DOMAINS.observation, observation);
}
