/**
 * `InMemoryEvidenceWriter` — a faithful, dependency-free `EvidenceWriter`
 * for Gateway and Nursery Controller tests.
 *
 * It is not a mock: it assigns per-stream sequences, builds the same unsigned
 * events the SQLite writer builds, computes real entry hashes with
 * `computeEntryHash`, signs them with a real Ed25519 registry, validates
 * every event against its zod schema, and enforces the LEDGER §4 hash chain
 * and the SPEC §11.3 interpretation binding. What it does *not* do is
 * persist, checkpoint, or serialize concurrent writers — the production
 * `SqliteEvidenceWriter` in `@ald/evidence` owns all of that.
 *
 * The Gateway talks to the Evidence Writer only through the contract, so a
 * test that passes here exercises the same code path as production
 * (SPEC §4.2 Symbol Gateway ⇄ Evidence Writer boundary).
 */
import {
  AffectEventSchema,
  AnchorReceiptSchema,
  AuditLedgerEntrySchema,
  babyIdForRole,
  ChannelEventSchema,
  CheckpointManifestSchema,
  EVENT_STREAMS,
  ExperimentRecordSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  InterventionEventSchema,
  LedgerEventSchema,
  ledgerStreamForRole,
  roleForBabyId,
  RunConfigSchema,
  STREAM_SIGNER,
  TurnRecordSchema,
  type AffectAppendRequest,
  type AffectEvent,
  type AnchorReceipt,
  type AuditLedgerAppendRequest,
  type AuditLedgerEntry,
  type BabyId,
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
  type TurnCommitRequest,
  type TurnCommitResult,
  type TurnRecord,
  type TurnRecordAppendRequest,
} from '@ald/types';
import {
  canonicalJson,
  computeEntryHash,
  hashCanonical,
  hashCarrierMark,
  hashRunId,
  InMemorySignerRegistry,
} from '@ald/hashing';
import { validateLedgerEventDraft } from '@ald/evidence';

/** Deterministic clock: one step per call from a fixed epoch. */
export class StepClock implements Clock {
  private current: number;

  constructor(
    startMs = Date.UTC(2026, 0, 1, 0, 0, 0),
    private readonly stepMs = 1,
  ) {
    this.current = startMs;
  }

  now(): string {
    const value = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return value;
  }
}

export interface InMemoryEvidenceWriterOptions {
  signers: SignerRegistry;
  clock?: Clock;
  softwareCommit?: string;
}

/** Raised for a request the writer refuses; mirrors `@ald/evidence` codes. */
export class InMemoryEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InMemoryEvidenceError';
  }
}

interface StoredRecord extends StoredEvent {
  runId: string;
}

type LedgerStream = 'baby-a-ledger' | 'baby-b-ledger';

/**
 * `ledgerStreamForRole` is declared as returning the whole `EventStream`
 * union, so it cannot be handed straight to a signer lookup that excludes the
 * unsigned `intervention` stream. Narrowing happens here rather than in
 * `@ald/types`.
 */
function ledgerStreamOf(role: BabyRole): LedgerStream {
  return ledgerStreamForRole(role) as LedgerStream;
}

export class InMemoryEvidenceWriter implements EvidenceWriter {
  private readonly clock: Clock;
  private readonly signers: SignerRegistry;
  private readonly records: StoredRecord[] = [];
  private readonly runs = new Map<string, RunMetadataRecord>();
  private readonly channelEventsByHash = new Map<string, ChannelEvent>();
  private readonly checkpoints: CheckpointManifest[] = [];
  private readonly anchors: AnchorReceipt[] = [];
  private readonly experiments: ExperimentRecord[] = [];
  /** Serializes the async sign-then-append sequence, as the writer mutex does. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: InMemoryEvidenceWriterOptions) {
    this.signers = options.signers;
    this.clock = options.clock ?? new StepClock();
  }

  /** Convenience factory: a fresh generated signer registry for one run. */
  static forRun(runId: string, clock?: Clock): InMemoryEvidenceWriter {
    return new InMemoryEvidenceWriter({
      signers: InMemorySignerRegistry.generate(runId),
      ...(clock === undefined ? {} : { clock }),
    });
  }

