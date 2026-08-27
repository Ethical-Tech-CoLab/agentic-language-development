import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openEvidenceDatabase } from '../src/index.js';

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
      'intervention_log',
      'ledger_events',
      'run_metadata',
      'schema_migrations',
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
});
