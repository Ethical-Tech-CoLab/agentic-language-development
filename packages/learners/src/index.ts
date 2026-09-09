/**
 * `@ald/learners` — the `LearnerAdapter` seam (SPEC §6.2) and the reference
 * tracks that sit behind it.
 *
 * Implemented here:
 * - `no-learning` (ALD-042): the seeded uniform-random chance control;
 * - `scratch-rl` (ALD-045): tabular REINFORCE, the E11 naming-game baseline;
 * - `frozen-llm` (ALD-044), `self-supervised` (ALD-046), and `hybrid`
 *   (ALD-047);
 * - the versioned learner contracts and their lint (ALD-043);
 * - a reusable conformance harness every later track is checked against.
 *
 * The adapter interface is the only integration point the turn orchestrator
 * uses to reach a learner (ALD-042): nothing in this package touches the
 * Evidence Store, the Gateway, or the other Baby's state. Private ledger
 * writes go through the injected `PrivateLedgerClient`, which is the
 * `append_private_ledger_entry` tool of SPEC §6.3.
 */
import type { LearnerAdapterFactory, LearnerTrackId } from '@ald/types';

import { createFrozenLlmAdapterFactory, type FrozenLlmAdapterOptions } from './frozen-llm.js';
import { createHybridAdapterFactory, type HybridAdapterOptions } from './hybrid.js';
import { createNoLearningAdapterFactory } from './no-learning.js';
import {
  createSelfSupervisedAdapterFactory,
  type SelfSupervisedAdapterOptions,
} from './self-supervised.js';
import {
  createTabularReinforceAdapterFactory,
  type TabularReinforceOptions,
} from './tabular-reinforce.js';

/**
 * Options accepted by the built-in factories. Tracks ignore knobs they do not
 * use, so one option object can configure a whole run's adapter set.
 */
export type LearnerAdapterOptions = TabularReinforceOptions &
  FrozenLlmAdapterOptions &
  SelfSupervisedAdapterOptions &
  HybridAdapterOptions;

/** BACKLOG item that owns each unimplemented track (SPEC §6.1). */
export const UNIMPLEMENTED_TRACK_BACKLOG_ITEMS: Readonly<
  Partial<Record<LearnerTrackId, string>>
> = {};

/**
 * Adapter factory per track. All five SPEC §6.1 track IDs are implemented and
 * addressable behind the identical interface.
 */
export const ADAPTER_FACTORIES: Record<
  LearnerTrackId,
  (options?: LearnerAdapterOptions) => LearnerAdapterFactory
> = {
  'no-learning': (options = {}) => createNoLearningAdapterFactory(options),
  'scratch-rl': (options = {}) => createTabularReinforceAdapterFactory(options),
  'frozen-llm': (options = {}) => createFrozenLlmAdapterFactory(options),
  'self-supervised': (options = {}) => createSelfSupervisedAdapterFactory(options),
  hybrid: (options = {}) => createHybridAdapterFactory(options),
};

/** Build the adapter factory for one track (SPEC §11.1 `babyA.track`). */
export function createLearnerAdapterFactory(
  track: LearnerTrackId,
  options: LearnerAdapterOptions = {},
): LearnerAdapterFactory {
  return ADAPTER_FACTORIES[track](options);
}

export { createFrozenLlmAdapterFactory, type FrozenLlmAdapterOptions } from './frozen-llm.js';
export { formatModelRef } from './llm-client.js';
export { ScriptedModelClient } from './llm-scripted-client.js';
export {
  createSelfSupervisedAdapterFactory,
  type SelfSupervisedAdapterOptions,
} from './self-supervised.js';
export { createHybridAdapterFactory, type HybridAdapterOptions } from './hybrid.js';
export {
  NoLearningAdapter,
  createNoLearningAdapterFactory,
  type ExportedUniformRandomPolicy,
  type NoLearningAdapterOptions,
} from './no-learning.js';
export {
  SUPPORTED_LEARNING_SIGNALS,
  TabularReinforceAdapter,
  createTabularReinforceAdapterFactory,
  type TabularReinforceOptions,
} from './tabular-reinforce.js';
export {
  EXPORTED_TABULAR_POLICY_VERSION,
  EpisodicRegistriesSchema,
  ExportedTabularPolicySchema,
  POLICY_DECIMALS,
  TabularPolicyOptionsSchema,
  parseExportedTabularPolicy,
  tabularPolicyShape,
  type ExportedEpisodicRegistries,
  type ExportedHypothesisRecord,
  type ExportedTabularPolicy,
  type TabularPolicyOptions,
  type TabularPolicyShape,
} from './policy.js';
export {
  predictReceiverChoice,
  predictSenderSymbol,
  type ReceiverChoicePrediction,
  type SenderSymbolPrediction,
} from './ledger-prediction.js';
export {
  learnerContractPath,
  learnerContractsDirectory,
  loadLearnerContract,
  promptBundleHash,
  type TrackLearnerContract,
} from './contracts.js';
export {
  CONTRACT_LINT_RULES,
  lintLearnerContractText,
  type ContractLintRule,
} from './contract-lint.js';
export {
  AGENT_NATIVE_REFERENCE_FORMATS,
  FORBIDDEN_PROPOSAL_KEYS,
  RecordingLedgerClient,
  assertAgentNativeContent,
  assertToolOnlyProposal,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
  tailSuccessRate,
  type ConformanceOptions,
  type ConformanceResult,
} from './conformance.js';
export {
  LEARNER_LEDGER_EVENT_TYPES,
  REQUIRED_CONTENT_FIELDS,
  isLearnerLedgerEventType,
  validateLearnerDraft,
  type LearnerLedgerEventType,
} from './drafts.js';
export {
  attributesFromTypeCode,
  typeCodeCount,
  typeCodeFromAttributes,
  type GameShapeOptions,
} from './game.js';
export {
  LearnerConfigurationError,
  LearnerConformanceError,
  LearnerContractLintError,
  LearnerStateError,
  NotImplementedTrackError,
  UnsupportedLearningSignalError,
} from './errors.js';
