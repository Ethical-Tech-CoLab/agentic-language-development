/**
 * The single Evidence Writer service (SPECIFICATION.md §4.1 item 7, §8.2,
 * §12.7; LEDGER-INTEGRITY-DESIGN.md §3, §4, §6, §15).
 *
 * Every write in the system goes through one instance of this class. It is
 * the only place that holds SQL against the event tables (ALD-010 criterion
 * 3): no other module — Gateway, Controller, Checkpoint Service — is given a
 * function that can append to `ledger_events`, `channel_events`,
 * `affect_events`, `audit_ledger_entries`, `turn_records`, or
 * `intervention_log`.
 *
 * Ordering rules implemented here:
 * - one async mutex serializes all writes of an instance, so the chain-head
 *   read that assigns a sequence cannot race a concurrent append;
 * - signatures are awaited *before* the synchronous better-sqlite3
 *   transaction opens, so a signing failure rolls nothing back and a commit
 *   never waits on a remote signer (SPEC §8.2);
 * - all rows of one logical commit are inserted in a single transaction — for
 *   an accepted turn that is the sender intention event plus the channel
 *   event, or neither.
 */
import {
  AffectEventSchema,
  AnchorReceiptSchema,
  AuditLedgerEntrySchema,
  AUXILIARY_TREES,
  babyIdForRole,
  ChannelEventSchema,
  CheckpointManifestSchema,
  EVENT_STREAMS,
  ExperimentRecordSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  InterventionEventSchema,
  LedgerEventSchema,
  MANDATORY_TREES,
  MANIFEST_SIGNATURE_FIELDS,
  roleForBabyId,
  RunConfigSchema,
  STREAM_SIGNER,
  TurnRecordSchema,
  type AffectEvent,
  type AnchorReceipt,
  type AuditLedgerEntry,
  type AuditLedgerAppendRequest,
  type BabyRole,
  type ChainHead,
  type ChannelEvent,
  type CheckpointManifest,
  type Clock,
  type ControlArtifactCommitRequest,
  type DeliveredChannelArtifact,
  type EventRange,
  type EventStream,
  type EvidenceWriter,
  type ExperimentRecord,
  type ForkReport,
  type InterventionAppendRequest,
  type InterventionEvent,
  type LedgerAppendRequest,
  type LedgerEvent,
  type LedgerEventDraft,
  type RecoveryReport,
  type RejectionCommitRequest,
  type RunConfig,
  type RunMetadataRecord,
  type Sha256Hash,
  type SignerDomain,
  type SignerPublicKey,
  type SignerRegistry,
  type StoredEvent,
  type TreeReference,
  type TurnCommitRequest,
  type TurnCommitResult,
  type TurnRecord,
  type TurnRecordAppendRequest,
} from '@ald/types';
import {
  canonicalJson,
  computeEntryHash,
  domainHash,
  hashCanonical,
  hashCarrierMark,
  verifyHashSignature,
} from '@ald/hashing';

import type { EvidenceDatabase } from './database.js';
import {
  CheckpointChainError,
  DuplicateEventError,
  DuplicateRunError,
  EvidenceWriterError,
  ExperimentRecordVersionError,
  ForkDetectedError,
  IntegrityBlockedError,
  InterpretationBindingError,
  InvalidRequestError,
  UnknownRunError,
} from './errors.js';
import { validateLedgerEventDraft } from './event-types.js';
import { AsyncMutex } from './mutex.js';

// ---------------------------------------------------------------------------
// Private table mapping. Raw SQL never leaves this module.
// ---------------------------------------------------------------------------

interface StreamTable {
  /** Physical table backing the stream. */
  readonly table: string;
  /** Column holding the previous entry hash of the chain. */
  readonly previousColumn: string;
  /** Set for the two per-Baby ledger streams sharing `ledger_events`. */
  readonly babyId?: 'A' | 'B';
  /** False only for `intervention`, which the v1 schema stores unsigned. */
  readonly signed: boolean;
}

const STREAM_TABLES: Record<EventStream, StreamTable> = {
  'baby-a-ledger': {
    table: 'ledger_events',
    previousColumn: 'previous_entry_hash',
    babyId: 'A',
    signed: true,
  },
  'baby-b-ledger': {
    table: 'ledger_events',
    previousColumn: 'previous_entry_hash',
    babyId: 'B',
    signed: true,
  },
  channel: {
    table: 'channel_events',
    previousColumn: 'previous_channel_hash',
    signed: true,
  },
  affect: {
    table: 'affect_events',
    previousColumn: 'previous_entry_hash',
    signed: true,
  },
  audit: {
    table: 'audit_ledger_entries',
    previousColumn: 'previous_entry_hash',
    signed: true,
  },
  turns: {
    table: 'turn_records',
    previousColumn: 'previous_entry_hash',
    signed: true,
  },
  intervention: {
    table: 'intervention_log',
    previousColumn: 'previous_entry_hash',
    signed: false,
  },
};

/** Narrowed form of `ledgerStreamForRole`, which returns the wide `EventStream`. */
function ledgerStreamFor(role: BabyRole): 'baby-a-ledger' | 'baby-b-ledger' {
  return role === 'baby-a' ? 'baby-a-ledger' : 'baby-b-ledger';
}

function streamFilter(stream: EventStream): string {
  return STREAM_TABLES[stream].babyId === undefined
    ? 'run_id = ?'
    : 'run_id = ? AND baby_id = ?';
}

function streamKey(runId: string, stream: EventStream): unknown[] {
  const babyId = STREAM_TABLES[stream].babyId;
  return babyId === undefined ? [runId] : [runId, babyId];
}

interface StreamRow {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  recorded_at: string;
  canonical_json: string;
}

/** One row of a pending logical commit, used for fork classification. */
interface PendingRow {
  stream: EventStream;
  sequence: number;
  entryHash: Sha256Hash;
  canonicalJson: string;
}

const SQLITE_CONFLICT_CODES = new Set([
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_UNIQUE',
]);

/**
 * Domain check for a stream name read back out of the store. It tests the
 * `EVENT_STREAMS` list rather than writing `value in STREAM_TABLES`, because
 * `in` is true for every inherited `Object.prototype` key (`constructor`,
 * `toString`, …) of an object literal — the same trap `isSignedStream` in
 * `@ald/hashing` avoids with `Object.prototype.hasOwnProperty.call`.
 */
function isEventStream(value: string): value is EventStream {
  return (EVENT_STREAMS as readonly string[]).includes(value);
}

/** Checkpoint tree name (LEDGER §8) → the stream it commits, both ways. */
const STREAM_FOR_AUXILIARY_TREE = new Map<string, EventStream>(
  Object.entries(AUXILIARY_TREES).map(([stream, tree]) => [
    tree,
    stream as EventStream,
  ]),
);

const MANDATORY_TREE_STREAMS = Object.entries(MANDATORY_TREES) as [
  EventStream,
  (typeof MANDATORY_TREES)[keyof typeof MANDATORY_TREES],
][];

function isUniquenessConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    SQLITE_CONFLICT_CODES.has((error as { code: string }).code)
  );
}

// ---------------------------------------------------------------------------
// Package-local request types for streams the contract has no writer for
// ---------------------------------------------------------------------------

