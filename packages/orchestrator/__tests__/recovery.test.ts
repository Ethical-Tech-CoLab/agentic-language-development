/**
 * ALD-027: crash recovery and integrity-fork handling (SPEC §7.3,
 * LEDGER-INTEGRITY-DESIGN.md §15).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteEvidenceWriter } from '@ald/evidence';
import { StepClock } from '@ald/gateway';
import { parseCanonicalJson, validateChain } from '@ald/hashing';
import type { LedgerEventDraft } from '@ald/types';

import {
  createHarness,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

const HYPOTHESIS_DRAFT: LedgerEventDraft = {
  eventType: 'hypothesis.created',
  contentSchema: 'agent-native-ledger',
  subjectId: 'symbol:S01',
  content: { hypothesisRef: 'hyp:conflict' },
  blindingNonce: 'nonce:conflict',
  evidenceRefs: [],
};

function ledgerViolations(harness: Harness, runId: string): string[] {
  const writer = harness.runtime.writerFor(runId);
  const keys = new Map(
    writer.readRunSigners(runId).map((signer) => [signer.domain, signer.publicKey]),
  );
  const violations: string[] = [];
  for (const stream of ['baby-a-ledger', 'baby-b-ledger'] as const) {
    const events = writer
      .readEvents(runId, stream)
      .map(
        (event) =>
          parseCanonicalJson(event.canonicalJson) as Record<string, unknown>,
      );
    const result = validateChain(stream, events, {
      runId,
      publicKey: keys.get(stream),
      requireSignatures: true,
      babyId: stream === 'baby-a-ledger' ? 'A' : 'B',
    });
    violations.push(...result.violations.map((violation) => violation.message));
  }
  return violations;
}

describe('crash recovery (ALD-027)', () => {
  let harness: Harness | undefined;
  let restarted: Harness | undefined;

  afterEach(async () => {
    await restarted?.cleanup();
    await harness?.cleanup();
    harness = undefined;
    restarted = undefined;
  });

  it('reconstructs the run at the last committed turn and continues', async () => {
    harness = await createHarness({
      learnerOptions: { shared: { learningRate: 1, temperature: 0.5 } },
    });
    const runId = 'run-recovery';
    const config = testConfig({
      runId,
      experimentId: 'E11',
      randomSeed: 'ald-recovery',
      babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      learningSignal: 'extrinsic-task',
      maxTurnsPerRun: 100,
      evaluationTurns: 10,
    });
    await harness.runtime.createRun(config);
    for (let turn = 0; turn < 30; turn += 1) {
      await harness.runtime.step(runId);
    }
    const headsBefore = ['baby-a-ledger', 'baby-b-ledger', 'channel'].map(
      (stream) =>
        harness?.runtime
          .writerFor(runId)
          .chainHead(runId, stream as 'channel').size ?? 0,
    );

    // The process dies without sealing; a new runtime opens the same store.
    restarted = harness.restart({ clock: new StepClock(Date.UTC(2026, 5, 1)) });
    const summary = await restarted.runtime.recover(runId);
    expect(summary.state).toBe('running');
    expect(summary.turn).toBe(30);

    const recovery = restarted.runtime
      .auditLog(runId)
      .find((event) => event.eventType === 'recovery');
    expect(recovery).toBeDefined();
    expect(recovery?.reasonCode).toBe('restart-recovery');
    expect(recovery?.details).toMatchObject({
      turnsRestored: 30,
      nextTurn: 30,
      policyRestored: { 'baby-a': true, 'baby-b': true },
    });
    expect(
      restarted.runtime
        .checkpoints(runId)
        .some((manifest) => manifest.reason === 'recovery'),
    ).toBe(true);

    for (let turn = 0; turn < 10; turn += 1) {
      await restarted.runtime.step(runId);
    }

    const records = restarted.runtime.turnRecords(runId);
    expect(records).toHaveLength(40);
    expect(records.map((record) => record.turn)).toEqual(
      Array.from({ length: 40 }, (_, index) => index),
    );
    // LEDGER §15: sequences continue, never reused and never truncated.
    expect(ledgerViolations(restarted, runId)).toEqual([]);
    const headsAfter = ['baby-a-ledger', 'baby-b-ledger', 'channel'].map(
      (stream) =>
        restarted?.runtime
          .writerFor(runId)
          .chainHead(runId, stream as 'channel').size ?? 0,
    );
    headsAfter.forEach((size, index) => {
      expect(size).toBeGreaterThan(headsBefore[index] ?? 0);
    });
  }, 60_000);
});

describe('integrity fork handling (ALD-027)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('marks the run forked-invalid and preserves both artifacts', async () => {
    harness = await createHarness();
    const runId = 'run-fork';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-fork',
        maxTurnsPerRun: 20,
        evaluationTurns: 5,
      }),
    );
    await harness.runtime.createRun(config);
    await harness.runtime.step(runId);
    await harness.runtime.step(runId);

    // A second writer with a different clock races the runtime's writer for
    // the same Baby-A ledger sequence: same sequence, different entry hash.
    const primary = harness.runtime.writerFor(runId);
    const other = new SqliteEvidenceWriter({
      database: harness.database,
      signers: harness.signerProvider(runId),
      clock: new StepClock(Date.UTC(2030, 0, 1)),
      softwareCommit: 'git:conflicting-writer',
    });
    const settled = await Promise.allSettled([
      primary.appendLedgerEvent({
        runId,
        babyId: 'A',
        turn: 2,
        draft: HYPOTHESIS_DRAFT,
      }),
      other.appendLedgerEvent({
        runId,
        babyId: 'A',
        turn: 2,
        draft: HYPOTHESIS_DRAFT,
      }),
    ]);
    expect(settled.some((result) => result.status === 'rejected')).toBe(true);

    const artifacts = primary.readForkArtifacts(runId);
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(artifacts.map((artifact) => artifact.entryHash)).size).toBe(2);

    const summary = await harness.runtime.recover(runId);
    expect(summary.state).toBe('forked-invalid');
    // §7.1: `forked-invalid` is terminal — the run stops accepting turns.
    await expect(harness.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );
  }, 60_000);
});
