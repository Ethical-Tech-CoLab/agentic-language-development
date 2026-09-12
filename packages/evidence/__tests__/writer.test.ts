import {
  canonicalJson,
  computeEntryHash,
  domainHash,
  hashCanonical,
  hashCarrierMark,
  verifyHashSignature,
} from '@ald/hashing';
import {
  ChannelEventSchema,
  HASH_DOMAINS,
  LedgerEventSchema,
  type AnchorReceipt,
  type CheckpointManifest,
  type ExperimentRecord,
} from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CheckpointChainError,
  DuplicateRunError,
  ExperimentRecordVersionError,
  InterpretationBindingError,
  InvalidRequestError,
  UnknownRunError,
} from '../src/errors.js';
import {
  cleanupTemporaryDirectories,
  createWriter,
  hash,
  intentionDraft,
  interpretationDraft,
  proposal,
  runConfig,
} from './fixtures/support.js';

afterEach(cleanupTemporaryDirectories);

function turnRequest(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-test-001',
    turn: 1,
    sender: 'baby-a' as const,
    recipient: 'baby-b' as const,
    carrier: 'fixed-token' as const,
    communicationCondition: 'normal' as const,
    proposal,
    intentionDraft: intentionDraft(),
    deliveredArtifact: proposal.publicArtifact,
    ...overrides,
  };
}

describe('registerRun', () => {
  it('records the configuration hash and the run public keys', async () => {
    const context = await createWriter({ register: false });
    const config = runConfig();

    const { configurationHash } = context.writer.registerRun(config);

    expect(configurationHash).toBe(
      hashCanonical(HASH_DOMAINS.runConfig, config),
    );
    const metadata = context.writer.readRunMetadata(config.runId);
    expect(metadata?.configurationJson).toBe(canonicalJson(config));
    expect(metadata?.configurationHash).toBe(configurationHash);
    expect(context.writer.listRuns()).toEqual([config.runId]);
    expect(context.writer.readRunSigners(config.runId).map((s) => s.domain)).toEqual([
      'affect',
      'audit',
      'baby-a-ledger',
      'baby-b-ledger',
      'channel',
      'witness',
    ]);
    for (const signer of context.writer.readRunSigners(config.runId)) {
      expect(signer.publicKey.startsWith('ed25519-pub:')).toBe(true);
    }

    context.close();
  });

  it('refuses a duplicate run id', async () => {
    const context = await createWriter();
    expect(() => context.writer.registerRun(runConfig())).toThrow(
      DuplicateRunError,
    );
    context.close();
  });

  it('refuses a run the signer registry is not bound to', async () => {
    const context = await createWriter({ register: false });
    expect(() =>
      context.writer.registerRun(runConfig({ runId: 'run-other' })),
    ).toThrow(InvalidRequestError);
    context.close();
  });
});

