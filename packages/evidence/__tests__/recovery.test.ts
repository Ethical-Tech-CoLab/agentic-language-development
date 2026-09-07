import { canonicalJson, domainHash, hashCanonical } from '@ald/hashing';
import {
  EVENT_STREAMS,
  GENESIS_HASH,
  HASH_DOMAINS,
  type CheckpointManifest,
  type EventStream,
  type TreeReference,
} from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { ForkDetectedError, IntegrityBlockedError, UnknownRunError } from '../src/errors.js';
import {
  cleanupTemporaryDirectories,
  createWriter,
  hash,
  intentionDraft,
  proposal,
  StepClock,
} from './fixtures/support.js';
import type { TestWriter } from './fixtures/support.js';

afterEach(cleanupTemporaryDirectories);

const RUN_ID = 'run-test-001';

/** The tree reference a truthful checkpoint would commit for a stream. */
function headTree(context: TestWriter, stream: EventStream): TreeReference {
  const head = context.writer.chainHead(RUN_ID, stream);
  return {
    treeSize: head.size,
    merkleRoot: hash('1') as TreeReference['merkleRoot'],
    lastEntryHash: head.lastEntryHash,
  };
}

/**
 * Inserts a well-formed, witness-signed checkpoint 0 (LEDGER §8) committing
 * the current heads of the three mandatory trees plus any auxiliary trees
 * asked for, so recovery has real checkpoint hashes to verify against.
 */
async function insertHeadCheckpoint(
  context: TestWriter,
  overrides: {
    babyA?: TreeReference;
    auxiliaryTrees?: Record<string, TreeReference>;
  } = {},
): Promise<CheckpointManifest> {
  const unsigned = {
    version: 1 as const,
    runIdHash: domainHash(HASH_DOMAINS.runId, RUN_ID),
    checkpointSequence: 0,
    previousCheckpointHash: GENESIS_HASH,
    babyA: overrides.babyA ?? headTree(context, 'baby-a-ledger'),
    babyB: headTree(context, 'baby-b-ledger'),
    channel: headTree(context, 'channel'),
    auxiliaryTrees: overrides.auxiliaryTrees ?? {},
    runConfigurationHash: hash('3'),
    promptBundleHash: hash('4'),
    softwareCommit: 'test-commit',
    createdAt: new Date(0).toISOString(),
    witnessKeyId: 'nursery-witness-v1',
    reason: 'event-interval' as const,
  };
  const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
  const manifest = {
    ...unsigned,
    checkpointHash,
    witnessSignature: await context.signers.signer('witness').sign(checkpointHash),
  } as CheckpointManifest;
  context.writer.insertCheckpointManifest(manifest);
  return manifest;
}

/**
 * Simulates the LEDGER §3 privileged operator / SPEC §14.4 restore that lost
 * the tail: the append-only trigger makes this impossible for application
 * code, so the test drops it exactly as the tamper tests above do.
 */
function dropTail(context: TestWriter, table: string, sequence: number): void {
  context.database.exec(`DROP TRIGGER ${table}_reject_delete`);
  context.database
    .prepare(`DELETE FROM ${table} WHERE run_id = ? AND sequence = ?`)
    .run(RUN_ID, sequence);
}

function turnRequest(turn: number) {
  return {
    runId: RUN_ID,
    turn,
    sender: 'baby-a' as const,
    recipient: 'baby-b' as const,
    carrier: 'fixed-token' as const,
    communicationCondition: 'normal' as const,
    proposal,
    intentionDraft: intentionDraft(),
    deliveredArtifact: proposal.publicArtifact,
  };
}

