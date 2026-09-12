import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySignerRegistry } from '@ald/hashing';
import type {
  AgentActionProposal,
  Clock,
  LedgerEventDraft,
  RunConfig,
} from '@ald/types';

import { openEvidenceDatabase } from '../../src/database.js';
import { SqliteEvidenceWriter } from '../../src/writer.js';

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ald-evidence-'));
  temporaryDirectories.push(directory);
  return directory;
}

export async function temporaryDatabasePath(): Promise<string> {
  return join(await temporaryDirectory(), 'evidence.sqlite');
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

/** Deterministic clock: one millisecond per call from a fixed epoch. */
export class StepClock implements Clock {
  private current: number;

  constructor(startMs = Date.UTC(2026, 0, 1, 0, 0, 0), private readonly stepMs = 1) {
    this.current = startMs;
  }

  now(): string {
    const value = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return value;
  }
}

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    version: 1,
    runId: 'run-test-001',
    deploymentMode: 'prototype',
    babyA: {
      track: 'no-learning',
      modelRef: 'reference-a',
      trainingIsolation: 'independent',
    },
    babyB: {
      track: 'no-learning',
      modelRef: 'reference-b',
      trainingIsolation: 'independent',
    },
    symmetricTracks: true,
    learningSignal: 'none',
    communicationCondition: 'normal',
    interactionMode: 'cooperative-signaling',
    carrierMode: 'fixed-token',
    symbolInventorySize: 8,
    maxSymbolsPerMessage: 4,
    affectMode: 'none',
    affectWindowSchedule: 'every-4-turns',
    observationEncoding: 'opaque-numeric',
    roleReversalPeriod: 2,
    turnResponseBudgetMs: 5_000,
    maxTurnsPerRun: 20,
    maxConsecutiveRejections: 3,
    ledgerLagTurns: 0,
    curriculumMode: 'fixed-schedule',
    cipherThreatModel: 'post-run-disclosure',
    interventionSuiteThreshold: 0.5,
    evaluationSeeds: 4,
    checkpointEventInterval: 25,
    checkpointTimeIntervalMs: 60_000,
    anchorClass: 'simulated',
    anchorNetwork: 'base-sepolia',
    finalityPolicy: '1-confirmation',
    prototypeRetentionDays: 30,
    scenarioBundleHash: hash('a'),
    promptBundleHash: hash('b'),
    protocolGitCommit: 'e2b1c0d4f5a6978877665544332211aabbccddee',
    preRegistrationHash: hash('c'),
    randomSeed: 'seed-000',
    experimentId: 'E00',
    ...overrides,
  } as RunConfig;
}

export const proposal: AgentActionProposal = {
  kind: 'emit_symbols',
  publicArtifact: { symbols: ['S01', 'S02'] },
};

export function intentionDraft(
  overrides: Partial<LedgerEventDraft> = {},
): LedgerEventDraft {
  return {
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: hash('d'),
    content: { artifactRef: 'artifact-01' },
    blindingNonce: 'nonce-01',
    evidenceRefs: [],
    ...overrides,
  };
}

export function interpretationDraft(
  overrides: Partial<LedgerEventDraft> = {},
): LedgerEventDraft {
  return {
    eventType: 'interpretation.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: hash('e'),
    content: { artifactRef: 'artifact-01' },
    blindingNonce: 'nonce-02',
    evidenceRefs: [],
    ...overrides,
  };
}

export interface TestWriter {
  writer: SqliteEvidenceWriter;
  close(): void;
  database: ReturnType<typeof openEvidenceDatabase>['database'];
  path: string;
  signers: InMemorySignerRegistry;
}

export async function createWriter(options: {
  config?: RunConfig;
  path?: string;
  clock?: Clock;
  register?: boolean;
  signers?: InMemorySignerRegistry;
} = {}): Promise<TestWriter> {
  const config = options.config ?? runConfig();
  const path = options.path ?? (await temporaryDatabasePath());
  const evidence = openEvidenceDatabase(path);
  const signers =
    options.signers ?? InMemorySignerRegistry.generate(config.runId);
  const writer = new SqliteEvidenceWriter({
    database: evidence,
    signers,
    clock: options.clock ?? new StepClock(),
    softwareCommit: 'test-commit',
  });
  if (options.register !== false) {
    writer.registerRun(config);
  }
  return {
    writer,
    signers,
    database: evidence.database,
    path,
    close: () => evidence.close(),
  };
}