describe('commitTurn', () => {
  it('commits the sender intention and channel event atomically with correct bindings', async () => {
    const context = await createWriter();

    const result = await context.writer.commitTurn(turnRequest());

    const ledgerEvents = context.writer.readEvents('run-test-001', 'baby-a-ledger');
    const channelEvents = context.writer.readEvents('run-test-001', 'channel');
    expect(ledgerEvents).toHaveLength(1);
    expect(channelEvents).toHaveLength(1);
    expect(ledgerEvents[0]?.sequence).toBe(1);
    expect(channelEvents[0]?.sequence).toBe(1);
    expect(context.writer.readEvents('run-test-001', 'baby-b-ledger')).toHaveLength(0);

    // Cross-bindings, LEDGER §6.
    expect(result.channelEvent.senderLedgerSequence).toBe(
      result.senderLedgerEvent.sequence,
    );
    expect(result.channelEvent.senderEntryHash).toBe(
      result.senderLedgerEvent.entryHash,
    );
    expect(result.channelEvent.babyProposalHash).toBe(
      hashCanonical(HASH_DOMAINS.babyProposal, proposal),
    );
    expect(result.channelEvent.publicArtifactHash).toBe(
      hashCarrierMark('fixed-token', proposal.publicArtifact),
    );
    expect(result.channelEvent.deliveryReceipt).toEqual({
      recipient: 'baby-b',
      deliveredArtifactHash: result.channelEvent.publicArtifactHash,
      deliveredAt: expect.any(String),
    });
    expect(result.delivery).toEqual({
      runId: 'run-test-001',
      turn: 1,
      logicalSender: 'baby-a',
      carrier: 'fixed-token',
      publicArtifact: proposal.publicArtifact,
      channelEventHash: result.channelEvent.entryHash,
    });

    // Genesis links.
    expect(result.senderLedgerEvent.previousEntryHash).toBe(
      `sha256:${'0'.repeat(64)}`,
    );
    expect(result.channelEvent.previousChannelHash).toBe(
      `sha256:${'0'.repeat(64)}`,
    );

    // Stored canonical JSON rehashes to the stored entry hash.
    const storedLedger = JSON.parse(ledgerEvents[0]?.canonicalJson ?? '{}');
    const storedChannel = JSON.parse(channelEvents[0]?.canonicalJson ?? '{}');
    expect(LedgerEventSchema.parse(storedLedger)).toEqual(result.senderLedgerEvent);
    expect(ChannelEventSchema.parse(storedChannel)).toEqual(result.channelEvent);
    expect(computeEntryHash('baby-a-ledger', storedLedger)).toBe(
      result.senderLedgerEvent.entryHash,
    );
    expect(computeEntryHash('channel', storedChannel)).toBe(
      result.channelEvent.entryHash,
    );

    // Signatures verify under the public keys recorded in run_signers.
    const keys = new Map(
      context.writer
        .readRunSigners('run-test-001')
        .map((signer) => [signer.domain, signer]),
    );
    expect(
      verifyHashSignature(
        result.senderLedgerEvent.entryHash,
        result.senderLedgerEvent.writerSignature,
        keys.get('baby-a-ledger')?.publicKey ?? '',
      ),
    ).toBe(true);
    expect(
      verifyHashSignature(
        result.channelEvent.entryHash,
        result.channelEvent.writerSignature,
        keys.get('channel')?.publicKey ?? '',
      ),
    ).toBe(true);
    expect(result.senderLedgerEvent.writerKeyId).toBe('baby-a-ledger-writer-v1');
    expect(result.channelEvent.writerKeyId).toBe('channel-writer-v1');

    context.close();
  });

  it('chains successive turns and both ledgers independently', async () => {
    const context = await createWriter();

    await context.writer.commitTurn(turnRequest());
    const second = await context.writer.commitTurn(
      turnRequest({ turn: 2, sender: 'baby-b', recipient: 'baby-a' }),
    );
    const third = await context.writer.commitTurn(turnRequest({ turn: 3 }));

    expect(second.senderLedgerEvent.sequence).toBe(1);
    expect(second.channelEvent.sequence).toBe(2);
    expect(third.senderLedgerEvent.sequence).toBe(2);
    expect(third.channelEvent.sequence).toBe(3);
    expect(third.channelEvent.previousChannelHash).toBe(second.channelEvent.entryHash);
    expect(context.writer.chainHead('run-test-001', 'channel')).toEqual({
      stream: 'channel',
      size: 3,
      lastEntryHash: third.channelEvent.entryHash,
    });
    expect(
      context.writer.readEvents('run-test-001', 'channel', {
        fromSequence: 2,
        toSequence: 2,
      }),
    ).toHaveLength(1);

    context.close();
  });

  it('rolls the whole turn back when the channel insert fails', async () => {
    const context = await createWriter();
    context.database.exec(
      `CREATE TRIGGER channel_events_force_failure
       BEFORE INSERT ON channel_events
       BEGIN
         SELECT RAISE(ABORT, 'induced channel insert failure');
       END;`,
    );

    await expect(context.writer.commitTurn(turnRequest())).rejects.toThrow(
      'induced channel insert failure',
    );

    expect(context.writer.readEvents('run-test-001', 'baby-a-ledger')).toHaveLength(0);
    expect(context.writer.readEvents('run-test-001', 'channel')).toHaveLength(0);
    expect(
      context.database
        .prepare('SELECT COUNT(*) AS count FROM ledger_events')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      context.database
        .prepare('SELECT COUNT(*) AS count FROM channel_events')
        .get(),
    ).toEqual({ count: 0 });

    // The writer still assigns sequence 1 after the rolled-back attempt.
    context.database.exec('DROP TRIGGER channel_events_force_failure');
    const recovered = await context.writer.commitTurn(turnRequest());
    expect(recovered.senderLedgerEvent.sequence).toBe(1);
    expect(recovered.channelEvent.sequence).toBe(1);

    context.close();
  });

  it('omits the delivery receipt under the disabled condition', async () => {
    const context = await createWriter();

    const result = await context.writer.commitTurn(
      turnRequest({ communicationCondition: 'disabled', deliveredArtifact: null }),
    );

    expect(result.delivery).toBeNull();
    expect(result.channelEvent.deliveryReceipt).toBeUndefined();
    expect(result.channelEvent.publicArtifactHash).toBe(
      hashCarrierMark('fixed-token', null),
    );
    expect(result.channelEvent.babyProposalHash).toBe(
      hashCanonical(HASH_DOMAINS.babyProposal, proposal),
    );
    const stored = context.writer.readEvents('run-test-001', 'channel')[0];
    expect(
      ChannelEventSchema.safeParse(JSON.parse(stored?.canonicalJson ?? '{}')).success,
    ).toBe(true);
    expect(JSON.parse(stored?.canonicalJson ?? '{}')).not.toHaveProperty(
      'deliveryReceipt',
    );

    context.close();
  });

  it('copies non-empty evidence refs into the ledger content', async () => {
    const context = await createWriter();

    const result = await context.writer.commitTurn(
      turnRequest({
        intentionDraft: intentionDraft({ evidenceRefs: ['channel:1', 'outcome:1'] }),
      }),
    );

    expect(result.senderLedgerEvent.content).toEqual({
      artifactRef: 'artifact-01',
      evidenceRefs: ['channel:1', 'outcome:1'],
    });

    context.close();
  });

  it('rejects a draft that is not an intention event and an unknown run', async () => {
    const context = await createWriter();

    await expect(
      context.writer.commitTurn(
        turnRequest({ intentionDraft: interpretationDraft() }),
      ),
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      context.writer.commitTurn(turnRequest({ runId: 'run-missing' })),
    ).rejects.toThrow(UnknownRunError);

    context.close();
  });
});

