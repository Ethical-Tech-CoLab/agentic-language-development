/**
 * The fixed, pre-registered measurement→display mappings of
 * `affectMode: "derived"` (SPECIFICATION.md §9.3, ALD-033 criterion 2).
 *
 * > For `affectMode: "derived"`, the Baby cannot choose a `displayId`. After
 * > the outcome, the Gateway calls the adapter's `measureAffect()`, records
 * > the complete internal measurement privately, and maps it to `A1`-`A6`
 * > using a fixed pre-registered mapping. — SPEC §9.3
 *
 * "Fixed" is enforced structurally: a mapping is a pure function of the six
 * scores, it is looked up by the `RunConfig.affectDerivedMapping` name, and an
 * unknown name is refused rather than defaulted
 * ({@link UnknownAffectDerivedMappingError}). Nothing here is adaptive, seeded,
 * or run-dependent, so replaying a run reproduces the same display from the
 * same measurement.
 *
 * The mapping is deliberately *not* a claim about what a Baby "feels": it is a
 * documented projection of six adapter-reported scores onto six display
 * identifiers, and the scores themselves are the adapter's self-report
 * (SPEC §6.2 `measureAffect`).
 */
import {
  AFFECT_DISPLAY_IDS,
  type AffectDisplayId,
  type AffectStateMeasurement,
} from '@ald/types';

import { UnknownAffectDerivedMappingError } from './affect-errors.js';

/** SPEC §9.3: the allowlist has exactly six members. */
export const AFFECT_DISPLAY_COUNT = AFFECT_DISPLAY_IDS.length;

/** The `AffectStateMeasurement.measurementVersion` this registry understands. */
export const SUPPORTED_MEASUREMENT_VERSIONS: readonly string[] = ['v1'];

export interface AffectDerivedMapping {
  /** Pre-registered name matched against `RunConfig.affectDerivedMapping`. */
  readonly name: string;
  /** Pure projection of the six scores onto exactly one display. */
  map(measurement: AffectStateMeasurement): AffectDisplayId;
}

/**
 * `argmax-v1`: the display whose score is highest; ties resolve to the lowest
 * index, so the mapping is total and deterministic for every finite score
 * vector (including all-equal vectors, which map to `A1`).
 *
 * Non-finite scores are not handled here — the protocol rejects a measurement
 * that fails `AffectStateMeasurementSchema` plus its finiteness check before
 * the mapping is consulted, so `map` is only ever called on a validated
 * measurement.
 */
export const argmaxV1Mapping: AffectDerivedMapping = {
  name: 'argmax-v1',
  map(measurement) {
    const scores = measurement.scores;
    let best = 0;
    for (let index = 1; index < AFFECT_DISPLAY_COUNT; index += 1) {
      if ((scores[index] as number) > (scores[best] as number)) {
        best = index;
      }
    }
    return AFFECT_DISPLAY_IDS[best] as AffectDisplayId;
  },
};

/** The default when a run enables `derived` without naming a mapping. */
export const DEFAULT_AFFECT_DERIVED_MAPPING = argmaxV1Mapping.name;

const mappings = new Map<string, AffectDerivedMapping>([
  [argmaxV1Mapping.name, argmaxV1Mapping],
]);

/**
 * Registers an additional pre-registered mapping. A run may only use a
 * mapping that was registered before it started; registration is an operator
 * action, never a Baby-reachable one.
 */
export function registerAffectDerivedMapping(
  mapping: AffectDerivedMapping,
): void {
  mappings.set(mapping.name, mapping);
}

export function registeredAffectDerivedMappings(): string[] {
  return [...mappings.keys()].sort();
}

/** The mapping named `name`, or {@link UnknownAffectDerivedMappingError}. */
export function resolveAffectDerivedMapping(
  name: string | undefined,
): AffectDerivedMapping {
  const resolved = name ?? DEFAULT_AFFECT_DERIVED_MAPPING;
  const mapping = mappings.get(resolved);
  if (!mapping) {
    throw new UnknownAffectDerivedMappingError(
      resolved,
      registeredAffectDerivedMappings(),
    );
  }
  return mapping;
}

/** Test helper: drop every registration except the built-in `argmax-v1`. */
export function resetAffectDerivedMappings(): void {
  mappings.clear();
  mappings.set(argmaxV1Mapping.name, argmaxV1Mapping);
}
