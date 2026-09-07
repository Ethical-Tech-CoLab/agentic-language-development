/**
 * `@ald/learners` — the `LearnerAdapter` seam (SPEC §6.2) and the reference
 * tracks that sit behind it.
 *
 * Implemented here:
 * - `no-learning` (ALD-042): the seeded uniform-random chance control;
 * - `scratch-rl` (ALD-045): tabular REINFORCE, the E11 naming-game baseline;
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

import { NotImplementedTrackError } from './errors.js';
import { createNoLearningAdapterFactory } from './no-learning.js';
import {
  createTabularReinforceAdapterFactory,
  type TabularReinforceOptions,
} from './tabular-reinforce.js';

/**
 * Options accepted by the built-in factories. Tracks ignore knobs they do not
 * use, so one option object can configure a whole run's adapter set.
 */
export type LearnerAdapterOptions = TabularReinforceOptions;

/** BACKLOG item that owns each unimplemented track (SPEC §6.1). */
export const UNIMPLEMENTED_TRACK_BACKLOG_ITEMS = {
  'frozen-llm': 'ALD-044',
  'self-supervised': 'ALD-046',
  hybrid: 'ALD-047',
} as const;

/**
 * Adapter factory per track. All five SPEC §6.1 track IDs are addressable
 * behind the identical interface; the three that are not implemented yet throw
 * `NotImplementedTrackError` naming their BACKLOG item rather than silently
 * falling back to another track.
 */
export const ADAPTER_FACTORIES: Record<
  LearnerTrackId,
  (options?: LearnerAdapterOptions) => LearnerAdapterFactory
> = {
  'no-learning': (options = {}) => createNoLearningAdapterFactory(options),
  'scratch-rl': (options = {}) => createTabularReinforceAdapterFactory(options),
  'frozen-llm': () => {
    throw new NotImplementedTrackError(
      'frozen-llm',
      UNIMPLEMENTED_TRACK_BACKLOG_ITEMS['frozen-llm'],
    );
  },
  'self-supervised': () => {
    throw new NotImplementedTrackError(
      'self-supervised',
      UNIMPLEMENTED_TRACK_BACKLOG_ITEMS['self-supervised'],
    );
  },
  hybrid: () => {
    throw new NotImplementedTrackError(
      'hybrid',
      UNIMPLEMENTED_TRACK_BACKLOG_ITEMS.hybrid,
    );
  },
};

/** Build the adapter factory for one track (SPEC §11.1 `babyA.track`). */
export function createLearnerAdapterFactory(
  track: LearnerTrackId,
  options: LearnerAdapterOptions = {},
): LearnerAdapterFactory {
  return ADAPTER_FACTORIES[track](options);
}

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
  ExportedTabularPolicySchema,
  POLICY_DECIMALS,
  TabularPolicyOptionsSchema,
  parseExportedTabularPolicy,
  tabularPolicyShape,
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
  FORBIDDEN_PROPOSAL_KEYS,
  RecordingLedgerClient,
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
