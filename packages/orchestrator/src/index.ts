/**
 * `@ald/orchestrator` — the Nursery Controller runtime (SPECIFICATION.md
 * §4.1 item 2): the turn-phase orchestrator of §8.1, the runtime half of the
 * §7.2 lifecycle (pause, resume, abort, seal), crash recovery and
 * integrity-fork handling of §7.3, the intervention and safety logging of
 * §14.2/§14.5, the versioned Experiment Record writer of §11.9, and the
 * §14.3 replay checks.
 *
 * Owning backlog items: ALD-025, ALD-026, ALD-027, ALD-059 (partial),
 * ALD-071 (partial).
 *
 * The runtime consumes the Checkpoint Service, the Base Anchor Publisher, and
 * the Verifier through their contracts only; nothing here imports those
 * packages, so a run can be assembled with a test double, a production
 * service, or none at all.
 */
export {
  ANCHORING_SKIPPED_DEVIATION,
  ANCHORING_SKIPPED_REASON,
  BABY_ROLES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_EVALUATION_TURNS,
  NURSERY_ACTOR_ID,
  NurseryRuntimeImpl,
  UNANCHORED_TX_REF,
  createNurseryRuntime,
  senderForTurn,
  type NurseryRuntimeOptions,
  type RunToCompletionOptions,
} from './nursery-runtime.js';
export { RuntimePrivateLedgerClient } from './private-ledger.js';
export {
  replayDigest,
  replayTuples,
  scenarioReplayCheck,
  type ReplayTuple,
  type ScenarioReplayInput,
  type ScenarioReplayResult,
} from './replay.js';
export {
  AnchorPolicyError,
  ConfigurationMismatchError,
  DuplicateRunError,
  NurseryRuntimeError,
  RunConfigurationError,
  RunStateError,
  UnknownRunError,
  UnsupportedConditionError,
  VerifierNotConfiguredError,
  type RuntimeErrorCode,
} from './errors.js';
export {
  SimpleCheckpointService,
  createSimpleProofWriter,
  simpleCheckpointFactory,
  treeNameForStream,
  type SimpleCheckpointServiceOptions,
} from './testing.js';

export * from './experiments/index.js';
export * from './production.js';
export * from './registry.js';
