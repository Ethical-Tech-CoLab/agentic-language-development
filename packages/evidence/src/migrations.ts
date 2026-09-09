import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const protectedTables = [
  'run_metadata',
  'ledger_events',
  'channel_events',
  'affect_events',
  'audit_ledger_entries',
  'intervention_log',
  'checkpoint_manifests',
  'anchor_receipts',
  'experiment_records',
] as const;

/**
 * Append-only guard triggers (LEDGER §3). The emitted SQL is part of the
 * checksum of every migration that uses it, so its text MUST NOT change.
 */
function appendOnlyTriggers(table: string): string {
  return `
    CREATE TRIGGER ${table}_reject_update
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, 'append-only table: ${table}');
    END;

    CREATE TRIGGER ${table}_reject_delete
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, 'append-only table: ${table}');
    END;
  `;
}

const initialSchema = `
  CREATE TABLE run_metadata (
    run_id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('prototype', 'research-grade')),
    configuration_hash TEXT NOT NULL,
    configuration_json TEXT NOT NULL,
    parent_run_id TEXT,
    derived_from_checkpoint_hash TEXT
  ) STRICT;

  CREATE TABLE ledger_events (
    run_id TEXT NOT NULL,
    baby_id TEXT NOT NULL CHECK (baby_id IN ('A', 'B')),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    turn INTEGER NOT NULL CHECK (turn >= 0),
    event_type TEXT NOT NULL,
    content_schema TEXT NOT NULL CHECK (content_schema IN ('human-audit-ledger', 'agent-native-ledger')),
    previous_entry_hash TEXT NOT NULL,
    channel_event_hash TEXT,
    entry_hash TEXT NOT NULL UNIQUE,
    writer_key_id TEXT NOT NULL,
    writer_signature TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, baby_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE channel_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    turn INTEGER NOT NULL CHECK (turn >= 0),
    logical_sender TEXT NOT NULL CHECK (logical_sender IN ('baby-a', 'baby-b')),
    origin TEXT NOT NULL CHECK (origin IN ('baby', 'gateway-control')),
    communication_condition TEXT NOT NULL,
    baby_proposal_hash TEXT,
    sender_ledger_sequence INTEGER,
    sender_entry_hash TEXT,
    public_artifact_hash TEXT NOT NULL,
    previous_channel_hash TEXT NOT NULL,
    validation_result TEXT NOT NULL CHECK (validation_result IN ('accepted', 'rejected')),
    entry_hash TEXT NOT NULL UNIQUE,
    writer_key_id TEXT NOT NULL,
    writer_signature TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE affect_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    turn INTEGER NOT NULL CHECK (turn >= 0),
    sender TEXT NOT NULL CHECK (sender IN ('baby-a', 'baby-b')),
    display_id TEXT NOT NULL CHECK (display_id IN ('A1', 'A2', 'A3', 'A4', 'A5', 'A6')),
    affect_mode TEXT NOT NULL CHECK (affect_mode IN ('declared', 'permuted', 'opaque', 'derived')),
    previous_entry_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL UNIQUE,
    writer_key_id TEXT NOT NULL,
    writer_signature TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE audit_ledger_entries (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    baby_id TEXT NOT NULL CHECK (baby_id IN ('A', 'B')),
    source TEXT NOT NULL CHECK (source = 'generated-analysis'),
    source_entry_hash TEXT NOT NULL,
    previous_entry_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL UNIQUE,
    writer_key_id TEXT NOT NULL,
    writer_signature TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE intervention_log (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    previous_entry_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE checkpoint_manifests (
    run_id TEXT NOT NULL,
    checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence >= 0),
    checkpoint_hash TEXT NOT NULL UNIQUE,
    previous_checkpoint_hash TEXT NOT NULL,
    witness_key_id TEXT NOT NULL,
    witness_signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, checkpoint_sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE anchor_receipts (
    run_id TEXT NOT NULL,
    checkpoint_hash TEXT NOT NULL,
    chain_id INTEGER NOT NULL CHECK (chain_id > 0),
    transaction_hash TEXT NOT NULL,
    block_number INTEGER CHECK (block_number >= 0),
    status TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    finality_policy TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (chain_id, transaction_hash),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id),
    FOREIGN KEY (checkpoint_hash) REFERENCES checkpoint_manifests(checkpoint_hash)
  ) STRICT;

  CREATE TABLE experiment_records (
    run_id TEXT NOT NULL,
    record_version INTEGER NOT NULL CHECK (record_version > 0),
    experiment_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('valid', 'invalid', 'aborted')),
    checkpoint_manifest_ref TEXT NOT NULL,
    anchor_tx_ref TEXT NOT NULL,
    verifier_report_ref TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, record_version),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  ${protectedTables.map(appendOnlyTriggers).join('\n')}

  CREATE INDEX ledger_events_run_turn_idx
    ON ledger_events(run_id, turn);
  CREATE INDEX channel_events_run_turn_idx
    ON channel_events(run_id, turn);
  CREATE INDEX checkpoint_manifests_run_hash_idx
    ON checkpoint_manifests(run_id, checkpoint_hash);
  CREATE INDEX experiment_records_current_idx
    ON experiment_records(run_id, record_version DESC);
`;

/**
 * Tables added by migration 2. `turn_records` is the implementation-defined
 * `turns` stream (SPEC §14.3 replay tuples), `run_signers` binds a run to the
 * public halves of its per-run keys (LEDGER §11: public keys only, never
 * seeds), and `fork_artifacts` preserves both sides of a detected fork
 * (LEDGER §15).
 */
