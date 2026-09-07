import { canonicalJson } from '@ald/hashing';
import { EVENT_STREAMS, GENESIS_HASH } from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { ForkDetectedError, IntegrityBlockedError, UnknownRunError } from '../src/errors.js';
import {
  cleanupTemporaryDirectories,
  createWriter,
  intentionDraft,
  proposal,
  StepClock,
} from './fixtures/support.js';

afterEach(cleanupTemporaryDirectories);

const RUN_ID = 'run-test-001';

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
});