/**
 * Affect append request. `EvidenceWriter` in `@ald/types` declares no affect
 * method even though `affect_events` is a mandatory auxiliary tree
 * (SPEC §11.6, §13.3), so this extension keeps the stream writable by the
 * single writer instead of by the Gateway.
 */
export interface AffectAppendRequest {
  runId: string;
  turn: number;
  windowId: string;
  sender: BabyRole;
  displayId: AffectEvent['displayId'];
  affectMode: AffectEvent['affectMode'];
  deliveredAt: string;
}

export interface ForkArtifactRecord {
  runId: string;
  stream: string;
  sequence: number;
  entryHash: Sha256Hash;
  canonicalJson: string;
  detectedAt: string;
}

export interface SqliteEvidenceWriterOptions {
  /** Open store from `openEvidenceDatabase`. */
  database: EvidenceDatabase;
  /** Per-run signer registry; its `runId` must match every signed write. */
  signers: SignerRegistry;
  /** Injected clock so tests are deterministic (defaults to real UTC time). */
  clock?: Clock;
  /** Recorded in exported bundles and checkpoints; not part of any hash here. */
  softwareCommit?: string;
}

const realClock: Clock = { now: () => new Date().toISOString() };

export class SqliteEvidenceWriter implements EvidenceWriter {
  private readonly db: EvidenceDatabase['database'];
  private readonly signers: SignerRegistry;
  private readonly clock: Clock;
  private readonly mutex = new AsyncMutex();
  /**
   * LEDGER §15: a run whose last `recover()` found violations or forks
   * accepts no further writes until a research-integrity review is recorded.
   */
  private readonly integrityBlocks = new Map<string, string[]>();

  readonly softwareCommit: string;

  constructor(options: SqliteEvidenceWriterOptions) {
    this.db = options.database.database;
    this.signers = options.signers;
    this.clock = options.clock ?? realClock;
    this.softwareCommit = options.softwareCommit ?? 'unknown';
  }

  // -------------------------------------------------------------------------
  // Read side (EvidenceReader)
  // -------------------------------------------------------------------------

  listRuns(): string[] {
    return this.db
      .prepare<[], { run_id: string }>(
        'SELECT run_id FROM run_metadata ORDER BY run_id',
      )
      .all()
      .map((row) => row.run_id);
  }

  readRunMetadata(runId: string): RunMetadataRecord | undefined {
    const row = this.db
      .prepare<
        [string],
        {
          run_id: string;
          created_at: string;
          deployment_mode: string;
          configuration_hash: string;
          configuration_json: string;
          parent_run_id: string | null;
          derived_from_checkpoint_hash: string | null;
        }
      >('SELECT * FROM run_metadata WHERE run_id = ?')
      .get(runId);

    if (!row) {
      return undefined;
    }

    return {
      runId: row.run_id,
      createdAt: row.created_at,
      deploymentMode: row.deployment_mode as RunConfig['deploymentMode'],
      configurationHash: row.configuration_hash,
      configurationJson: row.configuration_json,
      parentRunId: row.parent_run_id,
      derivedFromCheckpointHash: row.derived_from_checkpoint_hash,
    };
  }

  chainHead(runId: string, stream: EventStream): ChainHead {
    const spec = STREAM_TABLES[stream];
    const row = this.db
      .prepare<unknown[], { size: number; last_entry_hash: string | null }>(
        `SELECT COUNT(*) AS size,
                (SELECT entry_hash FROM ${spec.table}
                  WHERE ${streamFilter(stream)}
                  ORDER BY sequence DESC LIMIT 1) AS last_entry_hash
           FROM ${spec.table}
          WHERE ${streamFilter(stream)}`,
      )
      .get(...streamKey(runId, stream), ...streamKey(runId, stream));

    const size = row?.size ?? 0;
    return {
      stream,
      size,
      lastEntryHash: size === 0 ? GENESIS_HASH : (row?.last_entry_hash ?? GENESIS_HASH),
    };
  }

  readEvents(
    runId: string,
    stream: EventStream,
    range?: EventRange,
  ): StoredEvent[] {
    return this.streamRows(runId, stream, range).map((row) => ({
      stream,
      sequence: row.sequence,
      entryHash: row.entry_hash,
      previousEntryHash: row.previous_hash,
      recordedAt: row.recorded_at,
      canonicalJson: row.canonical_json,
    }));
  }

  readCheckpoints(runId: string): CheckpointManifest[] {
    return this.db
      .prepare<[string], { canonical_json: string }>(
        `SELECT canonical_json FROM checkpoint_manifests
          WHERE run_id = ? ORDER BY checkpoint_sequence`,
      )
      .all(runId)
      .map((row) =>
        CheckpointManifestSchema.parse(JSON.parse(row.canonical_json)),
      );
  }

  readAnchorReceipts(runId: string): AnchorReceipt[] {
    return this.db
      .prepare<[string], { canonical_json: string }>(
        `SELECT canonical_json FROM anchor_receipts
          WHERE run_id = ?
          ORDER BY recorded_at, chain_id, transaction_hash`,
      )
      .all(runId)
      .map((row) => AnchorReceiptSchema.parse(JSON.parse(row.canonical_json)));
  }

  readExperimentRecords(runId: string): ExperimentRecord[] {
    return this.db
      .prepare<[string], { canonical_json: string }>(
        `SELECT canonical_json FROM experiment_records
          WHERE run_id = ? ORDER BY record_version`,
      )
      .all(runId)
      .map((row) => ExperimentRecordSchema.parse(JSON.parse(row.canonical_json)));
  }

  /** LEDGER §11: the public halves of this run's per-run keys, never seeds. */
  readRunSigners(runId: string): SignerPublicKey[] {
    return this.db
      .prepare<[string], { domain: string; key_id: string; public_key: string }>(
        `SELECT domain, key_id, public_key FROM run_signers
          WHERE run_id = ? ORDER BY domain`,
      )
      .all(runId)
      .map((row) => ({
        domain: row.domain as SignerDomain,
        keyId: row.key_id,
        publicKey: row.public_key,
      }));
  }

  /** LEDGER §15: both sides of every detected fork, preserved for review. */
  readForkArtifacts(runId: string): ForkArtifactRecord[] {
    return this.db
      .prepare<
        [string],
        {
          run_id: string;
          stream: string;
          sequence: number;
          entry_hash: string;
          canonical_json: string;
          detected_at: string;
        }
      >(
        `SELECT * FROM fork_artifacts
          WHERE run_id = ? ORDER BY stream, sequence, entry_hash`,
      )
      .all(runId)
      .map((row) => ({
        runId: row.run_id,
        stream: row.stream,
        sequence: row.sequence,
        entryHash: row.entry_hash,
        canonicalJson: row.canonical_json,
        detectedAt: row.detected_at,
      }));
  }

  // -------------------------------------------------------------------------
  // Run registration
  // -------------------------------------------------------------------------