describe('commitRejection and commitControlArtifact', () => {
  it('writes a rejected channel event with no proposal or ledger bindings', async () => {
    const context = await createWriter();

    const event = await context.writer.commitRejection({
      runId: 'run-test-001',
      turn: 4,
      sender: 'baby-a',
      carrier: 'fixed-token',
      communicationCondition: 'normal',
      reasonCode: 'symbol-not-in-inventory',
      rejectedPayloadHash: hash('f'),
    });

    expect(event.gatewayValidationResult).toBe('rejected');
    expect(event.reasonCode).toBe('symbol-not-in-inventory');
    expect(event.publicArtifactHash).toBe(hash('f'));
    expect(event.babyProposalHash).toBeUndefined();
    expect(event.senderLedgerSequence).toBeUndefined();
    expect(event.senderEntryHash).toBeUndefined();
    expect(event.deliveryReceipt).toBeUndefined();
    expect(context.writer.readEvents('run-test-001', 'baby-a-ledger')).toHaveLength(0);

    const stored = context.writer.readEvents('run-test-001', 'channel')[0];
    expect(ChannelEventSchema.parse(JSON.parse(stored?.canonicalJson ?? '{}'))).toEqual(
      event,
    );
    expect(computeEntryHash('channel', JSON.parse(stored?.canonicalJson ?? '{}'))).toBe(
      event.entryHash,
    );

    context.close();
  });

  it('writes an oracle control artifact with origin gateway-control', async () => {
    const context = await createWriter();

    const { channelEvent, delivery } = await context.writer.commitControlArtifact({
      runId: 'run-test-001',
      turn: 5,
      logicalSender: 'baby-a',
      recipient: 'baby-b',
      carrier: 'fixed-token',
      deliveredArtifact: { symbols: ['S03'] },
    });

    expect(channelEvent.origin).toBe('gateway-control');
    expect(channelEvent.communicationCondition).toBe('oracle');
    expect(channelEvent.babyProposalHash).toBeUndefined();
    expect(channelEvent.senderEntryHash).toBeUndefined();
    expect(channelEvent.publicArtifactHash).toBe(
      hashCarrierMark('fixed-token', { symbols: ['S03'] }),
    );
    expect(channelEvent.deliveryReceipt?.recipient).toBe('baby-b');
    expect(delivery.channelEventHash).toBe(channelEvent.entryHash);

    const stored = context.writer.readEvents('run-test-001', 'channel')[0];
    expect(
      ChannelEventSchema.safeParse(JSON.parse(stored?.canonicalJson ?? '{}')).success,
    ).toBe(true);

    context.close();
  });
});

