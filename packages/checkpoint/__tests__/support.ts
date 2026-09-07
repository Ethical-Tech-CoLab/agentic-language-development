import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { InMemorySignerRegistry } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import type {
  CheckpointManifest,
  Clock,
  EventRange,
  EventStream,
  RunConfig,
  RunMetadataRecord,
  StoredEvent,
} from '@ald/types';

import {
  EvidenceCheckpointService,
  type CheckpointEvidenceStore,
} from '../src/checkpoint-service.js';

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ald-checkpoint-'));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

/** Deterministic clock advancing a fixed step per reading. */
export class StepClock implements Clock {
  private current: number;

  constructor(
    startMs = Date.UTC(2026, 0, 1, 0, 0, 0),
    private readonly stepMs = 1_000,
  ) {
    this.current = startMs;
  }

  now(): string {
    const value = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return value;
  }

  /** Moves the clock forward without consuming a reading. */
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Clock that only moves when a test moves it. */
export class ManualClock implements Clock {
  constructor(private current = Date.UTC(2026, 0, 1, 0, 0, 0)) {}

  now(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface CheckpointContext {
  runId: string;
  config: RunConfig;
  writer: SqliteEvidenceWriter;
  signers: InMemorySignerRegistry;
  service: EvidenceCheckpointService;
  clock: StepClock;
  close(): void;
}

export async function createContext(
  overrides: Partial<Parameters<typeof buildRunConfig>[0]> = {},
): Promise<CheckpointContext> {
  const runId = overrides.runId ?? 'run-checkpoint-001';
  const config = buildRunConfig({
    runId,
    experimentId: 'E00',
    randomSeed: 'seed-checkpoint',
    promptBundleHash: hash('b'),
    ...overrides,
  });
  const directory = await temporaryDirectory();
  const database = openEvidenceDatabase(join(directory, 'evidence.sqlite'));
  const signers = InMemorySignerRegistry.generate(runId);
  const clock = new StepClock();
  const writer = new SqliteEvidenceWriter({
    database,
    signers,
    clock,
    softwareCommit: 'git:test-commit',
  });
  writer.registerRun(config);
  const service = new EvidenceCheckpointService({
    evidence: writer,
    signers,
    clock,
    softwareCommit: 'git:test-commit',
  });
  return {
    runId,
    config,
    writer,
    signers,
    service,
    clock,
    close: () => database.close(),
  };
}

/**
 * Commits `count` complete turns: one sender intention plus channel event
 * (`commitTurn`), one receiver interpretation bound to that channel event,
 * and one Nursery turn record. Leaves `affect` and `audit` empty.
 */
export async function commitTurns(
  context: CheckpointContext,
  count: number,
  startTurn = 1,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const turn = startTurn + index;
    const result = await context.writer.commitTurn({
      runId: context.runId,
      turn,
      sender: 'baby-a',
      recipient: 'baby-b',
      carrier: 'fixed-token',
      communicationCondition: 'normal',
      proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
      intentionDraft: {
        eventType: 'intention.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: hash('d'),
        content: { artifactRef: `artifact-${String(turn)}` },
        blindingNonce: `nonce-a-${String(turn)}`,
        evidenceRefs: [],
      },
      deliveredArtifact: { symbols: ['S01'] },
    });
    await context.writer.appendLedgerEvent({
      runId: context.runId,
      babyId: 'B',
      turn,
      draft: {
        eventType: 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: hash('e'),
        content: { artifactRef: `artifact-${String(turn)}` },
        blindingNonce: `nonce-b-${String(turn)}`,
        evidenceRefs: [],
      },
      channelEventHash: result.channelEvent.entryHash,
    });
    await context.writer.appendTurnRecord({
      runId: context.runId,
      turn,
      phase: 'running',
      roles: { sender: 'baby-a', receiver: 'baby-b' },
      communicationCondition: 'normal',
      scenarioRef: `scenario-${String(turn)}`,
      scenarioStateHash: hash('1'),
      observationHashes: { babyA: hash('2'), babyB: hash('3') },
      babyProposalHash: hash('4'),
      deliveredArtifactHash: result.channelEvent.publicArtifactHash,
      channelEventHash: result.channelEvent.entryHash,
      actionHash: hash('5'),
      outcomeHash: hash('6'),
      outcome: { success: true, turn },
    });
  }
}

/**
 * Read-through store that rewrites one stream's events, so a checkpoint's
 * committed root no longer matches what the store reports (LEDGER §17).
 */
export class RewritingEvidenceStore implements CheckpointEvidenceStore {
  constructor(
    private readonly inner: CheckpointEvidenceStore,
    private readonly stream: EventStream,
    private readonly rewrite: (events: StoredEvent[]) => StoredEvent[],
  ) {}

  readRunMetadata(runId: string): RunMetadataRecord | undefined {
    return this.inner.readRunMetadata(runId);
  }

  readCheckpoints(runId: string): CheckpointManifest[] {
    return this.inner.readCheckpoints(runId);
  }

  readEvents(
    runId: string,
    stream: EventStream,
    range?: EventRange,
  ): StoredEvent[] {
    const events = this.inner.readEvents(runId, stream, range);
    return stream === this.stream ? this.rewrite(events) : events;
  }

  insertCheckpointManifest(manifest: CheckpointManifest): void {
    this.inner.insertCheckpointManifest(manifest);
  }
}
