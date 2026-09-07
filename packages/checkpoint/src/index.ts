/**
 * @ald/checkpoint — ALD-013 checkpoint manifest generation, ALD-014 the
 * checkpoint frequency scheduler, and the inclusion/consistency proof files
 * an evidence bundle carries (LEDGER-INTEGRITY-DESIGN.md §7, §8, §9;
 * SPECIFICATION.md §11.7, §13.3; docs/evidence-bundle-format.md §5, §6).
 *
 * `EvidenceCheckpointService` is the `CheckpointService` implementation: it
 * reads every hash-chained stream through the Evidence Store, recomputes the
 * Merkle roots with `@ald/merkle`, has the run's `witness` key sign the
 * manifest hash, and hands the manifest to the Evidence Writer, which owns
 * the checkpoint chain. `CheckpointScheduler` drives its two periodic
 * triggers; lifecycle checkpoints stay with the orchestrator.
 */
export {
  EvidenceCheckpointService,
  type CheckpointCreationResult,
  type CheckpointCreator,
  type CheckpointEvidenceStore,
  type EvidenceCheckpointServiceOptions,
  type WriteProofFilesOptions,
  type WriteProofFilesResult,
} from './checkpoint-service.js';
export {
  CheckpointScheduler,
  nodeSchedulerTimer,
  schedulerIntervalsFromConfig,
  type CheckpointSchedulerOptions,
  type SchedulerTimer,
  type SchedulerTimerHandle,
} from './scheduler.js';
export {
  CheckpointIntegrityError,
  CheckpointNotFoundError,
  CheckpointProofRangeError,
  CheckpointServiceError,
  InvalidCheckpointRequestError,
  type CheckpointErrorCode,
} from './errors.js';
export {
  CHECKPOINT_STREAMS,
  EMPTY_TREE_REFERENCE,
  assertCheckpointStream,
  assertContiguousPrefix,
  assertManifestTrees,
  assertPrefixUnchanged,
  auxiliaryTreesFrom,
  mandatoryTreesFrom,
  referenceFor,
  snapshotFromEvents,
  treeNameFor,
  type CheckpointStream,
  type TreeSnapshot,
} from './trees.js';
