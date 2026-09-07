/**
 * SPEC §7.1/§7.2/§7.3, §11.9, §14.2 and LEDGER-INTEGRITY-DESIGN.md §15: what
 * a run that already ended may still acquire.
 *
 * A terminal run is complete and immutable — recovery never reopens it, an
 * operator note never displaces its anchored final checkpoint, a retried seal
 * never writes a second `run.sealed`, and an abort is never republished as a
 * valid, sealed run. Recovery also refuses to sign a tail with keys the run
 * never registered (LEDGER §11).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySignerRegistry } from '@ald/hashing';
import type { AnchorPublisher, AnchorReceipt, EventStream } from '@ald/types';

import { SignerRegistryMismatchError } from '../src/index.js';
import {
  FakeAnchorPublisher,
  anchorPublisherFor,
  createHarness,
  fakeVerifier,
  noLearningOverrides,
  testConfig,
  type Harness,
} from './helpers.js';

const OPERATOR = {
  actorId: 'researcher:test-operator',
  reasonCode: 'manual-check',
};

const CHAINS: readonly EventStream[] = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'turns',
  'intervention',
];

/** A publisher whose first `failures` submissions fail, then succeed. */
function flakyPublisher(runId: string, failures: number): AnchorPublisher {
  const inner = new FakeAnchorPublisher();
  let attempts = 0;
  return {
    network: inner.network,
    submit: async (manifest) => {
      attempts += 1;
      if (attempts <= failures) {
        throw new Error('rpc endpoint unavailable');
      }
      return { ...(await inner.submit(manifest)), runId };
    },
    awaitConfirmation: (receipt) => inner.awaitConfirmation(receipt),
  };
}

function heads(harness: Harness, runId: string): number[] {
  const writer = harness.runtime.writerFor(runId);
  return CHAINS.map((stream) => writer.chainHead(runId, stream).size);
}

function sealedEventCount(harness: Harness, runId: string): number[] {
  const ledgers = harness.runtime.ledgers(runId);
  return [ledgers.babyA, ledgers.babyB].map(
    (ledger) => ledger.filter((event) => event.eventType === 'run.sealed').length,
  );
}

function checkpointReasons(harness: Harness, runId: string): string[] {
  return harness.runtime.checkpoints(runId).map((manifest) => manifest.reason);
}