  get signerRegistry(): SignerRegistry {
    return this.signers;
  }

  // -------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------

  listRuns(): string[] {
    return [...this.runs.keys()].sort();
  }

  readRunMetadata(runId: string): RunMetadataRecord | undefined {
    return this.runs.get(runId);
  }

  chainHead(runId: string, stream: EventStream): ChainHead {
    const events = this.streamRecords(runId, stream);
    const last = events[events.length - 1];
    return {
      stream,
      size: events.length,
      lastEntryHash: last?.entryHash ?? GENESIS_HASH,
    };
  }

  readEvents(
    runId: string,
    stream: EventStream,
    range?: EventRange,
  ): StoredEvent[] {
    return this.streamRecords(runId, stream).filter(
      (record) =>
        (range?.fromSequence === undefined ||
          record.sequence >= range.fromSequence) &&
        (range?.toSequence === undefined || record.sequence <= range.toSequence),
    );
  }

  readCheckpoints(runId: string): CheckpointManifest[] {
    return this.checkpoints.filter(
      (manifest) => manifest.runIdHash === hashRunId(runId),
    );
  }

  readAnchorReceipts(runId: string): AnchorReceipt[] {
    return this.anchors.filter((receipt) => receipt.runId === runId);
  }

  readExperimentRecords(runId: string): ExperimentRecord[] {
    return this.experiments.filter((record) => record.runId === runId);
  }

  /** Every committed channel event of a run, in sequence order. */
  channelEvents(runId: string): ChannelEvent[] {
    return this.readEvents(runId, 'channel').map(
      (record) => ChannelEventSchema.parse(JSON.parse(record.canonicalJson)),
    );
  }

  /** Every committed intervention event of a run, in sequence order. */
  interventionEvents(runId: string): InterventionEvent[] {
    return this.readEvents(runId, 'intervention').map(
      (record) => InterventionEventSchema.parse(JSON.parse(record.canonicalJson)),
    );
  }

  /** Every committed ledger event of one Baby, in sequence order. */
  ledgerEvents(runId: string, babyId: BabyId): LedgerEvent[] {
    return this.readEvents(
      runId,
      ledgerStreamOf(roleForBabyId(babyId)),
    ).map((record) => LedgerEventSchema.parse(JSON.parse(record.canonicalJson)));
  }

  // -------------------------------------------------------------------------
  // Write side
  // -------------------------------------------------------------------------

  registerRun(config: RunConfig): { configurationHash: Sha256Hash } {
    const parsed = RunConfigSchema.parse(config);
    if (parsed.runId !== this.signers.runId) {
      throw new InMemoryEvidenceError(
        'invalid-request',
        `Signer registry is bound to run ${this.signers.runId}, not ${parsed.runId}`,
      );
    }
    if (this.runs.has(parsed.runId)) {
      throw new InMemoryEvidenceError(
        'duplicate-run',
        `Run ${parsed.runId} is already registered`,
      );
    }

    const configurationHash = hashCanonical(HASH_DOMAINS.runConfig, parsed);
    this.runs.set(parsed.runId, {
      runId: parsed.runId,
      createdAt: this.clock.now(),
      deploymentMode: parsed.deploymentMode,
      configurationHash,
      configurationJson: canonicalJson(parsed),
      parentRunId: parsed.parentRunId ?? null,
      derivedFromCheckpointHash: parsed.derivedFromCheckpointHash ?? null,
    });
    return { configurationHash };
  }

