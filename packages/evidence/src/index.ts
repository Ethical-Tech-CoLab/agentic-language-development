import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { applyMigrations } from './migrations.js';

export interface EvidenceDatabase {
  database: Database.Database;
  path: string;
  close(): void;
}

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