  registerRun(config: RunConfig): { configurationHash: Sha256Hash } {
    const parsed = RunConfigSchema.parse(config);
    if (parsed.runId !== this.signers.runId) {
      throw new InvalidRequestError(
        `Signer registry is bound to run ${this.signers.runId}, not ${parsed.runId}`,
      );
    }
    if (this.readRunMetadata(parsed.runId)) {
      throw new DuplicateRunError(parsed.runId);
    }

    const configurationHash = hashCanonical(HASH_DOMAINS.runConfig, parsed);
    const recordedAt = this.clock.now();
    const signerRows = this.signers.publicKeys();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO run_metadata (
             run_id, created_at, deployment_mode, configuration_hash,
             configuration_json, parent_run_id, derived_from_checkpoint_hash
           ) VALUES (
             @runId, @createdAt, @deploymentMode, @configurationHash,
             @configurationJson, @parentRunId, @derivedFromCheckpointHash
           )`,
        )
        .run({
          runId: parsed.runId,
          createdAt: recordedAt,
          deploymentMode: parsed.deploymentMode,
          configurationHash,
          configurationJson: canonicalJson(parsed),
          parentRunId: parsed.parentRunId ?? null,
          derivedFromCheckpointHash: parsed.derivedFromCheckpointHash ?? null,
        });

      const insertSigner = this.db.prepare(
        `INSERT INTO run_signers (run_id, domain, key_id, public_key, recorded_at)
         VALUES (@runId, @domain, @keyId, @publicKey, @recordedAt)`,
      );
      for (const signer of signerRows) {
        insertSigner.run({
          runId: parsed.runId,
          domain: signer.domain,
          keyId: signer.keyId,
          publicKey: signer.publicKey,
          recordedAt: recordedAt,
        });
      }
    })();

    return { configurationHash };
  }

  // -------------------------------------------------------------------------
  // Atomic turn commit (SPEC §8.2, LEDGER §6)
  // -------------------------------------------------------------------------

  async commitTurn(request: TurnCommitRequest): Promise<TurnCommitResult> {
    const draft = validateLedgerEventDraft(request.intentionDraft);
    if (draft.eventType !== 'intention.recorded') {
      throw new InvalidRequestError(
        `A turn commit requires an intention.recorded draft, received ${draft.eventType}`,
      );
    }

    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const ledgerStream = ledgerStreamFor(request.sender);
      const ledgerHead = this.chainHead(request.runId, ledgerStream);
      const senderLedgerEvent = await this.signLedgerEvent({
        runId: request.runId,
        stream: ledgerStream,
        babyId: babyIdForRole(request.sender),
        sequence: ledgerHead.size + 1,
        turn: request.turn,
        draft,
        previousEntryHash: ledgerHead.lastEntryHash,
      });

      const channelHead = this.chainHead(request.runId, 'channel');
      const publicArtifactHash = hashCarrierMark(
        request.carrier,
        request.deliveredArtifact,
      );
      const recordedAt = this.clock.now();
      const channelEvent = await this.signChannelEvent({
        version: 1,
        runId: request.runId,
        sequence: channelHead.size + 1,
        turn: request.turn,
        logicalSender: request.sender,
        origin: 'baby',
        carrier: request.carrier,
        communicationCondition: request.communicationCondition,
        babyProposalHash: hashCanonical(
          HASH_DOMAINS.babyProposal,
          request.proposal,
        ),
        senderLedgerSequence: senderLedgerEvent.sequence,
        senderEntryHash: senderLedgerEvent.entryHash,
        publicArtifactHash,
        previousChannelHash: channelHead.lastEntryHash,
        gatewayValidationResult: 'accepted',
        ...(request.deliveredArtifact !== null
          ? {
              deliveryReceipt: {
                recipient: request.recipient,
                deliveredArtifactHash: publicArtifactHash,
                deliveredAt: this.clock.now(),
              },
            }
          : {}),
        recordedAt,
      });

      this.commitRows(
        request.runId,
        [
          this.pendingLedgerRow(ledgerStream, senderLedgerEvent),
          this.pendingChannelRow(channelEvent),
        ],
        () => {
          this.insertLedgerRow(senderLedgerEvent);
          this.insertChannelRow(channelEvent);
        },
      );

      const delivery: DeliveredChannelArtifact | null =
        request.deliveredArtifact === null
          ? null
          : {
              runId: request.runId,
              turn: request.turn,
              logicalSender: request.sender,
              carrier: request.carrier,
              publicArtifact: request.deliveredArtifact,
              channelEventHash: channelEvent.entryHash,
            };

      return { senderLedgerEvent, channelEvent, delivery };
    });
  }

  commitRejection(request: RejectionCommitRequest): Promise<ChannelEvent> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const head = this.chainHead(request.runId, 'channel');
      const channelEvent = await this.signChannelEvent({
        version: 1,
        runId: request.runId,
        sequence: head.size + 1,
        turn: request.turn,
        logicalSender: request.sender,
        origin: 'baby',
        carrier: request.carrier,
        communicationCondition: request.communicationCondition,
        publicArtifactHash: request.rejectedPayloadHash,
        previousChannelHash: head.lastEntryHash,
        gatewayValidationResult: 'rejected',
        reasonCode: request.reasonCode,
        recordedAt: this.clock.now(),
      });

      this.commitRows(
        request.runId,
        [this.pendingChannelRow(channelEvent)],
        () => {
          this.insertChannelRow(channelEvent);
        },
      );

      return channelEvent;
    });
  }

  commitControlArtifact(
    request: ControlArtifactCommitRequest,
  ): Promise<{ channelEvent: ChannelEvent; delivery: DeliveredChannelArtifact }> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const head = this.chainHead(request.runId, 'channel');
      const publicArtifactHash = hashCarrierMark(
        request.carrier,
        request.deliveredArtifact,
      );
      const channelEvent = await this.signChannelEvent({
        version: 1,
        runId: request.runId,
        sequence: head.size + 1,
        turn: request.turn,
        logicalSender: request.logicalSender,
        origin: 'gateway-control',
        carrier: request.carrier,
        communicationCondition: 'oracle',
        publicArtifactHash,
        previousChannelHash: head.lastEntryHash,
        gatewayValidationResult: 'accepted',
        deliveryReceipt: {
          recipient: request.recipient,
          deliveredArtifactHash: publicArtifactHash,
          deliveredAt: this.clock.now(),
        },
        recordedAt: this.clock.now(),
      });

      this.commitRows(
        request.runId,
        [this.pendingChannelRow(channelEvent)],
        () => {
          this.insertChannelRow(channelEvent);
        },
      );

      return {
        channelEvent,
        delivery: {
          runId: request.runId,
          turn: request.turn,
          logicalSender: request.logicalSender,
          carrier: request.carrier,
          publicArtifact: request.deliveredArtifact,
          channelEventHash: channelEvent.entryHash,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Single-stream appends
  // -------------------------------------------------------------------------

  async appendLedgerEvent(request: LedgerAppendRequest): Promise<LedgerEvent> {
    const draft = validateLedgerEventDraft(request.draft);
    if (
      draft.eventType === 'interpretation.recorded' &&
      request.channelEventHash === undefined
    ) {
      throw new InterpretationBindingError(
        'interpretation.recorded events must reference the delivered channelEventHash',
      );
    }

    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);
      if (request.channelEventHash !== undefined) {
        this.assertDeliveryBinding(
          request.runId,
          request.babyId,
          request.channelEventHash,
        );
      }

      const stream = ledgerStreamFor(roleForBabyId(request.babyId));
      const head = this.chainHead(request.runId, stream);
      const event = await this.signLedgerEvent({
        runId: request.runId,
        stream,
        babyId: request.babyId,
        sequence: head.size + 1,
        turn: request.turn,
        draft,
        previousEntryHash: head.lastEntryHash,
        channelEventHash: request.channelEventHash,
      });

      this.commitRows(
        request.runId,
        [this.pendingLedgerRow(stream, event)],
        () => {
          this.insertLedgerRow(event);
        },
      );

      return event;
    });
  }

  appendTurnRecord(request: TurnRecordAppendRequest): Promise<TurnRecord> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const head = this.chainHead(request.runId, 'turns');
      const signer = this.requireSigner('turns');
      const unsigned = {
        version: 1 as const,
        runId: request.runId,
        sequence: head.size + 1,
        turn: request.turn,
        phase: request.phase,
        roles: request.roles,
        communicationCondition: request.communicationCondition,
        scenarioRef: request.scenarioRef,
        scenarioStateHash: request.scenarioStateHash,
        observationHashes: request.observationHashes,
        babyProposalHash: request.babyProposalHash,
        deliveredArtifactHash: request.deliveredArtifactHash,
        channelEventHash: request.channelEventHash,
        actionHash: request.actionHash,
        outcomeHash: request.outcomeHash,
        outcome: request.outcome,
        previousEntryHash: head.lastEntryHash,
        recordedAt: this.clock.now(),
        writerKeyId: signer.keyId,
      };
      const entryHash = computeEntryHash('turns', unsigned);
      const record = TurnRecordSchema.parse({
        ...unsigned,
        entryHash,
        writerSignature: await signer.sign(entryHash),
      });

      const canonical = canonicalJson(record);
      this.commitRows(
        request.runId,
        [
          {
            stream: 'turns',
            sequence: record.sequence,
            entryHash: record.entryHash,
            canonicalJson: canonical,
          },
        ],
        () => {
          this.db
            .prepare(
              `INSERT INTO turn_records (
                 run_id, sequence, turn, phase, previous_entry_hash, entry_hash,
                 writer_key_id, writer_signature, recorded_at, canonical_json
               ) VALUES (
                 @runId, @sequence, @turn, @phase, @previousEntryHash, @entryHash,
                 @writerKeyId, @writerSignature, @recordedAt, @canonicalJson
               )`,
            )
            .run({
              runId: record.runId,
              sequence: record.sequence,
              turn: record.turn,
              phase: record.phase,
              previousEntryHash: record.previousEntryHash,
              entryHash: record.entryHash,
              writerKeyId: record.writerKeyId,
              writerSignature: record.writerSignature,
              recordedAt: record.recordedAt,
              canonicalJson: canonical,
            });
        },
      );

      return record;
    });
  }

  appendInterventionEvent(
    request: InterventionAppendRequest,
  ): Promise<InterventionEvent> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);
      return this.insertInterventionEvent(request);
    });
  }

  appendAuditLedgerEntry(
    request: AuditLedgerAppendRequest,
  ): Promise<AuditLedgerEntry> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const head = this.chainHead(request.runId, 'audit');
      const signer = this.requireSigner('audit');
      const unsigned = {
        version: 1 as const,
        runId: request.runId,
        sequence: head.size + 1,
        babyId: request.babyId,
        source: 'generated-analysis' as const,
        sourceEntryHash: request.sourceEntryHash,
        interpreterVersion: request.interpreterVersion,
        content: request.content,
        previousEntryHash: head.lastEntryHash,
        recordedAt: this.clock.now(),
        writerKeyId: signer.keyId,
      };
      const entryHash = computeEntryHash('audit', unsigned);
      const entry = AuditLedgerEntrySchema.parse({
        ...unsigned,
        entryHash,
        writerSignature: await signer.sign(entryHash),
      });

      const canonical = canonicalJson(entry);
      this.commitRows(
        request.runId,
        [
          {
            stream: 'audit',
            sequence: entry.sequence,
            entryHash: entry.entryHash,
            canonicalJson: canonical,
          },
        ],
        () => {
          this.db
            .prepare(
              `INSERT INTO audit_ledger_entries (
                 run_id, sequence, baby_id, source, source_entry_hash,
                 previous_entry_hash, entry_hash, writer_key_id,
                 writer_signature, recorded_at, canonical_json
               ) VALUES (
                 @runId, @sequence, @babyId, @source, @sourceEntryHash,
                 @previousEntryHash, @entryHash, @writerKeyId,
                 @writerSignature, @recordedAt, @canonicalJson
               )`,
            )
            .run({
              runId: entry.runId,
              sequence: entry.sequence,
              babyId: entry.babyId,
              source: entry.source,
              sourceEntryHash: entry.sourceEntryHash,
              previousEntryHash: entry.previousEntryHash,
              entryHash: entry.entryHash,
              writerKeyId: entry.writerKeyId,
              writerSignature: entry.writerSignature,
              recordedAt: entry.recordedAt,
              canonicalJson: canonical,
            });
        },
      );

      return entry;
    });
  }

  /** Extension beyond `EvidenceWriter`; see {@link AffectAppendRequest}. */
  appendAffectEvent(request: AffectAppendRequest): Promise<AffectEvent> {
    return this.mutex.run(async () => {
      this.assertWritableRun(request.runId);

      const head = this.chainHead(request.runId, 'affect');
      const signer = this.requireSigner('affect');
      const unsigned = {
        version: 1 as const,
        runId: request.runId,
        sequence: head.size + 1,
        turn: request.turn,
        windowId: request.windowId,
        sender: request.sender,
        displayId: request.displayId,
        affectMode: request.affectMode,
        deliveredAt: request.deliveredAt,
        previousEntryHash: head.lastEntryHash,
        recordedAt: this.clock.now(),
        writerKeyId: signer.keyId,
      };
      const entryHash = computeEntryHash('affect', unsigned);
      const event = AffectEventSchema.parse({
        ...unsigned,
        entryHash,
        writerSignature: await signer.sign(entryHash),
      });

      const canonical = canonicalJson(event);
      this.commitRows(
        request.runId,
        [
          {
            stream: 'affect',
            sequence: event.sequence,
            entryHash: event.entryHash,
            canonicalJson: canonical,
          },
        ],
        () => {
          this.db
            .prepare(
              `INSERT INTO affect_events (
                 run_id, sequence, turn, sender, display_id, affect_mode,
                 previous_entry_hash, entry_hash, writer_key_id,
                 writer_signature, recorded_at, canonical_json
               ) VALUES (
                 @runId, @sequence, @turn, @sender, @displayId, @affectMode,
                 @previousEntryHash, @entryHash, @writerKeyId,
                 @writerSignature, @recordedAt, @canonicalJson
               )`,
            )
            .run({
              runId: event.runId,
              sequence: event.sequence,
              turn: event.turn,
              sender: event.sender,
              displayId: event.displayId,
              affectMode: event.affectMode,
              previousEntryHash: event.previousEntryHash,
              entryHash: event.entryHash,
              writerKeyId: event.writerKeyId,
              writerSignature: event.writerSignature,
              recordedAt: event.recordedAt,
              canonicalJson: canonical,
            });
        },
      );

      return event;
    });
  }

  // -------------------------------------------------------------------------
  // Checkpoints, anchors, experiment records
  // -------------------------------------------------------------------------

  insertCheckpointManifest(manifest: CheckpointManifest): void {
    const parsed = CheckpointManifestSchema.parse(manifest);
    const runId = this.runIdForHash(parsed.runIdHash);
    this.assertWritableRun(runId);

    const expectedHash = hashCanonical(
      HASH_DOMAINS.checkpoint,
      omit(parsed, MANIFEST_SIGNATURE_FIELDS),
    );
    if (expectedHash !== parsed.checkpointHash) {
      throw new CheckpointChainError(
        `checkpointHash ${parsed.checkpointHash} does not match the manifest content (${expectedHash})`,
      );
    }

    const previous = this.db
      .prepare<[string], { checkpoint_hash: string; checkpoint_sequence: number }>(
        `SELECT checkpoint_hash, checkpoint_sequence FROM checkpoint_manifests
          WHERE run_id = ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
      )
      .get(runId);
    const expectedPrevious = previous?.checkpoint_hash ?? GENESIS_HASH;
    if (parsed.previousCheckpointHash !== expectedPrevious) {
      throw new CheckpointChainError(
        `previousCheckpointHash must be ${expectedPrevious}, received ${parsed.previousCheckpointHash}`,
      );
    }
    const expectedSequence = previous === undefined ? 0 : previous.checkpoint_sequence + 1;
    if (parsed.checkpointSequence !== expectedSequence) {
      throw new CheckpointChainError(
        `checkpointSequence must be ${expectedSequence}, received ${parsed.checkpointSequence}`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO checkpoint_manifests (
           run_id, checkpoint_sequence, checkpoint_hash, previous_checkpoint_hash,
           witness_key_id, witness_signature, created_at, canonical_json
         ) VALUES (
           @runId, @checkpointSequence, @checkpointHash, @previousCheckpointHash,
           @witnessKeyId, @witnessSignature, @createdAt, @canonicalJson
         )`,
      )
      .run({
        runId,
        checkpointSequence: parsed.checkpointSequence,
        checkpointHash: parsed.checkpointHash,
        previousCheckpointHash: parsed.previousCheckpointHash,
        witnessKeyId: parsed.witnessKeyId,
        witnessSignature: parsed.witnessSignature,
        createdAt: parsed.createdAt,
        canonicalJson: canonicalJson(parsed),
      });
  }

  insertAnchorReceipt(receipt: AnchorReceipt): void {
    const parsed = AnchorReceiptSchema.parse(receipt);
    this.assertWritableRun(parsed.runId);

    const chainId = parsed.chainId;
    this.db
      .prepare(
        `INSERT INTO anchor_receipts (
           run_id, checkpoint_hash, chain_id, transaction_hash, block_number,
           status, finality_policy, recorded_at, canonical_json
         ) VALUES (
           @runId, @checkpointHash, @chainId, @transactionHash, @blockNumber,
           @status, @finalityPolicy, @recordedAt, @canonicalJson
         )`,
      )
      .run({
        runId: parsed.runId,
        checkpointHash: parsed.checkpointHash,
        chainId,
        transactionHash: parsed.transactionHash,
        blockNumber: parsed.blockNumber,
        status: parsed.status,
        finalityPolicy: parsed.finalityPolicy,
        recordedAt: parsed.recordedAt,
        canonicalJson: canonicalJson(parsed),
      });
  }

  appendExperimentRecord(record: ExperimentRecord): void {
    const parsed = ExperimentRecordSchema.parse(record);
    this.assertWritableRun(parsed.runId);

    const last = this.db
      .prepare<[string], { record_version: number }>(
        `SELECT record_version FROM experiment_records
          WHERE run_id = ? ORDER BY record_version DESC LIMIT 1`,
      )
      .get(parsed.runId);
    const expected = (last?.record_version ?? 0) + 1;
    if (parsed.recordVersion !== expected) {
      throw new ExperimentRecordVersionError(expected, parsed.recordVersion);
    }

    this.db
      .prepare(
        `INSERT INTO experiment_records (
           run_id, record_version, experiment_id, disposition,
           checkpoint_manifest_ref, anchor_tx_ref, verifier_report_ref,
           recorded_at, canonical_json
         ) VALUES (
           @runId, @recordVersion, @experimentId, @disposition,
           @checkpointManifestRef, @anchorTxRef, @verifierReportRef,
           @recordedAt, @canonicalJson
         )`,
      )
      .run({
        runId: parsed.runId,
        recordVersion: parsed.recordVersion,
        experimentId: parsed.experimentId,
        disposition: parsed.disposition,
        checkpointManifestRef: parsed.checkpointManifestRef,
        anchorTxRef: parsed.anchorTxRef,
        verifierReportRef: parsed.verifierReportRef,
        recordedAt: this.clock.now(),
        canonicalJson: canonicalJson(parsed),
      });
  }

  // -------------------------------------------------------------------------
  // Recovery and fork handling (LEDGER §15)
  // -------------------------------------------------------------------------

  /**
   * Re-verifies the whole committed prefix of every stream of a run without
   * touching a single row: recomputes each entry hash from the stored
   * canonical JSON, walks the previous-hash links from genesis, verifies each
   * writer signature against the public key recorded in `run_signers`,
   * cross-checks every stream against the last checkpoint manifest, and
   * reports every preserved fork. A run with any finding is blocked for
   * writing until {@link acknowledgeIntegrityReview}.
   *
   * LEDGER §15 ("load the last valid entry **and checkpoint hashes**; verify
   * the committed prefix before accepting new writes; … never truncate or
   * reuse a sequence number"): a walk of the surviving rows alone cannot see
   * a lost tail, because the shortened prefix is internally perfect —
   * sequence density, previous-hash links and signatures all still hold.
   * Only the checkpoint the store already holds knows how long the committed
   * prefix was, so {@link checkpointPrefixViolations} is what stops the
   * writer from re-issuing a sequence number a checkpoint already bound to a
   * different entry hash.
   */
  async recover(runId: string): Promise<RecoveryReport> {
    if (!this.readRunMetadata(runId)) {
      throw new UnknownRunError(runId);
    }

    const chainViolations: string[] = [];
    const heads: ChainHead[] = [];
    const rowsByStream = new Map<EventStream, StreamRow[]>();
    const publicKeys = new Map(
      this.readRunSigners(runId).map((signer) => [signer.domain, signer]),
    );

    for (const stream of EVENT_STREAMS) {
      const rows = this.streamRows(runId, stream);
      rowsByStream.set(stream, rows);
      heads.push(this.chainHead(runId, stream));
      let previous = GENESIS_HASH;

      for (const [index, row] of rows.entries()) {
        const label = `${stream}#${row.sequence}`;
        if (row.sequence !== index + 1) {
          chainViolations.push(
            `${label}: expected sequence ${index + 1}, stored ${row.sequence}`,
          );
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(row.canonical_json) as Record<string, unknown>;
        } catch {
          chainViolations.push(`${label}: canonical_json is not valid JSON`);
          previous = row.entry_hash;
          continue;
        }

        if (canonicalJson(event) !== row.canonical_json) {
          chainViolations.push(`${label}: canonical_json is not RFC 8785 canonical`);
        }

        const recomputed = computeEntryHash(stream, event);
        if (recomputed !== row.entry_hash) {
          chainViolations.push(
            `${label}: entry hash mismatch (stored ${row.entry_hash}, recomputed ${recomputed})`,
          );
        }
        if (event.entryHash !== row.entry_hash) {
          chainViolations.push(`${label}: stored entryHash disagrees with the row`);
        }
        if (row.previous_hash !== previous) {
          chainViolations.push(
            `${label}: previous hash ${row.previous_hash} does not chain to ${previous}`,
          );
        }

        if (STREAM_TABLES[stream].signed) {
          const domain = STREAM_SIGNER[stream as Exclude<EventStream, 'intervention'>];
          const signer = publicKeys.get(domain);
          const signature = event.writerSignature;
          if (!signer) {
            chainViolations.push(
              `${label}: no public key recorded for signer domain ${domain}`,
            );
          } else if (typeof signature !== 'string') {
            chainViolations.push(`${label}: missing writerSignature`);
          } else if (
            !verifyHashSignature(row.entry_hash, signature, signer.publicKey)
          ) {
            chainViolations.push(
              `${label}: writer signature does not verify under ${signer.keyId}`,
            );
          } else if (event.writerKeyId !== signer.keyId) {
            chainViolations.push(
              `${label}: writerKeyId ${String(event.writerKeyId)} is not ${signer.keyId}`,
            );
          }
        }

        previous = row.entry_hash;
      }
    }

