/**
 * @ald/scenario — the deterministic Scenario Engine (SPECIFICATION.md §4.1
 * item 4), its SPEC §11.2 Observation builder, and the §10.1 Observation
 * Hygiene Filter.
 *
 * `ReferentialScenarioEngine` (ALD-041) generates the CONCEPT-IDEA.md §13
 * "Naming" stage referential game and all five §9.5 interaction profiles from
 * a run seed alone; `buildObservation` (ALD-037) is the only code path that
 * produces an Observation delivered to a learner; `assertObservationHygiene`
 * (ALD-038) is the no-bypass gate in front of it.
 */
export {
  ReferentialGroundTruthSchema,
  ReferentialScenarioEngine,
  ScenarioEngineError,
  readGroundTruth,
  zoneOfPossibleAgreement,
  type ReferentialGroundTruth,
  type ReferentialScenarioConfig,
  type ReferentialScenarioConfigInput,
  type ScenarioErrorCode,
} from './referential-engine.js';
export {
  buildObservation,
  hashObservation,
  type ObservationBuildInput,
} from './observation.js';
export {
  BANNED_LANGUAGE_TOKENS,
  HygieneViolationError,
  OBSERVATION_FIELDS,
  RUN_ID_PATTERN,
  SCENARIO_REF_PATTERN,
  assertObservationHygiene,
  hygieneErrors,
  scanForHumanLanguage,
  type HygieneError,
  type HygieneReasonCode,
  type HygieneScanOptions,
} from './hygiene.js';
