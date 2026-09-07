/**
 * @ald/lifecycle — run configuration validation (ALD-023), the SPEC §7.2 run
 * state machine (ALD-024), the state-level half of pause/abort semantics
 * (ALD-026), and derived-run configuration lineage (ALD-028).
 *
 * Everything here is pure and synchronous: no evidence writes, no clock, no
 * I/O. The orchestrator owns the side effects that SPEC §7.2 requires and can
 * enumerate them with `requiredSideEffects`.
 */
export {
  InvalidTransitionError,
  RunLifecycle,
  RunNotAcceptingTurnsError,
  RUN_SIDE_EFFECTS,
  TERMINAL_RUN_STATES,
  TRANSITIONS,
  acceptsTurns,
  isActiveState,
  isRunState,
  isTerminalState,
  requiredSideEffects,
  transitionsFrom,
  type RunSideEffect,
  type TerminalRunState,
} from './state-machine.js';

export {
  RUN_CONFIG_DEFAULTS,
  RunConfigValidationError,
  assertValidRunConfig,
  buildRunConfig,
  hashRunConfig,
  validateRunConfig,
  type RunConfigError,
  type RunConfigOverrides,
  type RunConfigValidation,
} from './run-config.js';

export {
  LineageError,
  assertLineage,
  createDerivedRunConfig,
  isDerivedRunConfig,
  readLineage,
  type DerivedRunOptions,
  type RunLineage,
} from './derived-run.js';