describe('appendLedgerEvent', () => {
  it('binds an interpretation to a delivery addressed to the same Baby', async () => {
    const context = await createWriter();
    const turn = await context.writer.commitTurn(turnRequest());

    const event = await context.writer.appendLedgerEvent({
      runId: 'run-test-001',
      babyId: 'B',
      turn: 1,
      draft: interpretationDraft(),
      channelEventHash: turn.channelEvent.entryHash,
    });

    expect(event.channelEventHash).toBe(turn.channelEvent.entryHash);
    expect(event.sequence).toBe(1);
    expect(context.writer.readEvents('run-test-001', 'baby-b-ledger')).toHaveLength(1);

    context.close();
  });

  it('refuses an interpretation bound to the other Baby delivery and writes nothing', async () => {
    const context = await createWriter();
    const turn = await context.writer.commitTurn(turnRequest());

    await expect(
      context.writer.appendLedgerEvent({
        runId: 'run-test-001',
        babyId: 'A',
        turn: 1,
        draft: interpretationDraft(),
        channelEventHash: turn.channelEvent.entryHash,
      }),
    ).rejects.toThrow(InterpretationBindingError);

    expect(context.writer.readEvents('run-test-001', 'baby-a-ledger')).toHaveLength(1);
    expect(context.writer.readEvents('run-test-001', 'baby-b-ledger')).toHaveLength(0);

    context.close();
  });

  it('requires a channel event hash on interpretation drafts', async () => {
    const context = await createWriter();
    await expect(
      context.writer.appendLedgerEvent({
        runId: 'run-test-001',
        babyId: 'B',
        turn: 1,
        draft: interpretationDraft(),
      }),
    ).rejects.toThrow(InterpretationBindingError);
    context.close();
  });

  it('refuses an unknown channel event hash', async () => {
    const context = await createWriter();
    await expect(
      context.writer.appendLedgerEvent({
        runId: 'run-test-001',
        babyId: 'B',
        turn: 1,
        draft: interpretationDraft(),
        channelEventHash: hash('9'),
      }),
    ).rejects.toThrow(InterpretationBindingError);
    context.close();
  });
});

