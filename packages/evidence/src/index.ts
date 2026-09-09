/**
 * @ald/evidence — the authoritative local evidence store (LEDGER §3) and the
 * single Evidence Writer service (SPEC §4.1 item 7, §8.2).
 *
 * The only way to append to an event table is `SqliteEvidenceWriter`
 * (ALD-010 criterion 3): every SQL statement against `ledger_events`,
 * `channel_events`, `affect_events`, `audit_ledger_entries`, `turn_records`,
 * `intervention_log`, `checkpoint_manifests`, `anchor_receipts`,
 * `experiment_records`, `analysis_attachments`, `run_metadata`, `run_signers`,
 * and `fork_artifacts` is private to `writer.ts`.
 */
export { openEvidenceDatabase, type EvidenceDatabase } from './database.js';
export { applyMigrations, migrations } from './migrations.js';
export {
  canonicalizeJson,
  deserializeUnsignedLedgerEvent,
  parseCanonicalJson,
  serializeUnsignedLedgerEvent,
} from './canonical.js';
export {
  isLedgerEventType,
  LEDGER_EVENT_TYPES,
  validateLedgerEventDraft,
  type LedgerEventType,
} from './event-types.js';
export {
  CheckpointChainError,
  DuplicateEventError,
  DuplicateRunError,
  EvidenceWriterError,
  ExperimentRecordVersionError,
  ForkDetectedError,
  IntegrityBlockedError,
  InterpretationBindingError,
  InvalidRequestError,
  UnknownRunError,
  type EvidenceErrorCode,
} from './errors.js';
export {
  SqliteEvidenceWriter,
  type AffectAppendRequest,
  type ForkArtifactRecord,
  type SqliteEvidenceWriterOptions,
} from './writer.js';
export {
  buildRunManifest,
  exportRunBundle,
  type BundleReader,
  type ExportBundleOptions,
  type LearnerContractText,
  type RunManifestInput,
} from './export.js';