describe('recovery of a run that already ended (SPEC §7.3, LEDGER §15)', () => {
  let harness: Harness | undefined;
  let restarted: Harness | undefined;

  afterEach(async () => {
    await restarted?.cleanup();
    await harness?.cleanup();
    harness = undefined;
    restarted = undefined;
  });

  it('rebuilds an aborted-sealed run from its evidence and writes nothing', async () => {
    harness = await createHarness();
    const runId = 'run-recover-terminal';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-recover-terminal',
          maxTurnsPerRun: 2,
          evaluationTurns: 2,
        }),
      ),
    );
    await harness.runtime.step(runId);
    await harness.runtime.step(runId);
    const aborted = await harness.runtime.abort(runId, OPERATOR);
    expect(aborted.state).toBe('aborted-sealed');
    const headsBefore = heads(harness, runId);
    const reasonsBefore = checkpointReasons(harness, runId);

    restarted = harness.restart();
    const recovered = await restarted.runtime.recover(runId);

    // §7.1: the terminal state is reconstructed from the evidence that ended
    // the run, not from the turn-record counts.
    expect(recovered.state).toBe('aborted-sealed');
    // LEDGER §15: no recovery intervention, no recovery checkpoint, and the
    // anchored final checkpoint is still the tip of the chain.
    expect(heads(restarted, runId)).toEqual(headsBefore);
    expect(checkpointReasons(restarted, runId)).toEqual(reasonsBefore);
    expect(checkpointReasons(restarted, runId)).not.toContain('recovery');
    expect(checkpointReasons(restarted, runId).at(-1)).toBe('run-aborted');
    expect(sealedEventCount(restarted, runId)).toEqual([1, 1]);
    await expect(restarted.runtime.step(runId)).rejects.toThrow(
      /does not accept turns/u,
    );

    // A seal re-entered on a terminal run stays a no-op: no second
    // `run.sealed`, no second final checkpoint, no new Experiment Record.
    const recordsBefore = restarted.runtime.experimentRecords(runId).length;
    expect((await restarted.runtime.seal(runId)).state).toBe('aborted-sealed');
    expect(restarted.runtime.experimentRecords(runId)).toHaveLength(
      recordsBefore,
    );
    expect(sealedEventCount(restarted, runId)).toEqual([1, 1]);
    expect(heads(restarted, runId)).toEqual(headsBefore);
  }, 60_000);

  it('refuses to recover under a registry the run never registered', async () => {
    harness = await createHarness();
    const runId = 'run-recover-signers';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-recover-signers',
          maxTurnsPerRun: 4,
          evaluationTurns: 2,
        }),
      ),
    );
    await harness.runtime.step(runId);
    const headsBefore = heads(harness, runId);
    const reasonsBefore = checkpointReasons(harness, runId);

    // A restart that generates fresh keys instead of loading the run's own.
    restarted = harness.restart({
      signerProvider: (id: string) => InMemorySignerRegistry.generate(id),
    });
    await expect(restarted.runtime.recover(runId)).rejects.toThrow(
      SignerRegistryMismatchError,
    );

    // §14.5: the refusal is audited (the intervention stream is unsigned), and
    // nothing signed was written.
    const trigger = restarted.runtime
      .auditLog(runId)
      .filter(
        (event) =>
          event.eventType === 'safety-trigger' &&
          event.reasonCode === 'signer-registry-mismatch',
      );
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.details['domains']).toEqual(
      expect.arrayContaining(['baby-a-ledger', 'channel', 'witness']),
    );
    const headsAfter = heads(restarted, runId);
    expect(headsAfter.slice(0, 4)).toEqual(headsBefore.slice(0, 4));
    expect(checkpointReasons(restarted, runId)).toEqual(reasonsBefore);
    expect(
      restarted.runtime
        .auditLog(runId)
        .some((event) => event.eventType === 'recovery'),
    ).toBe(false);
  }, 60_000);
});

describe('seal idempotence after later evidence (LEDGER §15)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('keeps one run.sealed and one final checkpoint across annotate + retrySeal', async () => {
    const runId = 'run-annotate-then-retry';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: flakyPublisher(runId, 1),
      verifier: fakeVerifier(runId),
    });
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-annotate-retry',
          maxTurnsPerRun: 1,
          evaluationTurns: 2,
        }),
      ),
    );
    expect((await harness.runtime.runToCompletion(runId)).state).toBe(
      'sealing-blocked',
    );
    const reasonsBefore = checkpointReasons(harness, runId);

    // §14.2: the operator files a note while chasing the blocked seal. The
    // note is audited, but it may not take a checkpoint past the exported
    // final one.
    const note = await harness.runtime.annotate(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'investigating-anchor',
    });
    expect(note.eventType).toBe('annotate');
    expect(checkpointReasons(harness, runId)).toEqual(reasonsBefore);

    const retried = await harness.runtime.retrySeal(runId);
    expect(retried.state).toBe('sealed');
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);
    expect(
      checkpointReasons(harness, runId).filter(
        (reason) => reason === 'run-sealed',
      ),
    ).toHaveLength(1);
    expect(checkpointReasons(harness, runId)).toEqual(reasonsBefore);

    // §7.1: a terminal run takes no further note at all.
    await expect(
      harness.runtime.annotate(runId, {
        actorId: OPERATOR.actorId,
        reasonCode: 'post-hoc-note',
      }),
    ).rejects.toThrow(/invalid-run-state|is in state/u);
    expect(checkpointReasons(harness, runId)).toEqual(reasonsBefore);
  }, 60_000);

  it('keeps the abort when a blocked abort seal is retried', async () => {
    const runId = 'run-abort-then-retry';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: flakyPublisher(runId, 1),
      verifier: fakeVerifier(runId),
    });
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-abort-retry',
          maxTurnsPerRun: 4,
          evaluationTurns: 2,
        }),
      ),
    );
    await harness.runtime.step(runId);
    const blocked = await harness.runtime.abort(runId, {
      actorId: OPERATOR.actorId,
      reasonCode: 'operator-abort',
    });
    expect(blocked.state).toBe('sealing-blocked');
    expect(harness.runtime.experimentRecords(runId).at(-1)?.disposition).toBe(
      'aborted',
    );

    const retried = await harness.runtime.retrySeal(runId);

    // §7.2 abort row: an aborted run ends at `aborted-sealed`, and §11.9 keeps
    // the failure in the research record — it is never published as valid.
    expect(retried.state).toBe('aborted-sealed');
    const records = harness.runtime.experimentRecords(runId);
    expect(records.at(-1)?.disposition).toBe('aborted');
    expect(records.map((record) => record.disposition)).not.toContain('valid');
    expect(sealedEventCount(harness, runId)).toEqual([1, 1]);
    const reasons = checkpointReasons(harness, runId);
    expect(reasons.filter((reason) => reason === 'run-aborted')).toHaveLength(1);
    expect(reasons).not.toContain('run-sealed');
    expect(
      harness.runtime
        .auditLog(runId)
        .some(
          (event) =>
            event.eventType === 'governance-decision' &&
            event.reasonCode === 'abort-seal-completed',
        ),
    ).toBe(true);
  }, 60_000);
});

