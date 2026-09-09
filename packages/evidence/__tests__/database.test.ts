import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { migrations, openEvidenceDatabase } from '../src/index.js';

// The applied schema is checksum-verified (see `applyMigrations`), so the SQL
// of a released migration may never change. Pinning the digest here turns an
// accidental edit into a failing test instead of a store that refuses to open.
const APPLIED_MIGRATION_CHECKSUMS: Record<number, string> = {
  1: '31241366310597875775715ac638810eccd586dd179f0d350b641bf0716290d9',
  2: '3ef7eb58ac9954d2c1ba29b2e0cfd85b8b10ca5b64918eb5420b746288dfed50',
  3: 'f2f2893d29e954fa412bdd1dcd1a3ab8c59975725dc06306b150548e10bf50e3',
};

const RUN_ID = 'run-append-only';
const RECORDED_AT = '1970-01-01T00:00:00.000Z';
const TRANSACTION_HASH = `0x${'a'.repeat(64)}`;

function hash(hexDigit: string): string {
  return `sha256:${hexDigit.repeat(64)}`;
}

/**
 * One seed row per append-only table (LEDGER §3), in foreign-key order, with
 * the non-key column a `REPLACE` would silently rewrite.
 */
interface ProtectedRow {
  table: string;
  columns: Record<string, string | number>;
  mutated: string;
  /** Replacement value; must satisfy the column CHECK so only the trigger fires. */
  mutatedValue?: string;
}

