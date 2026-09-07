import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { applyMigrations } from './migrations.js';

export interface EvidenceDatabase {
  database: Database.Database;
  path: string;
  close(): void;
}

/**
 * Opens (creating if needed) the authoritative local evidence store
 * (LEDGER §3): WAL journal mode, `synchronous = FULL` so a killed process can
 * never expose a torn transaction (ALD-011), foreign keys enforced,
 * `recursive_triggers` enabled, and every pending migration applied.
 *
 * `recursive_triggers = ON` is load-bearing, not a tuning knob: every
 * append-only guard in {@link applyMigrations} is a `BEFORE UPDATE` /
 * `BEFORE DELETE` trigger, and SQLite fires the implicit row deletion of the
 * `REPLACE` conflict-resolution algorithm through `BEFORE DELETE` triggers
 * only when recursive triggers are enabled. With the pragma at its default
 * (OFF) an `INSERT OR REPLACE` / `REPLACE INTO` would destroy and rewrite a
 * committed event without raising `append-only table: <table>`, defeating the
 * accident-prevention control LEDGER §3 requires ("Database permissions and
 * triggers should reject UPDATE and DELETE operations on event tables").
 */
export function openEvidenceDatabase(databasePath: string): EvidenceDatabase {
  const resolvedPath =
    databasePath === ':memory:' ? databasePath : resolve(databasePath);

  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new Database(resolvedPath);
  database.pragma('foreign_keys = ON');
  database.pragma('recursive_triggers = ON');
  database.pragma('synchronous = FULL');
  database.pragma('journal_mode = WAL');
  applyMigrations(database);

  return {
    database,
    path: resolvedPath,
    close: () => database.close(),
  };
}