    chainViolations.push(...this.checkpointPrefixViolations(runId, rowsByStream));

    const { forks, violations } = this.collectForks(runId);
    chainViolations.push(...violations);
    const ok = chainViolations.length === 0 && forks.length === 0;

    if (ok) {
      this.integrityBlocks.delete(runId);
    } else {
      this.integrityBlocks.set(runId, [
        ...chainViolations,
        ...forks.map(
          (fork) => `fork ${fork.stream}#${fork.sequence}: ${fork.entryHashes.join(' vs ')}`,
        ),
      ]);
    }

    return { runId, ok, heads, forks, chainViolations };
  }

  /**
   * LEDGER §15: the only way to clear a fork/violation block. The reviewer is
   * recorded as a `governance-decision` intervention event so the decision is
   * itself part of the evidence.
   */
  async acknowledgeIntegrityReview(
    runId: string,
    reviewer: string,
  ): Promise<InterventionEvent> {
    if (!this.readRunMetadata(runId)) {
      throw new UnknownRunError(runId);
    }
    if (reviewer.trim().length === 0) {
      throw new InvalidRequestError('An integrity review requires a reviewer id');
    }

    const reasons = this.integrityBlocks.get(runId) ?? [];
    return this.mutex.run(async () => {
      this.integrityBlocks.delete(runId);
      return this.insertInterventionEvent({
        runId,
        eventType: 'governance-decision',
        actorId: reviewer,
        reasonCode: 'integrity-review-acknowledged',
        details: { reviewer, acknowledgedFindings: reasons },
      });
    });
  }

  /** Findings of the last {@link recover} call, empty when the run is writable. */
  integrityFindings(runId: string): string[] {
    return [...(this.integrityBlocks.get(runId) ?? [])];
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireSigner(stream: Exclude<EventStream, 'intervention'>) {
    return this.signers.signer(STREAM_SIGNER[stream]);
  }

  private assertWritableRun(runId: string): void {
    if (!this.readRunMetadata(runId)) {
      throw new UnknownRunError(runId);
    }
    const reasons = this.integrityBlocks.get(runId);
    if (reasons && reasons.length > 0) {
      throw new IntegrityBlockedError(runId, reasons);
    }
    if (runId !== this.signers.runId) {
      throw new InvalidRequestError(
        `Signer registry is bound to run ${this.signers.runId}, not ${runId}`,
      );
    }
  }

  /** SPEC §11.3: the echoed hash must name a delivery addressed to this Baby. */
  private assertDeliveryBinding(
    runId: string,
    babyId: 'A' | 'B',
    channelEventHash: Sha256Hash,
  ): void {
    const row = this.db
      .prepare<[string, string], { canonical_json: string }>(
        'SELECT canonical_json FROM channel_events WHERE run_id = ? AND entry_hash = ?',
      )
      .get(runId, channelEventHash);
    if (!row) {
      throw new InterpretationBindingError(
        `No channel event ${channelEventHash} is committed for run ${runId}`,
      );
    }

    const event = ChannelEventSchema.parse(JSON.parse(row.canonical_json));
    const expected = roleForBabyId(babyId);
    if (event.deliveryReceipt?.recipient !== expected) {
      throw new InterpretationBindingError(
        `Channel event ${channelEventHash} was not delivered to ${expected}`,
      );
    }
  }

  private buildContent(draft: LedgerEventDraft): Record<string, unknown> {
    return draft.evidenceRefs.length > 0
      ? { ...draft.content, evidenceRefs: draft.evidenceRefs }
      : { ...draft.content };
  }

  private async signLedgerEvent(input: {
    runId: string;
    stream: Exclude<EventStream, 'intervention'>;
    babyId: 'A' | 'B';
    sequence: number;
    turn: number;
    draft: LedgerEventDraft;
    previousEntryHash: Sha256Hash;
    channelEventHash?: Sha256Hash;
  }): Promise<LedgerEvent> {
    const signer = this.requireSigner(input.stream);
    const unsigned = {
      version: 1 as const,
      runId: input.runId,
      babyId: input.babyId,
      sequence: input.sequence,
      turn: input.turn,
      eventType: input.draft.eventType,
      contentSchema: input.draft.contentSchema,
      subjectId: input.draft.subjectId,
      content: this.buildContent(input.draft),
      blindingNonce: input.draft.blindingNonce,
      previousEntryHash: input.previousEntryHash,
      ...(input.channelEventHash === undefined
        ? {}
        : { channelEventHash: input.channelEventHash }),
      recordedAt: this.clock.now(),
      writerKeyId: signer.keyId,
    };
    const entryHash = computeEntryHash(input.stream, unsigned);
    return LedgerEventSchema.parse({
      ...unsigned,
      entryHash,
      writerSignature: await signer.sign(entryHash),
    });
  }

  private async signChannelEvent(
    unsigned: Omit<ChannelEvent, 'entryHash' | 'writerSignature' | 'writerKeyId'>,
  ): Promise<ChannelEvent> {
    const signer = this.requireSigner('channel');
    const withKey = { ...unsigned, writerKeyId: signer.keyId };
    const entryHash = computeEntryHash('channel', withKey);
    return ChannelEventSchema.parse({
      ...withKey,
      entryHash,
      writerSignature: await signer.sign(entryHash),
    });
  }

  private async insertInterventionEvent(
    request: InterventionAppendRequest,
  ): Promise<InterventionEvent> {
    const head = this.chainHead(request.runId, 'intervention');
    const unsigned = {
      version: 1 as const,
      runId: request.runId,
      sequence: head.size + 1,
      eventType: request.eventType,
      actorId: request.actorId,
      reasonCode: request.reasonCode,
      details: request.details ?? {},
      previousEntryHash: head.lastEntryHash,
      recordedAt: this.clock.now(),
    };
    const event = InterventionEventSchema.parse({
      ...unsigned,
      entryHash: computeEntryHash('intervention', unsigned),
    });

    const canonical = canonicalJson(event);
    this.commitRows(
      request.runId,
      [
        {
          stream: 'intervention',
          sequence: event.sequence,
          entryHash: event.entryHash,
          canonicalJson: canonical,
        },
      ],
      () => {
        this.db
          .prepare(
            `INSERT INTO intervention_log (
               run_id, sequence, event_type, actor_id, reason_code,
               previous_entry_hash, entry_hash, recorded_at, canonical_json
             ) VALUES (
               @runId, @sequence, @eventType, @actorId, @reasonCode,
               @previousEntryHash, @entryHash, @recordedAt, @canonicalJson
             )`,
          )
          .run({
            runId: event.runId,
            sequence: event.sequence,
            eventType: event.eventType,
            actorId: event.actorId,
            reasonCode: event.reasonCode,
            previousEntryHash: event.previousEntryHash,
            entryHash: event.entryHash,
            recordedAt: event.recordedAt,
            canonicalJson: canonical,
          });
      },
    );

    return event;
  }

  private insertLedgerRow(event: LedgerEvent): void {
    this.db
      .prepare(
        `INSERT INTO ledger_events (
           run_id, baby_id, sequence, turn, event_type, content_schema,
           previous_entry_hash, channel_event_hash, entry_hash, writer_key_id,
           writer_signature, recorded_at, canonical_json
         ) VALUES (
           @runId, @babyId, @sequence, @turn, @eventType, @contentSchema,
           @previousEntryHash, @channelEventHash, @entryHash, @writerKeyId,
           @writerSignature, @recordedAt, @canonicalJson
         )`,
      )
      .run({
        runId: event.runId,
        babyId: event.babyId,
        sequence: event.sequence,
        turn: event.turn,
        eventType: event.eventType,
        contentSchema: event.contentSchema,
        previousEntryHash: event.previousEntryHash,
        channelEventHash: event.channelEventHash ?? null,
        entryHash: event.entryHash,
        writerKeyId: event.writerKeyId,
        writerSignature: event.writerSignature,
        recordedAt: event.recordedAt,
        canonicalJson: canonicalJson(event),
      });
  }

  private insertChannelRow(event: ChannelEvent): void {
    this.db
      .prepare(
        `INSERT INTO channel_events (
           run_id, sequence, turn, logical_sender, origin,
           communication_condition, baby_proposal_hash, sender_ledger_sequence,
           sender_entry_hash, public_artifact_hash, previous_channel_hash,
           validation_result, entry_hash, writer_key_id, writer_signature,
           recorded_at, canonical_json
         ) VALUES (
           @runId, @sequence, @turn, @logicalSender, @origin,
           @communicationCondition, @babyProposalHash, @senderLedgerSequence,
           @senderEntryHash, @publicArtifactHash, @previousChannelHash,
           @validationResult, @entryHash, @writerKeyId, @writerSignature,
           @recordedAt, @canonicalJson
         )`,
      )
      .run({
        runId: event.runId,
        sequence: event.sequence,
        turn: event.turn,
        logicalSender: event.logicalSender,
        origin: event.origin,
        communicationCondition: event.communicationCondition,
        babyProposalHash: event.babyProposalHash ?? null,
        senderLedgerSequence: event.senderLedgerSequence ?? null,
        senderEntryHash: event.senderEntryHash ?? null,
        publicArtifactHash: event.publicArtifactHash,
        previousChannelHash: event.previousChannelHash,
        validationResult: event.gatewayValidationResult,
        entryHash: event.entryHash,
        writerKeyId: event.writerKeyId,
        writerSignature: event.writerSignature,
        recordedAt: event.recordedAt,
        canonicalJson: canonicalJson(event),
      });
  }

  private pendingLedgerRow(
    stream: EventStream,
    event: LedgerEvent,
  ): PendingRow {
    return {
      stream,
      sequence: event.sequence,
      entryHash: event.entryHash,
      canonicalJson: canonicalJson(event),
    };
  }

  private pendingChannelRow(event: ChannelEvent): PendingRow {
    return {
      stream: 'channel',
      sequence: event.sequence,
      entryHash: event.entryHash,
      canonicalJson: canonicalJson(event),
    };
  }

  /**
   * Runs all inserts of one logical commit in a single SQLite transaction and
   * turns a uniqueness conflict into either an idempotent-duplicate error or
   * a fork (LEDGER §15), preserving both artifacts.
   */
  private commitRows(
    runId: string,
    rows: PendingRow[],
    insert: () => void,
  ): void {
    try {
      this.db.transaction(insert)();
    } catch (error) {
      if (error instanceof EvidenceWriterError || !isUniquenessConflict(error)) {
        throw error;
      }
      this.classifyConflict(runId, rows);
      throw error;
    }
  }

  private classifyConflict(runId: string, rows: PendingRow[]): void {
    const duplicates: PendingRow[] = [];

    for (const row of rows) {
      const spec = STREAM_TABLES[row.stream];
      const existing = this.db
        .prepare<unknown[], { entry_hash: string; canonical_json: string }>(
          `SELECT entry_hash, canonical_json FROM ${spec.table}
            WHERE ${streamFilter(row.stream)} AND sequence = ?`,
        )
        .get(...streamKey(runId, row.stream), row.sequence);

      if (existing && existing.entry_hash !== row.entryHash) {
        this.preserveFork(runId, row, existing);
        const entryHashes = [existing.entry_hash, row.entryHash];
        this.integrityBlocks.set(runId, [
          `fork ${row.stream}#${row.sequence}: ${entryHashes.join(' vs ')}`,
        ]);
        throw new ForkDetectedError(row.stream, row.sequence, entryHashes);
      }

      if (existing) {
        duplicates.push(row);
        continue;
      }

      const sameHash = this.db
        .prepare<[string], { sequence: number }>(
          `SELECT sequence FROM ${spec.table} WHERE entry_hash = ?`,
        )
        .get(row.entryHash);
      if (sameHash) {
        duplicates.push(row);
      }
    }

    const duplicate = duplicates[0];
    if (duplicate) {
      throw new DuplicateEventError(
        duplicate.stream,
        duplicate.sequence,
        duplicate.entryHash,
      );
    }
  }

  private preserveFork(
    runId: string,
    row: PendingRow,
    existing: { entry_hash: string; canonical_json: string },
  ): void {
    const detectedAt = this.clock.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO fork_artifacts (
         run_id, stream, sequence, entry_hash, canonical_json, detected_at
       ) VALUES (@runId, @stream, @sequence, @entryHash, @canonicalJson, @detectedAt)`,
    );
    this.db.transaction(() => {
      insert.run({
        runId,
        stream: row.stream,
        sequence: row.sequence,
        entryHash: existing.entry_hash,
        canonicalJson: existing.canonical_json,
        detectedAt,
      });
      insert.run({
        runId,
        stream: row.stream,
        sequence: row.sequence,
        entryHash: row.entryHash,
        canonicalJson: row.canonicalJson,
        detectedAt,
      });
    })();
  }

  /**
   * Verifies every stream against the highest checkpoint manifest the store
   * holds for the run (LEDGER §15; SPEC §7.3 "on restart, the runtime MUST
   * load the last valid entry/checkpoint hashes, verify the committed prefix,
   * continue with the next sequence number … sequence numbers are never
   * reused or truncated").
   *
   * For each mandatory tree (`babyA`, `babyB`, `channel`) and each auxiliary
   * tree the manifest actually carries, the current stream must be at least
   * `treeSize` entries long and must still store the committed
   * `lastEntryHash` at sequence `treeSize`. A shortfall means the checkpointed
   * prefix no longer exists, and a mismatch at that sequence means the
   * prefix was rewritten; both are chain violations, so the run is
   * integrity-blocked and `assertWritableRun` refuses every further append
   * until a research-integrity review is recorded. That is what keeps a
   * checkpointed sequence number from being handed out a second time.
   *
   * A manifest committing an empty tree (`treeSize === 0`) constrains
   * nothing and is skipped. Recovery reports, never raises: a manifest row
   * that no longer parses becomes a violation rather than an exception.
   */
  private checkpointPrefixViolations(
    runId: string,
    rowsByStream: ReadonlyMap<EventStream, readonly StreamRow[]>,
  ): string[] {
    const row = this.db
      .prepare<
        [string],
        { checkpoint_sequence: number; canonical_json: string }
      >(
        `SELECT checkpoint_sequence, canonical_json FROM checkpoint_manifests
          WHERE run_id = ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
      )
      .get(runId);

    if (!row) {
      return [];
    }

    const violations: string[] = [];
    let manifest: CheckpointManifest;
    try {
      manifest = CheckpointManifestSchema.parse(JSON.parse(row.canonical_json));
    } catch {
      violations.push(
        `checkpoint #${row.checkpoint_sequence}: canonical_json is not a valid checkpoint manifest`,
      );
      return violations;
    }

    const label = `checkpoint #${manifest.checkpointSequence}`;
    const check = (
      stream: EventStream,
      treeName: string,
      reference: TreeReference,
    ): void => {
      if (reference.treeSize === 0) {
        return;
      }
      const rows = rowsByStream.get(stream) ?? [];
      if (rows.length < reference.treeSize) {
        violations.push(
          `${label}: ${treeName} commits treeSize ${reference.treeSize} but ${stream} now holds ${rows.length} entries`,
        );
        return;
      }
      const committed = rows.find(
        (candidate) => candidate.sequence === reference.treeSize,
      );
      if (!committed) {
        violations.push(
          `${label}: ${treeName} commits ${stream}#${reference.treeSize}, which is missing`,
        );
        return;
      }
      if (committed.entry_hash !== reference.lastEntryHash) {
        violations.push(
          `${label}: ${treeName} commits lastEntryHash ${reference.lastEntryHash} at ${stream}#${reference.treeSize}, which now stores ${committed.entry_hash}`,
        );
      }
    };

    for (const [stream, treeName] of MANDATORY_TREE_STREAMS) {
      check(stream, treeName, manifest[treeName]);
    }

    for (const [treeName, reference] of Object.entries(
      manifest.auxiliaryTrees,
    )) {
      const stream = STREAM_FOR_AUXILIARY_TREE.get(treeName);
      if (stream === undefined) {
        violations.push(`${label}: commits unknown auxiliary tree ${treeName}`);
        continue;
      }
      check(stream, treeName, reference);
    }

    return violations;
  }

  /**
   * Groups the preserved fork artifacts of a run into one report per forked
   * sequence (LEDGER §15).
   *
   * The stream guard uses {@link isEventStream} rather than the `in`
   * operator: `'constructor' in STREAM_TABLES` is true for any object
   * literal, so an `in` check admits every `Object.prototype` key, and
   * `STREAM_TABLES['constructor']` is `undefined`, which used to be
   * interpolated straight into `FROM undefined` and made `recover()` raise a
   * `SqliteError` instead of returning a report. Recovery reports malformed
   * input, it never raises on it, so an out-of-domain `stream` becomes a
   * chain violation (which blocks the run) and the artifact is skipped.
   */
  private collectForks(runId: string): {
    forks: ForkReport[];
    violations: string[];
  } {
    const grouped = new Map<string, ForkReport>();
    const violations: string[] = [];

    for (const artifact of this.readForkArtifacts(runId)) {
      if (!isEventStream(artifact.stream)) {
        violations.push(
          `fork artifact ${artifact.stream}#${artifact.sequence}: ${artifact.stream} is not a known event stream`,
        );
        continue;
      }
      const stream: EventStream = artifact.stream;
      const key = `${artifact.stream}#${artifact.sequence}`;
      const report = grouped.get(key) ?? {
        stream,
        sequence: artifact.sequence,
        entryHashes: [],
      };
      if (!report.entryHashes.includes(artifact.entryHash)) {
        report.entryHashes.push(artifact.entryHash);
      }
      grouped.set(key, report);
    }

    for (const report of grouped.values()) {
      const spec = STREAM_TABLES[report.stream];
      const committed = this.db
        .prepare<unknown[], { entry_hash: string }>(
          `SELECT entry_hash FROM ${spec.table}
            WHERE ${streamFilter(report.stream)} AND sequence = ?`,
        )
        .get(...streamKey(runId, report.stream), report.sequence);
      if (committed && !report.entryHashes.includes(committed.entry_hash)) {
        report.entryHashes.push(committed.entry_hash);
      }
      report.entryHashes.sort();
    }

    const forks = [...grouped.values()].sort((left, right) =>
      left.stream === right.stream
        ? left.sequence - right.sequence
        : left.stream.localeCompare(right.stream),
    );
    return { forks, violations };
  }

  private streamRows(
    runId: string,
    stream: EventStream,
    range?: EventRange,
  ): StreamRow[] {
    const spec = STREAM_TABLES[stream];
    const parameters: unknown[] = streamKey(runId, stream);
    let sql = `SELECT sequence, entry_hash, ${spec.previousColumn} AS previous_hash,
                      recorded_at, canonical_json
                 FROM ${spec.table}
                WHERE ${streamFilter(stream)}`;

    if (range?.fromSequence !== undefined) {
      sql += ' AND sequence >= ?';
      parameters.push(range.fromSequence);
    }
    if (range?.toSequence !== undefined) {
      sql += ' AND sequence <= ?';
      parameters.push(range.toSequence);
    }
    sql += ' ORDER BY sequence';

    return this.db.prepare<unknown[], StreamRow>(sql).all(...parameters);
  }

  /**
   * `CheckpointManifest` binds a run by `runIdHash` only (LEDGER §8), so the
   * writer maps it back to the local run id it was registered under.
   */
  private runIdForHash(runIdHash: Sha256Hash): string {
    for (const runId of this.listRuns()) {
      if (domainHash(HASH_DOMAINS.runId, runId) === runIdHash) {
        return runId;
      }
    }
    throw new UnknownRunError(runIdHash);
  }
}

function omit(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const field of fields) {
    delete copy[field];
  }
  return copy;
}