describe('auxiliary streams', () => {
  it('appends signed turn records, audit entries, affect events and unsigned interventions', async () => {
    const context = await createWriter();
    const keys = new Map(
      context.writer
        .readRunSigners('run-test-001')
        .map((signer) => [signer.domain, signer.publicKey]),
    );

    const record = await context.writer.appendTurnRecord({
      runId: 'run-test-001',
      turn: 1,
      phase: 'running',
      roles: { sender: 'baby-a', receiver: 'baby-b' },
      communicationCondition: 'normal',
      scenarioRef: 'scenario-01',
      scenarioStateHash: hash('1'),
      observationHashes: { babyA: hash('2'), babyB: hash('3') },
      babyProposalHash: hash('4'),
      deliveredArtifactHash: hash('5'),
      channelEventHash: hash('6'),
      actionHash: hash('7'),
      outcomeHash: hash('8'),
      outcome: { success: true, reward: 1 },
    });
    expect(record.writerKeyId).toBe('nursery-witness-v1');
    expect(
      verifyHashSignature(
        record.entryHash,
        record.writerSignature,
        keys.get('witness') ?? '',
      ),
    ).toBe(true);

    const auditSource = await context.writer.appendLedgerEvent({
      runId: 'run-test-001',
      babyId: 'A',
      turn: 1,
      draft: intentionDraft(),
    });
    const audit = await context.writer.appendAuditLedgerEntry({
      runId: 'run-test-001',
      babyId: 'A',
      sourceEntryHash: auditSource.entryHash,
      interpreterVersion: 'interpreter-v1',
      content: {
        term: 'S01',
        hypothesis: 'S01 marks the target',
        confidence: 0.5,
        evidence: 'turn 1',
      },
    });
    expect(audit.source).toBe('generated-analysis');
    expect(
      verifyHashSignature(
        audit.entryHash,
        audit.writerSignature,
        keys.get('audit') ?? '',
      ),
    ).toBe(true);

    await expect(
      context.writer.appendAuditLedgerEntry({
        runId: 'run-test-001',
        babyId: 'B',
        sourceEntryHash: auditSource.entryHash,
        interpreterVersion: 'interpreter-v1',
        content: { term: 'S01', hypothesis: 'wrong Baby', evidence: 'turn 1' },
      }),
    ).rejects.toThrow(InterpretationBindingError);

    const affect = await context.writer.appendAffectEvent({
      runId: 'run-test-001',
      turn: 1,
      windowId: 'window-01',
      sender: 'baby-a',
      displayId: 'A3',
      affectMode: 'declared',
      deliveredAt: new Date(0).toISOString(),
    });
    expect(
      verifyHashSignature(
        affect.entryHash,
        affect.writerSignature,
        keys.get('affect') ?? '',
      ),
    ).toBe(true);

    const intervention = await context.writer.appendInterventionEvent({
      runId: 'run-test-001',
      eventType: 'pause',
      actorId: 'researcher-1',
      reasonCode: 'manual-pause',
    });
    expect(intervention.details).toEqual({});
    expect(intervention.sequence).toBe(1);
    expect(intervention).not.toHaveProperty('writerSignature');

    for (const stream of ['turns', 'audit', 'affect', 'intervention'] as const) {
      const stored = context.writer.readEvents('run-test-001', stream);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.previousEntryHash).toBe(`sha256:${'0'.repeat(64)}`);
      expect(
        computeEntryHash(stream, JSON.parse(stored[0]?.canonicalJson ?? '{}')),
      ).toBe(stored[0]?.entryHash);
    }

    context.close();
  });
});