  commitTurn(request: TurnCommitRequest): Promise<TurnCommitResult> {
    const draft = validateLedgerEventDraft(request.intentionDraft);
    if (draft.eventType !== 'intention.recorded') {
      throw new InMemoryEvidenceError(
        'invalid-request',
        `A turn commit requires an intention.recorded draft, received ${draft.eventType}`,
      );
    }

    return this.serialize(async () => {
      this.assertKnownRun(request.runId);

      const ledgerStream = ledgerStreamOf(request.sender);
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
        ...(request.deliveredArtifact === null
          ? {}
          : {
              deliveryReceipt: {
                recipient: request.recipient,
                deliveredArtifactHash: publicArtifactHash,
                deliveredAt: this.clock.now(),
              },
            }),
        recordedAt: this.clock.now(),
      });

      this.append(request.runId, ledgerStream, senderLedgerEvent);
      this.append(request.runId, 'channel', channelEvent);
      this.channelEventsByHash.set(channelEvent.entryHash, channelEvent);

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
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
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
      this.append(request.runId, 'channel', channelEvent);
      this.channelEventsByHash.set(channelEvent.entryHash, channelEvent);
      return channelEvent;
    });
  }

  commitControlArtifact(
    request: ControlArtifactCommitRequest,
  ): Promise<{ channelEvent: ChannelEvent; delivery: DeliveredChannelArtifact }> {
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
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
      this.append(request.runId, 'channel', channelEvent);
      this.channelEventsByHash.set(channelEvent.entryHash, channelEvent);
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

  appendLedgerEvent(request: LedgerAppendRequest): Promise<LedgerEvent> {
    const draft = validateLedgerEventDraft(request.draft);
    if (
      draft.eventType === 'interpretation.recorded' &&
      request.channelEventHash === undefined
    ) {
      throw new InMemoryEvidenceError(
        'interpretation-binding',
        'interpretation.recorded events must reference the delivered channelEventHash',
      );
    }

    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
      if (request.channelEventHash !== undefined) {
        this.assertDeliveryBinding(request.babyId, request.channelEventHash);
      }
      const stream = ledgerStreamOf(roleForBabyId(request.babyId));
      const head = this.chainHead(request.runId, stream);
      const event = await this.signLedgerEvent({
        runId: request.runId,
        stream,
        babyId: request.babyId,
        sequence: head.size + 1,
        turn: request.turn,
        draft,
        previousEntryHash: head.lastEntryHash,
        ...(request.channelEventHash === undefined
          ? {}
          : { channelEventHash: request.channelEventHash }),
      });
      this.append(request.runId, stream, event);
      return event;
    });
  }

  appendTurnRecord(request: TurnRecordAppendRequest): Promise<TurnRecord> {
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
      const head = this.chainHead(request.runId, 'turns');
      const signer = this.signers.signer(STREAM_SIGNER.turns);
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
        ...(request.probeHash === undefined
          ? {}
          : { probeHash: request.probeHash }),
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
      this.append(request.runId, 'turns', record);
      return record;
    });
  }

  appendInterventionEvent(
    request: InterventionAppendRequest,
  ): Promise<InterventionEvent> {
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
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
      this.append(request.runId, 'intervention', event);
      return event;
    });
  }

  appendAuditLedgerEntry(
    request: AuditLedgerAppendRequest,
  ): Promise<AuditLedgerEntry> {
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
      const head = this.chainHead(request.runId, 'audit');
      const signer = this.signers.signer(STREAM_SIGNER.audit);
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
      this.append(request.runId, 'audit', entry);
      return entry;
    });
  }

  appendAffectEvent(request: AffectAppendRequest): Promise<AffectEvent> {
    return this.serialize(async () => {
      this.assertKnownRun(request.runId);
      const head = this.chainHead(request.runId, 'affect');
      const signer = this.signers.signer(STREAM_SIGNER.affect);
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
      this.append(request.runId, 'affect', event);
      return event;
    });
  }

  /** Public keys of the single registry this double is bound to. */
  readRunSigners(runId: string): SignerPublicKey[] {
    this.assertKnownRun(runId);
    return this.signers.publicKeys();
  }

  insertCheckpointManifest(manifest: CheckpointManifest): void {
    this.checkpoints.push(CheckpointManifestSchema.parse(manifest));
  }

  insertAnchorReceipt(receipt: AnchorReceipt): void {
    this.anchors.push(AnchorReceiptSchema.parse(receipt));
  }

  appendExperimentRecord(record: ExperimentRecord): void {
    const parsed = ExperimentRecordSchema.parse(record);
    const previous = this.readExperimentRecords(parsed.runId);
    const expected = (previous[previous.length - 1]?.recordVersion ?? 0) + 1;
    if (parsed.recordVersion !== expected) {
      throw new InMemoryEvidenceError(
        'experiment-record-version',
        `Experiment record version must be ${expected}, received ${parsed.recordVersion}`,
      );
    }
    this.experiments.push(parsed);
  }

  /**
   * LEDGER §15 recovery: recompute the chain of every stream and report
   * violations. The in-memory store cannot fork, so `forks` is always empty.
   */
  recover(runId: string): Promise<RecoveryReport> {
    const chainViolations: string[] = [];
    const heads: ChainHead[] = [];
    const forks: ForkReport[] = [];

    for (const stream of EVENT_STREAMS) {
      const records = this.streamRecords(runId, stream);
      let previous = GENESIS_HASH;
      records.forEach((record, index) => {
        if (record.sequence !== index + 1) {
          chainViolations.push(
            `${stream}: expected sequence ${index + 1}, found ${record.sequence}`,
          );
        }
        if (record.previousEntryHash !== previous) {
          chainViolations.push(
            `${stream}#${record.sequence}: previous hash mismatch`,
          );
        }
        previous = record.entryHash;
      });
      heads.push(this.chainHead(runId, stream));
    }

    return Promise.resolve({
      runId,
      ok: chainViolations.length === 0,
      heads,
      forks,
      chainViolations,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private streamRecords(runId: string, stream: EventStream): StoredRecord[] {
    return this.records.filter(
      (record) => record.runId === runId && record.stream === stream,
    );
  }

  private assertKnownRun(runId: string): void {
    if (!this.runs.has(runId)) {
      throw new InMemoryEvidenceError(
        'unknown-run',
        `Run ${runId} is not registered`,
      );
    }
  }

  private assertDeliveryBinding(
    babyId: BabyId,
    channelEventHash: Sha256Hash,
  ): void {
    const event = this.channelEventsByHash.get(channelEventHash);
    if (!event) {
      throw new InMemoryEvidenceError(
        'interpretation-binding',
        `No channel event ${channelEventHash} is committed`,
      );
    }
    const expected = roleForBabyId(babyId);
    if (event.deliveryReceipt?.recipient !== expected) {
      throw new InMemoryEvidenceError(
        'interpretation-binding',
        `Channel event ${channelEventHash} was not delivered to ${expected}`,
      );
    }
  }

  private append(
    runId: string,
    stream: EventStream,
    event: { sequence: number; entryHash: string; recordedAt: string },
  ): void {
    const canonical = canonicalJson(event);
    const previous = this.chainHead(runId, stream).lastEntryHash;
    this.records.push({
      runId,
      stream,
      sequence: event.sequence,
      entryHash: event.entryHash,
      previousEntryHash: previous,
      recordedAt: event.recordedAt,
      canonicalJson: canonical,
    });
  }

  private async signLedgerEvent(input: {
    runId: string;
    stream: LedgerStream;
    babyId: BabyId;
    sequence: number;
    turn: number;
    draft: LedgerEventDraft;
    previousEntryHash: Sha256Hash;
    channelEventHash?: Sha256Hash;
  }): Promise<LedgerEvent> {
    const signer = this.signers.signer(STREAM_SIGNER[input.stream]);
    const unsigned = {
      version: 1 as const,
      runId: input.runId,
      babyId: input.babyId,
      sequence: input.sequence,
      turn: input.turn,
      eventType: input.draft.eventType,
      contentSchema: input.draft.contentSchema,
      subjectId: input.draft.subjectId,
      content:
        input.draft.evidenceRefs.length > 0
          ? { ...input.draft.content, evidenceRefs: input.draft.evidenceRefs }
          : { ...input.draft.content },
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
    const signer = this.signers.signer(STREAM_SIGNER.channel);
    const withKey = { ...unsigned, writerKeyId: signer.keyId };
    const entryHash = computeEntryHash('channel', withKey);
    return ChannelEventSchema.parse({
      ...withKey,
      entryHash,
      writerSignature: await signer.sign(entryHash),
    });
  }
}

/** Signer domains an `InMemoryEvidenceWriter` needs to be provisioned with. */
export const REQUIRED_SIGNER_DOMAINS: readonly SignerDomain[] = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'audit',
  'witness',
];
