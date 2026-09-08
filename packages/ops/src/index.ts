/**
 * `@ald/ops` — the operations layer of SPECIFICATION.md §14: the telemetry
 * pipeline (§14.1), runtime snapshot/restore (§14.4), the failure-handling
 * policy (§14.5), and the retention enforcement job (§14.6).
 *
 * Owning backlog items: ALD-058 (telemetry event pipeline), ALD-060
 * (snapshot and restore), ALD-061 (failure handling policy), ALD-062
 * (retention policy enforcement job), plus the ALD-059 criterion-2 evidence
 * that every §14.2 intervention already produces a checkpoint (asserted in
 * `__tests__/interventions-checkpoint.test.ts`; the notebook deviation-record
 * link is the integrator's half of that criterion).
 *
 * Design rules that hold across the whole package:
 *
 * - **The evidence store is authoritative; nothing here competes with it.**
 *   Telemetry has its own SQLite file, snapshots are derived state, and
 *   retention deletes exported files only. No module in this package opens a
 *   write connection to `ald.sqlite`.
 * - **Operations code never fails the thing it observes.** Telemetry
 *   recording, snapshot ticks, and background-task supervision all resolve
 *   rather than throw, and count their own failures.
 * - **Prototype Mode claim boundary (§5.1, §5.4).** Everything here is Mode P
 *   software readiness. Nothing in this package asserts a research finding, an
 *   isolation property, or a Mode R claim label.
 * - **No Baby ever sees any of this.** `@ald/ops` sits entirely on the
 *   researcher/operator side of the §4.2 trust boundary, and no record it
 *   writes carries an observation, a proposal, a rejected payload, or free
 *   text from a Baby.
 */
export {
  isOpsError,
  OpsError,
  RetentionError,
  SnapshotError,
  SupervisedTaskError,
  TelemetryError,
  type OpsErrorCode,
} from './errors.js';

export {
  guardTelemetrySink,
  InMemoryTelemetrySink,
  SqliteTelemetrySink,
  TELEMETRY_RECORD_VERSION,
  TelemetryRecordSchema,
  type GuardTelemetrySinkOptions,
  type InMemoryTelemetrySinkOptions,
  type SqliteTelemetrySinkOptions,
  type TelemetryQuery,
  type TelemetryRecord,
  type TelemetryRecordInput,
  type TelemetrySink,
} from './telemetry.js';

export {
  computeRunMetrics,
  turnPhaseCounts,
  windowsOpenedFor,
  type ComputeRunMetricsOptions,
  type LatencySummary,
  type RunMetrics,
  type RunMetricsReader,
} from './metrics.js';

export {
  autoRestore,
  buildRuntimeSnapshot,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  installShutdownSnapshot,
  latestSnapshotPath,
  listSnapshots,
  nodeSnapshotTimer,
  policyFileName,
  readSnapshotFile,
  restorePolicyFiles,
  RUNTIME_SNAPSHOT_VERSION,
  RuntimeSnapshotSchema,
  SNAPSHOT_INTERVAL_ENV_VAR,
  snapshotDigest,
  snapshotFileName,
  snapshotIntervalFromEnv,
  SnapshotScheduler,
  takeSnapshot,
  verifySnapshotPrefix,
  type AutoRestoreOptions,
  type AutoRestoreResult,
  type BuildSnapshotOptions,
  type ChainHeadSnapshot,
  type RestoreTarget,
  type RestoredRun,
  type RunPrefixCheck,
  type RuntimeSnapshot,
  type RuntimeSnapshotRun,
  type ShutdownSnapshotOptions,
  type SnapshotEvidenceReader,
  type SnapshotSchedulerOptions,
  type SnapshotSource,
  type SnapshotTimer,
  type SnapshotTimerHandle,
  type SignalProcess,
  type StreamPrefixCheck,
  type TakeSnapshotResult,
} from './snapshot.js';

export {
  buildFailureRecord,
  FAILURE_MESSAGE_DIGEST_DOMAIN,
  FAILURE_MESSAGE_LIMIT,
  FAILURE_MODE_TABLE,
  FATAL_ERROR_CODES,
  FATAL_ERROR_MARKER,
  FATAL_EXIT_CODE,
  failureModeHandling,
  InMemoryFailureLogger,
  installProcessFailureHandlers,
  isFatalFailure,
  supervise,
  type BuildFailureRecordOptions,
  type FailureHostProcess,
  type FailureLogRecord,
  type FailureMode,
  type FailureModeAction,
  type FailureModeHandling,
  type FailureModeOwner,
  type FailureSource,
  type ProcessFailureHandlerOptions,
  type ProcessFailureHandlers,
  type StructuredLogger,
  type SuperviseOptions,
  type SuperviseResult,
  type SuperviseRetryOptions,
} from './failure-policy.js';

export {
  PublicReleaseMarkerSchema,
  PURGEABLE_BUNDLE_ENTRIES,
  PURGE_TOMBSTONE,
  PUBLIC_RELEASE_MARKER,
  readPublicReleaseMarker,
  readRetentionLog,
  RETENTION_LOG_FILE,
  RETENTION_LOG_HASH_DOMAIN,
  RetentionAuditLog,
  RetentionLogEntrySchema,
  runRetentionJob,
  type PublicReleaseMarker,
  type PurgedFileRecord,
  type RetentionJobResult,
  type RetentionLogEntry,
  type RetentionLogReadResult,
  type RetentionReader,
  type RetentionSkipReason,
  type RunRetentionDecision,
  type RunRetentionOptions,
} from './retention.js';