describe('anchor receipt ownership (LEDGER §10, SPEC §13.4)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function sealWith(
    runId: string,
    finalStatus: AnchorReceipt['status'],
  ): Promise<Harness> {
    const built = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId, false, {
        finalStatus,
        evidence: () => harness?.runtime.writerFor(runId),
      }),
      verifier: fakeVerifier(runId),
    });
    harness = built;
    await built.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: `ald-anchor-${finalStatus}`,
          maxTurnsPerRun: 1,
          evaluationTurns: 2,
        }),
      ),
    );
    await built.runtime.runToCompletion(runId);
    return built;
  }

  it('seals on a confirmed receipt and stores exactly the publisher row', async () => {
    const runId = 'run-anchor-confirmed';
    const sealed = await sealWith(runId, 'confirmed');
    expect(sealed.runtime.getRun(runId)?.state).toBe('sealed');
    const receipts = sealed.runtime.writerFor(runId).readAnchorReceipts(runId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('confirmed');
  }, 60_000);

  it('blocks the seal on a failed receipt without writing a second row', async () => {
    const runId = 'run-anchor-failed';
    const blocked = await sealWith(runId, 'failed');
    expect(blocked.runtime.getRun(runId)?.state).toBe('sealing-blocked');
    const current = blocked.runtime.experimentRecords(runId).at(-1);
    expect(current?.disposition).toBe('invalid');
    expect(current?.anchorTxRef).toBe(`0x${'0'.repeat(64)}`);
    expect(current?.deviations.join(' ')).toContain('anchor-unavailable');
    // The publisher inserted the single terminal row; the runtime added none.
    expect(
      blocked.runtime.writerFor(runId).readAnchorReceipts(runId),
    ).toHaveLength(1);
  }, 60_000);

  it('blocks the seal when the publisher gave up, storing no receipt at all', async () => {
    const runId = 'run-anchor-submitted';
    const pending = await sealWith(runId, 'submitted');
    expect(pending.runtime.getRun(runId)?.state).toBe('sealing-blocked');
    // A give-up is not a terminal decision: the pending sidecar stays the
    // resume handle and no append-only row exists yet.
    expect(
      pending.runtime.writerFor(runId).readAnchorReceipts(runId),
    ).toHaveLength(0);
    expect(
      pending.runtime.experimentRecords(runId).at(-1)?.deviations.join(' '),
    ).toContain('anchor-unavailable');
  }, 60_000);
});