describe('checkpoints, anchors and experiment records', () => {
  it('inserts checkpoints, anchor receipts and versioned experiment records', async () => {
    const context = await createWriter();
    const tree = { treeSize: 1, merkleRoot: hash('1'), lastEntryHash: hash('2') };
    const buildManifest = async (
      sequence: number,
      previous: string,
    ): Promise<CheckpointManifest> => {
      const unsigned = {
        version: 1 as const,
        runIdHash: domainHash(HASH_DOMAINS.runId, 'run-test-001'),
        checkpointSequence: sequence,
        previousCheckpointHash: previous,
        babyA: tree,
        babyB: tree,
        channel: tree,
        auxiliaryTrees: {},
        runConfigurationHash: hash('3'),
        promptBundleHash: hash('4'),
        softwareCommit: 'test-commit',
        createdAt: new Date(sequence).toISOString(),
        witnessKeyId: 'nursery-witness-v1',
        reason: 'event-interval' as const,
      };
      const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
      return {
        ...unsigned,
        checkpointHash,
        witnessSignature: await context.signers
          .signer('witness')
          .sign(checkpointHash),
      };
    };

    const first = await buildManifest(0, `sha256:${'0'.repeat(64)}`);
    context.writer.insertCheckpointManifest(first);
    const second = await buildManifest(1, first.checkpointHash);
    context.writer.insertCheckpointManifest(second);

    expect(context.writer.readCheckpoints('run-test-001')).toEqual([first, second]);

    // A manifest whose hash does not cover its content is refused (LEDGER §8).
    expect(() =>
      context.writer.insertCheckpointManifest({
        ...second,
        checkpointSequence: 2,
      }),
    ).toThrow(CheckpointChainError);
    // So is a correctly hashed manifest that does not link to the last one.
    const forked = await buildManifest(2, `sha256:${'0'.repeat(64)}`);
    expect(() => context.writer.insertCheckpointManifest(forked)).toThrow(
      CheckpointChainError,
    );

    const receipt: AnchorReceipt = {
      version: 1,
      runId: 'run-test-001',
      checkpointSequence: 1,
      checkpointHash: second.checkpointHash,
      anchorClass: 'simulated',
      network: 'base-sepolia',
      chainId: 84532,
      transactionHash: `0x${'a'.repeat(64)}`,
      from: `0x${'b'.repeat(40)}`,
      to: `0x${'c'.repeat(40)}`,
      inputData: `0x${'d'.repeat(64)}`,
      blockNumber: 42,
      blockHash: `0x${'e'.repeat(64)}`,
      status: 'confirmed',
      confirmations: 3,
      finalityPolicy: '1-confirmation',
      rpcEndpointLabel: 'test-rpc',
      recordedAt: new Date(0).toISOString(),
    };
    context.writer.insertAnchorReceipt(receipt);
    expect(context.writer.readAnchorReceipts('run-test-001')).toEqual([receipt]);
    // The anchor receipt must reference a stored checkpoint (foreign key).
    expect(() =>
      context.writer.insertAnchorReceipt({
        ...receipt,
        checkpointHash: hash('9'),
        transactionHash: `0x${'f'.repeat(64)}`,
      }),
    ).toThrow();

    const record: ExperimentRecord = {
      version: 1,
      recordVersion: 1,
      runId: 'run-test-001',
      experimentId: 'E00',
      deploymentMode: 'prototype',
      learnerContractVersion: '1',
      runConfigRef: hash('a'),
      protocolGitCommit: 'e2b1c0d4f5a6978877665544332211aabbccddee',
      preRegistrationHash: hash('c'),
      disposition: 'valid',
      checkpointManifestRef: second.checkpointHash,
      anchorTxRef: receipt.transactionHash,
      verifierReportRef: 'verification-report.json',
      claimBoundaryStatement: 'prototype boundary',
      deviations: [],
    };
    context.writer.appendExperimentRecord(record);
    expect(() =>
      context.writer.appendExperimentRecord({ ...record, recordVersion: 3 }),
    ).toThrow(ExperimentRecordVersionError);
    context.writer.appendExperimentRecord({ ...record, recordVersion: 2 });
    expect(
      context.writer.readExperimentRecords('run-test-001').map((r) => r.recordVersion),
    ).toEqual([1, 2]);

    context.close();
  });
});