const turnRecordAndForkSchema = `
  CREATE TABLE turn_records (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    turn INTEGER NOT NULL CHECK (turn >= 0),
    phase TEXT NOT NULL CHECK (phase IN ('running', 'evaluating')),
    previous_entry_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL UNIQUE,
    writer_key_id TEXT NOT NULL,
    writer_signature TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE run_signers (
    run_id TEXT NOT NULL,
    domain TEXT NOT NULL CHECK (domain IN (
      'baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit', 'witness'
    )),
    key_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, domain),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  CREATE TABLE fork_artifacts (
    run_id TEXT NOT NULL,
    stream TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    entry_hash TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (run_id, stream, sequence, entry_hash)
  ) STRICT;

  ${['turn_records', 'run_signers', 'fork_artifacts']
    .map(appendOnlyTriggers)
    .join('\n')}

  CREATE INDEX turn_records_run_turn_idx
    ON turn_records(run_id, turn);
  CREATE INDEX fork_artifacts_run_idx
    ON fork_artifacts(run_id, stream, sequence);
`;

/**
 * Migration 3 constrains `fork_artifacts`, the one event table migration 2
 * left without a domain check or a run reference. A fork artifact is read
 * back during recovery (LEDGER §15) and its `stream` column is used to pick
 * the physical table to compare against, so an out-of-domain value is not
 * inert data: it is a poison row on the integrity-verification path that the
 * append-only triggers make unremovable. The `CHECK` keeps the column inside
 * `EVENT_STREAMS` and the `FOREIGN KEY` keeps an artifact bound to a
 * registered run, matching every other event table in migration 1.
 *
 * SQLite cannot add a `CHECK` or a `FOREIGN KEY` with `ALTER TABLE`, so this
 * is the documented table rebuild: drop the guard triggers, copy every row
 * into the constrained table, drop the old one, rename, then reinstate the
 * triggers and the index. The stream list is spelled out rather than
 * interpolated from `EVENT_STREAMS` because migration SQL is checksummed and
 * must never change once applied.
 */
const forkArtifactConstraintsSchema = `
  DROP TRIGGER fork_artifacts_reject_update;
  DROP TRIGGER fork_artifacts_reject_delete;

  CREATE TABLE fork_artifacts_v3 (
    run_id TEXT NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN (
      'baby-a-ledger', 'baby-b-ledger', 'channel', 'affect', 'audit',
      'turns', 'intervention'
    )),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    entry_hash TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (run_id, stream, sequence, entry_hash),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id)
  ) STRICT;

  INSERT INTO fork_artifacts_v3 (
    run_id, stream, sequence, entry_hash, canonical_json, detected_at
  )
  SELECT run_id, stream, sequence, entry_hash, canonical_json, detected_at
    FROM fork_artifacts;

  DROP TABLE fork_artifacts;

  ALTER TABLE fork_artifacts_v3 RENAME TO fork_artifacts;

  ${appendOnlyTriggers('fork_artifacts')}

  CREATE INDEX fork_artifacts_run_idx
    ON fork_artifacts(run_id, stream, sequence);
`;

/**
 * Runtime-produced analysis artifacts. Content and descriptor are append-only;
 * `bound_entry_hash` points at the intervention event created in the same
 * transaction, whose Merkle prefix is witness-committed by checkpoints.
 */
const analysisAttachmentSchema = `
  CREATE TABLE analysis_attachments (
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    analysis_version TEXT NOT NULL,
    produced_at TEXT NOT NULL,
    bound_stream TEXT NOT NULL CHECK (bound_stream = 'intervention'),
    bound_entry_hash TEXT NOT NULL UNIQUE,
    descriptor_json TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (run_id, path),
    FOREIGN KEY (run_id) REFERENCES run_metadata(run_id),
    FOREIGN KEY (bound_entry_hash) REFERENCES intervention_log(entry_hash)
  ) STRICT;

  ${appendOnlyTriggers('analysis_attachments')}

  CREATE INDEX analysis_attachments_run_hash_idx
    ON analysis_attachments(run_id, sha256);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-evidence-schema',
    sql: initialSchema,
  },
  {
    version: 2,
    name: 'turn-records-signers-and-fork-artifacts',
    sql: turnRecordAndForkSchema,
  },
  {
    version: 3,
    name: 'fork-artifact-stream-check-and-run-reference',
    sql: forkArtifactConstraintsSchema,
  },
  {
    version: 4,
    name: 'analysis-attachments',
    sql: analysisAttachmentSchema,
  },
];

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

export function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const findMigration = database.prepare<
    [number],
    { name: string; checksum: string }
  >('SELECT name, checksum FROM schema_migrations WHERE version = ?');
  const recordMigration = database.prepare(
    `INSERT INTO schema_migrations (version, name, checksum, applied_at)
     VALUES (?, ?, ?, ?)`,
  );

  for (const migration of migrations) {
    const expectedChecksum = checksum(migration);
    const applied = findMigration.get(migration.version);

    if (applied) {
      if (
        applied.name !== migration.name ||
        applied.checksum !== expectedChecksum
      ) {
        throw new Error(
          `Migration ${migration.version} does not match the applied schema`,
        );
      }
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        expectedChecksum,
        new Date().toISOString(),
      );
    })();
  }
}
