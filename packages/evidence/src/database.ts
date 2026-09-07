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
 * never expose a torn transaction (ALD-011), foreign keys enforced, and every
 * pending migration applied.
 */
export function openEvidenceDatabase(databasePath: string): EvidenceDatabase {
  const resolvedPath =
    databasePath === ':memory:' ? databasePath : resolve(databasePath);

  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new Database(resolvedPath);
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = FULL');
  database.pragma('journal_mode = WAL');
  applyMigrations(database);

  return {
    database,
    path: resolvedPath,
    close: () => database.close(),
  };
}