describe('recover', () => {
  it('reports a clean run with the correct heads', async () => {
    const context = await createWriter();
    const first = await context.writer.commitTurn(turnRequest(1));
    const second = await context.writer.commitTurn(turnRequest(2));
    await context.writer.appendInterventionEvent({
      runId: RUN_ID,
      eventType: 'annotate',
      actorId: 'researcher-1',
      reasonCode: 'note',
    });

    const report = await context.writer.recover(RUN_ID);

    expect(report.ok).toBe(true);
    expect(report.chainViolations).toEqual([]);
    expect(report.forks).toEqual([]);
    expect(report.heads.map((head) => head.stream)).toEqual([...EVENT_STREAMS]);
    const heads = new Map(report.heads.map((head) => [head.stream, head]));
    expect(heads.get('baby-a-ledger')).toEqual({
      stream: 'baby-a-ledger',
      size: 2,
      lastEntryHash: second.senderLedgerEvent.entryHash,
    });
    expect(heads.get('channel')?.size).toBe(2);
    expect(heads.get('baby-b-ledger')).toEqual({
      stream: 'baby-b-ledger',
      size: 0,
      lastEntryHash: GENESIS_HASH,
    });
    expect(heads.get('intervention')?.size).toBe(1);
    expect(first.senderLedgerEvent.entryHash).not.toBe(
      second.senderLedgerEvent.entryHash,
    );

    context.close();
  });

  it('throws for an unregistered run', async () => {
    const context = await createWriter();
    await expect(context.writer.recover('run-missing')).rejects.toThrow(
      UnknownRunError,
    );
    context.close();
  });

  it('detects a tampered canonical row, blocks writes, and clears only after review', async () => {
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));

    // The append-only trigger makes this impossible for application code; a
    // privileged operator with direct file access is the threat model here
    // (LEDGER §3), so the test drops the trigger to simulate it.
    context.database.exec('DROP TRIGGER ledger_events_reject_update');
    const stored = context.writer.readEvents(RUN_ID, 'baby-a-ledger')[0];
    const tampered = JSON.parse(stored?.canonicalJson ?? '{}') as {
      content: Record<string, unknown>;
    };
    tampered.content = { ...tampered.content, artifactRef: 'tampered-artifact' };
    context.database
      .prepare('UPDATE ledger_events SET canonical_json = ? WHERE entry_hash = ?')
      .run(canonicalJson(tampered), stored?.entryHash);

    const report = await context.writer.recover(RUN_ID);
    expect(report.ok).toBe(false);
    expect(report.chainViolations).toHaveLength(1);
    expect(report.chainViolations[0]).toContain('entry hash mismatch');
    expect(context.writer.integrityFindings(RUN_ID)).toHaveLength(1);

    await expect(context.writer.commitTurn(turnRequest(2))).rejects.toThrow(
      IntegrityBlockedError,
    );
    await expect(
      context.writer.appendInterventionEvent({
        runId: RUN_ID,
        eventType: 'annotate',
        actorId: 'researcher-1',
        reasonCode: 'note',
      }),
    ).rejects.toThrow(IntegrityBlockedError);

    const decision = await context.writer.acknowledgeIntegrityReview(
      RUN_ID,
      'integrity-reviewer-1',
    );
    expect(decision.eventType).toBe('governance-decision');
    expect(decision.actorId).toBe('integrity-reviewer-1');
    expect(decision.details.acknowledgedFindings).toHaveLength(1);
    expect(context.writer.integrityFindings(RUN_ID)).toEqual([]);

    const resumed = await context.writer.commitTurn(turnRequest(2));
    expect(resumed.senderLedgerEvent.sequence).toBe(2);

    context.close();
  });

  it('detects a broken previous link and an invalid writer signature', async () => {
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));
    await context.writer.commitTurn(turnRequest(2));
    context.database.exec('DROP TRIGGER ledger_events_reject_update');

    const [, second] = context.writer.readEvents(RUN_ID, 'baby-a-ledger');
    context.database
      .prepare('UPDATE ledger_events SET previous_entry_hash = ? WHERE entry_hash = ?')
      .run(GENESIS_HASH, second?.entryHash);

    const channel = context.writer.readEvents(RUN_ID, 'channel')[0];
    const forgedSignature = `ed25519:${Buffer.alloc(64, 7).toString('base64')}`;
    const forged = {
      ...(JSON.parse(channel?.canonicalJson ?? '{}') as Record<string, unknown>),
      writerSignature: forgedSignature,
    };
    context.database.exec('DROP TRIGGER channel_events_reject_update');
    context.database
      .prepare('UPDATE channel_events SET canonical_json = ? WHERE entry_hash = ?')
      .run(canonicalJson(forged), channel?.entryHash);

    const report = await context.writer.recover(RUN_ID);

    expect(report.ok).toBe(false);
    expect(
      report.chainViolations.some((violation) =>
        violation.includes('does not chain to'),
      ),
    ).toBe(true);
    expect(
      report.chainViolations.some((violation) =>
        violation.includes('writer signature does not verify'),
      ),
    ).toBe(true);

    context.close();
  });

  it('preserves both artifacts and blocks the run when two writers fork a sequence', async () => {
    const first = await createWriter({ clock: new StepClock(Date.UTC(2026, 0, 1)) });
    const second = await createWriter({
      path: first.path,
      register: false,
      signers: first.signers,
      clock: new StepClock(Date.UTC(2026, 5, 1)),
    });

    const results = await Promise.allSettled([
      first.writer.commitTurn(turnRequest(1)),
      second.writer.commitTurn(turnRequest(1)),
    ]);

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ForkDetectedError);
    expect((reason as ForkDetectedError).stream).toBe('baby-a-ledger');
    expect((reason as ForkDetectedError).sequence).toBe(1);
    expect((reason as ForkDetectedError).entryHashes).toHaveLength(2);

    const artifacts = first.writer.readForkArtifacts(RUN_ID);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.stream)).toEqual([
      'baby-a-ledger',
      'baby-a-ledger',
    ]);
    expect(new Set(artifacts.map((artifact) => artifact.entryHash))).toEqual(
      new Set((reason as ForkDetectedError).entryHashes),
    );
    // Only one of the two competing events was committed.
    expect(first.writer.readEvents(RUN_ID, 'baby-a-ledger')).toHaveLength(1);
    expect(first.writer.readEvents(RUN_ID, 'channel')).toHaveLength(1);

    // The forking writer refuses further writes for that run.
    await expect(second.writer.commitTurn(turnRequest(2))).rejects.toThrow(
      IntegrityBlockedError,
    );

    // recover() surfaces the preserved fork for any writer on the store.
    const report = await first.writer.recover(RUN_ID);
    expect(report.ok).toBe(false);
    expect(report.forks).toHaveLength(1);
    expect(report.forks[0]?.stream).toBe('baby-a-ledger');
    expect(report.forks[0]?.entryHashes).toHaveLength(2);
    expect(report.chainViolations).toEqual([]);
    await expect(first.writer.commitTurn(turnRequest(2))).rejects.toThrow(
      IntegrityBlockedError,
    );

    second.close();
    first.close();
  });
  it('blocks a run whose committed prefix is shorter than its last checkpoint', async () => {
    // LEDGER §15: "load the last valid entry **and checkpoint hashes**;
    // verify the committed prefix before accepting new writes; ... never
    // truncate or reuse a sequence number". A lost tail is invisible to a
    // walk of the surviving rows — they still chain and verify perfectly —
    // so only the checkpoint can see it.
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));
    await context.writer.commitTurn(turnRequest(2));
    const third = await context.writer.commitTurn(turnRequest(3));
    await insertHeadCheckpoint(context);

    const clean = await context.writer.recover(RUN_ID);
    expect(clean.ok).toBe(true);

    dropTail(context, 'ledger_events', 3);
    dropTail(context, 'channel_events', 3);

    const report = await context.writer.recover(RUN_ID);

    expect(report.ok).toBe(false);
    expect(report.forks).toEqual([]);
    expect(report.heads.map((head) => head.stream)).toEqual([...EVENT_STREAMS]);
    expect(
      report.chainViolations.some(
        (violation) =>
          violation.includes('checkpoint #0') &&
          violation.includes('babyA commits treeSize 3') &&
          violation.includes('baby-a-ledger now holds 2 entries'),
      ),
    ).toBe(true);
    expect(
      report.chainViolations.some(
        (violation) =>
          violation.includes('channel commits treeSize 3') &&
          violation.includes('channel now holds 2 entries'),
      ),
    ).toBe(true);
    expect(context.writer.integrityFindings(RUN_ID)).not.toEqual([]);

    // The checkpointed sequence 3 can never be handed out a second time.
    await expect(context.writer.commitTurn(turnRequest(4))).rejects.toThrow(
      IntegrityBlockedError,
    );
    expect(context.writer.readEvents(RUN_ID, 'baby-a-ledger')).toHaveLength(2);
    expect(third.senderLedgerEvent.sequence).toBe(3);

    context.close();
  });

  it('blocks a run whose checkpointed entry hash no longer matches the stored entry', async () => {
    // SPEC §14.4: a snapshot restore that brings back a different tail of the
    // same length leaves every link intact, so the equal-size case has to be
    // caught by comparing the entry at `treeSize` with the committed
    // `lastEntryHash`.
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));
    await context.writer.commitTurn(turnRequest(2));
    const head = context.writer.chainHead(RUN_ID, 'baby-a-ledger');
    await insertHeadCheckpoint(context, {
      babyA: {
        treeSize: head.size,
        merkleRoot: hash('1') as TreeReference['merkleRoot'],
        lastEntryHash: hash('e') as TreeReference['lastEntryHash'],
      },
    });

    const report = await context.writer.recover(RUN_ID);

    expect(report.ok).toBe(false);
    expect(
      report.chainViolations.some(
        (violation) =>
          violation.includes(`babyA commits lastEntryHash ${hash('e')}`) &&
          violation.includes('baby-a-ledger#2') &&
          violation.includes(head.lastEntryHash),
      ),
    ).toBe(true);

    context.close();
  });

  it('verifies auxiliary trees and reports an auxiliary tree it cannot map', async () => {
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));
    await context.writer.appendInterventionEvent({
      runId: RUN_ID,
      eventType: 'annotate',
      actorId: 'researcher-1',
      reasonCode: 'note',
    });
    await insertHeadCheckpoint(context, {
      auxiliaryTrees: {
        turns: {
          treeSize: 1,
          merkleRoot: hash('1') as TreeReference['merkleRoot'],
          lastEntryHash: hash('f') as TreeReference['lastEntryHash'],
        },
        nonsense: {
          treeSize: 1,
          merkleRoot: hash('1') as TreeReference['merkleRoot'],
          lastEntryHash: hash('f') as TreeReference['lastEntryHash'],
        },
      },
    });

    const report = await context.writer.recover(RUN_ID);

    expect(report.ok).toBe(false);
    // `turns` is committed at size 1 but no turn record was ever appended.
    expect(
      report.chainViolations.some(
        (violation) =>
          violation.includes('turns commits treeSize 1') &&
          violation.includes('turns now holds 0 entries'),
      ),
    ).toBe(true);
    expect(
      report.chainViolations.some((violation) =>
        violation.includes('commits unknown auxiliary tree nonsense'),
      ),
    ).toBe(true);

    context.close();
  });

  it('reports a fork artifact naming an unknown stream instead of throwing', async () => {
    // `'constructor' in STREAM_TABLES` is true for any object literal, so the
    // old `in` guard let a prototype key through and `recover()` raised
    // `no such table: undefined`. Recovery reports malformed input, never
    // raises on it (LEDGER §15).
    const context = await createWriter();
    await context.writer.commitTurn(turnRequest(1));

    // Migration 3 constrains `stream`, so the poison row needs the same
    // privileged file access the tamper tests above assume.
    context.database.exec(`
      DROP TRIGGER fork_artifacts_reject_update;
      DROP TRIGGER fork_artifacts_reject_delete;
      ALTER TABLE fork_artifacts RENAME TO fork_artifacts_constrained;
      CREATE TABLE fork_artifacts (
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        PRIMARY KEY (run_id, stream, sequence, entry_hash)
      ) STRICT;
    `);
    const poison = context.database.prepare(
      `INSERT INTO fork_artifacts (
         run_id, stream, sequence, entry_hash, canonical_json, detected_at
       ) VALUES (?, ?, 1, ?, '{}', '1970-01-01T00:00:00.000Z')`,
    );
    poison.run(RUN_ID, 'constructor', hash('a'));
    poison.run(RUN_ID, 'toString', hash('b'));

    const report = await context.writer.recover(RUN_ID);

    expect(report.heads.map((head) => head.stream)).toEqual([...EVENT_STREAMS]);
    expect(report.forks).toEqual([]);
    expect(report.ok).toBe(false);
    for (const stream of ['constructor', 'toString']) {
      expect(
        report.chainViolations.some(
          (violation) =>
            violation.includes(`fork artifact ${stream}#1`) &&
            violation.includes('is not a known event stream'),
        ),
      ).toBe(true);
    }
    // A poisoned artifact leaves the run integrity-blocked, not writable.
    await expect(context.writer.commitTurn(turnRequest(2))).rejects.toThrow(
      IntegrityBlockedError,
    );

    context.close();
  });
});
