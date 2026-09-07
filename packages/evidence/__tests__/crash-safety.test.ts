/**
 * ALD-011: WAL durability and crash safety.
 *
 * Each trial spawns a child process that commits turns through
 * `SqliteEvidenceWriter` as fast as it can, SIGKILLs it at a random point,
 * then reopens the store and proves the recovered state is a committed prefix:
 * `recover()` reports no violation, and for every turn the sender intention
 * event and its channel event are either both present or both absent
 * (SPEC §8.2, LEDGER §3, §15).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupTemporaryDirectories,
  createWriter,
  temporaryDatabasePath,
} from './fixtures/support.js';

afterEach(cleanupTemporaryDirectories);

const RUN_ID = 'run-test-001';
const TRIALS = 20;
const CHILD = fileURLToPath(new URL('./fixtures/crash-writer.ts', import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function crashAfterRandomDelay(databasePath: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, databasePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const errors: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));

  const ready = new Promise<void>((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.includes('ready')) {
        resolve();
      }
    });
    child.once('exit', () =>
      reject(
        new Error(
          `crash-writer exited before it was ready: ${Buffer.concat(errors).toString('utf8')}`,
        ),
      ),
    );
  });

  await ready;
  await delay(2 + Math.floor(Math.random() * 30));
  child.kill('SIGKILL');
  await once(child, 'exit');
}

describe('WAL crash safety', () => {
  it(`recovers a committed prefix after ${TRIALS} randomized kills`, async () => {
    const observedTurns: number[] = [];

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const databasePath = await temporaryDatabasePath();
      await crashAfterRandomDelay(databasePath);

      const context = await createWriter({ path: databasePath, register: false });
      try {
        const report = await context.writer.recover(RUN_ID);
        expect(report.chainViolations).toEqual([]);
        expect(report.forks).toEqual([]);
        expect(report.ok).toBe(true);

        const ledger = context.writer
          .readEvents(RUN_ID, 'baby-a-ledger')
          .map((event) => JSON.parse(event.canonicalJson) as {
            turn: number;
            eventType: string;
            sequence: number;
          });
        const channel = context.writer
          .readEvents(RUN_ID, 'channel')
          .map((event) => JSON.parse(event.canonicalJson) as {
            turn: number;
            sequence: number;
            senderLedgerSequence?: number;
            senderEntryHash?: string;
          });

        // Both-or-neither: one commitTurn writes exactly one intention event
        // and one channel event, in one transaction.
        const intentionTurns = ledger
          .filter((event) => event.eventType === 'intention.recorded')
          .map((event) => event.turn);
        expect(intentionTurns).toEqual(ledger.map((event) => event.turn));
        expect(channel.map((event) => event.turn)).toEqual(intentionTurns);

        // Sequences are dense and consistent across the two chains.
        expect(ledger.map((event) => event.sequence)).toEqual(
          ledger.map((_, index) => index + 1),
        );
        expect(channel.map((event) => event.sequence)).toEqual(
          channel.map((_, index) => index + 1),
        );
        expect(
          context.writer.chainHead(RUN_ID, 'baby-a-ledger').size,
        ).toBe(context.writer.chainHead(RUN_ID, 'channel').size);

        // Every channel event still points at its sender ledger event.
        const byLedgerSequence = new Map(
          context.writer
            .readEvents(RUN_ID, 'baby-a-ledger')
            .map((event) => [event.sequence, event.entryHash]),
        );
        for (const event of channel) {
          expect(byLedgerSequence.get(event.senderLedgerSequence ?? -1)).toBe(
            event.senderEntryHash,
          );
        }

        observedTurns.push(ledger.length);
      } finally {
        context.close();
      }
    }

    // The harness must actually have committed work before each kill.
    expect(observedTurns).toHaveLength(TRIALS);
    expect(Math.min(...observedTurns)).toBeGreaterThan(0);
  }, 40_000);
});