const PROTECTED_ROWS: readonly ProtectedRow[] = [
  {
    table: 'run_metadata',
    columns: {
      run_id: RUN_ID,
      created_at: RECORDED_AT,
      deployment_mode: 'prototype',
      configuration_hash: hash('a'),
      configuration_json: '{}',
    },
    mutated: 'deployment_mode',
    mutatedValue: 'research-grade',
  },
  {
    table: 'ledger_events',
    columns: {
      run_id: RUN_ID,
      baby_id: 'A',
      sequence: 1,
      turn: 1,
      event_type: 'intention.recorded',
      content_schema: 'agent-native-ledger',
      previous_entry_hash: hash('0'),
      entry_hash: hash('1'),
      writer_key_id: 'baby-a-ledger-v1',
      writer_signature: 'ed25519:AA==',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'channel_events',
    columns: {
      run_id: RUN_ID,
      sequence: 1,
      turn: 1,
      logical_sender: 'baby-a',
      origin: 'baby',
      communication_condition: 'normal',
      public_artifact_hash: hash('2'),
      previous_channel_hash: hash('0'),
      validation_result: 'accepted',
      entry_hash: hash('3'),
      writer_key_id: 'channel-v1',
      writer_signature: 'ed25519:AA==',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'affect_events',
    columns: {
      run_id: RUN_ID,
      sequence: 1,
      turn: 1,
      sender: 'baby-a',
      display_id: 'A1',
      affect_mode: 'declared',
      previous_entry_hash: hash('0'),
      entry_hash: hash('4'),
      writer_key_id: 'affect-v1',
      writer_signature: 'ed25519:AA==',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'audit_ledger_entries',
    columns: {
      run_id: RUN_ID,
      sequence: 1,
      baby_id: 'A',
      source: 'generated-analysis',
      source_entry_hash: hash('1'),
      previous_entry_hash: hash('0'),
      entry_hash: hash('5'),
      writer_key_id: 'audit-v1',
      writer_signature: 'ed25519:AA==',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'turn_records',
    columns: {
      run_id: RUN_ID,
      sequence: 1,
      turn: 1,
      phase: 'running',
      previous_entry_hash: hash('0'),
      entry_hash: hash('6'),
      writer_key_id: 'nursery-witness-v1',
      writer_signature: 'ed25519:AA==',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'intervention_log',
    columns: {
      run_id: RUN_ID,
      sequence: 1,
      event_type: 'annotate',
      actor_id: 'researcher-1',
      reason_code: 'note',
      previous_entry_hash: hash('0'),
      entry_hash: hash('7'),
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'checkpoint_manifests',
    columns: {
      run_id: RUN_ID,
      checkpoint_sequence: 0,
      checkpoint_hash: hash('8'),
      previous_checkpoint_hash: hash('0'),
      witness_key_id: 'nursery-witness-v1',
      witness_signature: 'ed25519:AA==',
      created_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'anchor_receipts',
    columns: {
      run_id: RUN_ID,
      checkpoint_hash: hash('8'),
      chain_id: 84_532,
      transaction_hash: TRANSACTION_HASH,
      block_number: 1,
      status: 'submitted',
      finality_policy: '1-confirmation',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'experiment_records',
    columns: {
      run_id: RUN_ID,
      record_version: 1,
      experiment_id: 'E00',
      disposition: 'valid',
      checkpoint_manifest_ref: hash('8'),
      anchor_tx_ref: TRANSACTION_HASH,
      verifier_report_ref: 'verifier-report-1',
      recorded_at: RECORDED_AT,
      canonical_json: '{}',
    },
    mutated: 'canonical_json',
  },
  {
    table: 'run_signers',
    columns: {
      run_id: RUN_ID,
      domain: 'witness',
      key_id: 'nursery-witness-v1',
      public_key: 'ed25519-pub:AA==',
      recorded_at: RECORDED_AT,
    },
    mutated: 'public_key',
  },
  {
    table: 'fork_artifacts',
    columns: {
      run_id: RUN_ID,
      stream: 'channel',
      sequence: 1,
      entry_hash: hash('9'),
      canonical_json: '{}',
      detected_at: RECORDED_AT,
    },
    mutated: 'canonical_json',
  },
];

function insertSql(row: ProtectedRow, verb: string): string {
  const names = Object.keys(row.columns);
  return `${verb} INTO ${row.table} (${names.join(', ')})
          VALUES (${names.map((name) => `@${name}`).join(', ')})`;
}

function seedProtectedRows(database: Database.Database): void {
  for (const row of PROTECTED_ROWS) {
    database.prepare(insertSql(row, 'INSERT')).run(row.columns);
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ald-evidence-'));
  temporaryDirectories.push(directory);
  return join(directory, 'evidence.sqlite');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('evidence database migrations', () => {
  it('creates every required table in WAL mode', async () => {
    const evidence = openEvidenceDatabase(await temporaryDatabasePath());

    const journalMode = evidence.database.pragma('journal_mode', {
      simple: true,
    });
    const tables = evidence.database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(journalMode).toBe('wal');
    expect(tables).toEqual([
      'affect_events',
      'analysis_attachments',
      'anchor_receipts',
      'audit_ledger_entries',
      'channel_events',
      'checkpoint_manifests',
      'experiment_records',
      'fork_artifacts',
      'intervention_log',
      'ledger_events',
      'run_metadata',
      'run_signers',
      'schema_migrations',
      'turn_records',
    ]);

    evidence.close();
  });

  it('applies migrations idempotently', async () => {
    const path = await temporaryDatabasePath();
    const first = openEvidenceDatabase(path);
    first.close();

    const second = openEvidenceDatabase(path);
    const migrations = second.database
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all();

    expect(migrations).toEqual([
      { version: 1, name: 'initial-evidence-schema' },
      { version: 2, name: 'turn-records-signers-and-fork-artifacts' },
      { version: 3, name: 'fork-artifact-stream-check-and-run-reference' },
      { version: 4, name: 'analysis-attachments' },
    ]);

    second.close();
  });

  it('rejects updates and deletes from append-only tables', async () => {
    const evidence = openEvidenceDatabase(await temporaryDatabasePath());
    const run = {
      runId: 'run-append-only',
      createdAt: new Date(0).toISOString(),
      deploymentMode: 'prototype',
      configurationHash: `sha256:${'a'.repeat(64)}`,
      configurationJson: '{}',
    };

    evidence.database
      .prepare(
        `INSERT INTO run_metadata (
           run_id, created_at, deployment_mode, configuration_hash, configuration_json
         ) VALUES (
           @runId, @createdAt, @deploymentMode, @configurationHash, @configurationJson
         )`,
      )
      .run(run);

    expect(() =>
      evidence.database
        .prepare(
          `UPDATE run_metadata
           SET deployment_mode = 'research-grade'
           WHERE run_id = ?`,
        )
        .run(run.runId),
    ).toThrow('append-only table: run_metadata');

    expect(() =>
      evidence.database
        .prepare('DELETE FROM run_metadata WHERE run_id = ?')
        .run(run.runId),
    ).toThrow('append-only table: run_metadata');

    expect(
      evidence.database
        .prepare('SELECT deployment_mode FROM run_metadata WHERE run_id = ?')
        .get(run.runId),
    ).toEqual({ deployment_mode: 'prototype' });

    evidence.close();
  });

  it('never changes the SQL of an already applied migration', () => {
    for (const migration of migrations) {
      const expected = APPLIED_MIGRATION_CHECKSUMS[migration.version];
      if (expected === undefined) {
        continue;
      }
      expect(createHash('sha256').update(migration.sql).digest('hex')).toBe(
        expected,
      );
    }
  });

  it('rejects updates and deletes from the migration 2 tables', async () => {
    const evidence = openEvidenceDatabase(await temporaryDatabasePath());
    seedProtectedRows(evidence.database);

    expect(() =>
      evidence.database
        .prepare("UPDATE fork_artifacts SET entry_hash = 'sha256:bb'")
        .run(),
    ).toThrow('append-only table: fork_artifacts');
    expect(() =>
      evidence.database.prepare('DELETE FROM fork_artifacts').run(),
    ).toThrow('append-only table: fork_artifacts');

    for (const table of ['turn_records', 'run_signers']) {
      const triggers = evidence.database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
        )
        .all(table)
        .map((row) => (row as { name: string }).name);
      expect(triggers).toEqual([
        `${table}_reject_delete`,
        `${table}_reject_update`,
      ]);
    }

    evidence.close();
  });
  it('enables recursive triggers so REPLACE cannot bypass the append-only guards', async () => {
    // LEDGER §3: the guard triggers are BEFORE UPDATE / BEFORE DELETE, and
    // SQLite routes the implicit row deletion of the REPLACE conflict
    // algorithm through BEFORE DELETE triggers only when recursive triggers
    // are on. Without the pragma `INSERT OR REPLACE` destroys and rewrites a
    // committed event with no error at all.
    const evidence = openEvidenceDatabase(await temporaryDatabasePath());

    expect(
      evidence.database.pragma('recursive_triggers', { simple: true }),
    ).toBe(1);

    seedProtectedRows(evidence.database);

    for (const row of PROTECTED_ROWS) {
      const replacement = {
        ...row.columns,
        [row.mutated]: row.mutatedValue ?? '{"tampered":true}',
      };
      expect(() =>
        evidence.database
          .prepare(insertSql(row, 'INSERT OR REPLACE'))
          .run(replacement),
      ).toThrow(`append-only table: ${row.table}`);
      expect(() =>
        evidence.database.prepare(insertSql(row, 'REPLACE')).run(replacement),
      ).toThrow(`append-only table: ${row.table}`);

      const stored = evidence.database
        .prepare(`SELECT ${row.mutated} AS value FROM ${row.table}`)
        .all()
        .map((stored) => (stored as { value: unknown }).value);
      expect(stored).toEqual([row.columns[row.mutated]]);
    }

    evidence.close();
  });

  it('constrains fork_artifacts to known streams and registered runs', async () => {
    // Migration 3: `fork_artifacts` is read back on the recovery path
    // (LEDGER §15), so an out-of-domain stream name or an artifact for a run
    // that was never registered is rejected at the schema, not carried into
    // `recover()`.
    const evidence = openEvidenceDatabase(await temporaryDatabasePath());
    seedProtectedRows(evidence.database);

    const insert = evidence.database.prepare(
      `INSERT INTO fork_artifacts (
         run_id, stream, sequence, entry_hash, canonical_json, detected_at
       ) VALUES (@run_id, @stream, @sequence, @entry_hash, @canonical_json, @detected_at)`,
    );
    const artifact = {
      run_id: RUN_ID,
      stream: 'baby-a-ledger',
      sequence: 2,
      entry_hash: hash('b'),
      canonical_json: '{}',
      detected_at: RECORDED_AT,
    };

    expect(() => insert.run(artifact)).not.toThrow();
    expect(() =>
      insert.run({ ...artifact, stream: 'constructor', entry_hash: hash('c') }),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      insert.run({ ...artifact, stream: 'toString', entry_hash: hash('d') }),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      insert.run({ ...artifact, run_id: 'run-never-registered' }),
    ).toThrow('FOREIGN KEY constraint failed');

    expect(
      evidence.database
        .prepare('SELECT COUNT(*) AS count FROM fork_artifacts')
        .get(),
    ).toEqual({ count: 2 });

    evidence.close();
  });
});
