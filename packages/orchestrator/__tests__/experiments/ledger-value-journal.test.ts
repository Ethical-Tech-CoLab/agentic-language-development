import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireLv01JournalLock,
  appendLv01Journal,
  createLv01StageJournal,
  finalizeLv01Stage,
  initializeLv01Journal,
  lv01JournalExecutionState,
  readLv01Journal,
  recordLv01SlotParent,
  transitionLv01Slot,
} from '../../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('LV01 append-only stage journal', () => {
  it('retains ordered transitions and treats an open journal as unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ald-lv01-journal-'));
    roots.push(root);
    const path = join(root, 'journal.jsonl');
    const lock = await acquireLv01JournalLock(path, 'test-owner', '2026-09-21T00:00:00.000Z');
    let journal = createLv01StageJournal('development', 1, 1);
    await initializeLv01Journal(lock, journal, '2026-09-21T00:00:01.000Z');
    journal = transitionLv01Slot(journal, 1, 'running');
    await appendLv01Journal(lock, journal, '2026-09-21T00:00:02.000Z');
    expect(lv01JournalExecutionState(await readLv01Journal(path))).toBe('unresolved');
    journal = transitionLv01Slot(journal, 1, 'valid');
    journal = finalizeLv01Stage(journal);
    await appendLv01Journal(lock, journal, '2026-09-21T00:00:03.000Z');
    expect(lv01JournalExecutionState(await readLv01Journal(path))).toBe('completed');
    await lock.release();
  });

  it('links a valid slot to a contained parent ref and rejects escapes', () => {
    let journal = createLv01StageJournal('development', 1, 1);
    journal = transitionLv01Slot(journal, 1, 'running');
    expect(() => recordLv01SlotParent(journal, 1, 'parents/slot-0001')).toThrow(/only a valid slot/u);
    journal = transitionLv01Slot(journal, 1, 'valid');
    expect(() => recordLv01SlotParent(journal, 1, '../escape')).toThrow(/contained relative path/u);
    expect(() => recordLv01SlotParent(journal, 1, '/absolute')).toThrow(/contained relative path/u);
    expect(() => recordLv01SlotParent(journal, 1, '')).toThrow(/contained relative path/u);
    journal = recordLv01SlotParent(journal, 1, 'parents/slot-0001');
    expect(journal.slots.find((slot) => slot.index === 1)?.parentBundleRef).toBe('parents/slot-0001');
  });

  it('fails closed when a journal lock already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ald-lv01-journal-'));
    roots.push(root);
    const path = join(root, 'journal.jsonl');
    const lock = await acquireLv01JournalLock(path, 'first', '2026-09-21T00:00:00.000Z');
    await expect(acquireLv01JournalLock(path, 'second', '2026-09-21T00:00:01.000Z')).rejects.toThrow(/inspect evidence/u);
    await lock.release();
  });
});
