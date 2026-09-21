import { open, readFile, unlink } from 'node:fs/promises';

import { hashCanonical } from '@ald/hashing';

import type { Lv01StageJournal } from './ledger-value.js';

export interface Lv01JournalLock {
  readonly journalPath: string;
  readonly lockPath: string;
  readonly owner: string;
  release(): Promise<void>;
}

export interface Lv01JournalEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly journal: Lv01StageJournal;
  readonly journalHash: string;
}

function fail(message: string): never { throw new Error(`LV01 journal: ${message}`); }
function eventFor(sequence: number, recordedAt: string, journal: Lv01StageJournal): Lv01JournalEvent {
  return { schemaVersion: 1, sequence, recordedAt, journal, journalHash: hashCanonical('lv01-stage-journal/v1', journal) };
}

/** A lock is never reclaimed from a process identifier: evidence must be reconciled explicitly. */
export async function acquireLv01JournalLock(journalPath: string, owner: string, startedAt: string): Promise<Lv01JournalLock> {
  if (owner.length === 0 || startedAt.length === 0) fail('owner and start time are required');
  const lockPath = `${journalPath}.lock`;
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch { fail(`journal lock already exists at ${lockPath}; inspect evidence before retrying`); }
  await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, owner, startedAt })}\n`);
  let released = false;
  return {
    journalPath, lockPath, owner,
    async release() {
      if (released) fail('journal lock was released twice');
      released = true;
      await handle.close();
      await unlink(lockPath);
    },
  };
}

export async function initializeLv01Journal(lock: Lv01JournalLock, journal: Lv01StageJournal, recordedAt: string): Promise<Lv01JournalEvent> {
  const event = eventFor(1, recordedAt, journal);
  let handle;
  try { handle = await open(lock.journalPath, 'wx', 0o600); }
  catch { fail('journal already exists and is immutable at initialization'); }
  await handle.writeFile(`${JSON.stringify(event)}\n`);
  await handle.close();
  return event;
}

export async function readLv01Journal(journalPath: string): Promise<readonly Lv01JournalEvent[]> {
  let events: Lv01JournalEvent[];
  try {
    events = (await readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Lv01JournalEvent);
  } catch { fail(`journal cannot be read at ${journalPath}`); }
  if (events.length === 0) fail('journal has no events');
  for (const [index, event] of events.entries()) {
    if (event.schemaVersion !== 1 || event.sequence !== index + 1 ||
        event.journalHash !== hashCanonical('lv01-stage-journal/v1', event.journal)) {
      fail(`journal event ${index + 1} is malformed or tampered`);
    }
    if (index > 0 && events[index - 1]?.journal.terminal !== 'open') {
      fail('journal changes after terminal accounting');
    }
  }
  return events;
}

export async function appendLv01Journal(lock: Lv01JournalLock, journal: Lv01StageJournal, recordedAt: string): Promise<Lv01JournalEvent> {
  const events = await readLv01Journal(lock.journalPath);
  const previous = events.at(-1)!;
  if (previous.journal.terminal !== 'open') fail('journal is terminal');
  const event = eventFor(previous.sequence + 1, recordedAt, journal);
  const handle = await open(lock.journalPath, 'a', 0o600);
  await handle.writeFile(`${JSON.stringify(event)}\n`);
  await handle.close();
  return event;
}

/** Absence of a final journal event is unresolved, never a claim that work is still running. */
export function lv01JournalExecutionState(events: readonly Lv01JournalEvent[]): 'open' | 'completed' | 'failed' | 'aborted' | 'unresolved' {
  if (events.length === 0) return 'unresolved';
  const terminal = events.at(-1)?.journal.terminal;
  return terminal === undefined || terminal === 'open' ? 'unresolved' : terminal;
}
