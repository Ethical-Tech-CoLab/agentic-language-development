import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrations, openEvidenceDatabase } from '../src/index.js';

// The applied schema is checksum-verified (see `applyMigrations`), so the SQL
// of a released migration may never change. Pinning the digest here turns an
// accidental edit into a failing test instead of a store that refuses to open.
const APPLIED_MIGRATION_CHECKSUMS: Record<number, string> = {
  1: '31241366310597875775715ac638810eccd586dd179f0d350b641bf0716290d9',
};

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
    evidence.database
      .prepare(
        `INSERT INTO fork_artifacts (
           run_id, stream, sequence, entry_hash, canonical_json, detected_at
         ) VALUES ('run-1', 'channel', 1, 'sha256:aa', '{}', '1970-01-01T00:00:00.000Z')`,
      )
      .run();

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
});
