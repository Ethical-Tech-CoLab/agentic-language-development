/**
 * Shared harness for the `@ald/ops` tests: one temp directory, one real
 * SQLite evidence store, one real `NurseryRuntimeImpl` with the
 * `SimpleCheckpointService` stand-in, no anchor publisher, and a deterministic
 * step clock.
 *
 * Modelled on `packages/orchestrator/__tests__/helpers.ts` but kept local, so
 * a concurrent edit to that file cannot change what these tests assert.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEvidenceDatabase, type EvidenceDatabase } from '@ald/evidence';
import { InMemorySignerRegistry } from '@ald/hashing';
import { buildRunConfig, type RunConfigOverrides } from '@ald/lifecycle';
import {
  createNurseryRuntime,
  simpleCheckpointFactory,
  type NurseryRuntimeImpl,
  type NurseryRuntimeOptions,
} from '@ald/orchestrator';
import type {
  Clock,
  DeliveredChannelArtifact,
  LearnerAdapter,
  LearnerAdapterFactory,
  LearnerInitContext,
  LedgerDraftEnvelope,
  Observation,
  OutcomeEvent,
  RunConfig,
  SignerRegistry,
  TurnBudget,
  TurnProposalEnvelope,
  VerificationReport,
} from '@ald/types';

export const SOFTWARE_COMMIT = 'git:ops-test';

/** Deterministic clock: every `now()` advances by a fixed step. */
export class StepClock implements Clock {
  #current: number;

  constructor(
    startMs = Date.UTC(2026, 0, 1),
    private readonly stepMs = 1_000,
  ) {
    this.#current = startMs;
  }

  now(): string {
    const value = new Date(this.#current).toISOString();
    this.#current += this.stepMs;
    return value;
  }

  /** Reads the clock without advancing it. */
  peek(): string {
    return new Date(this.#current).toISOString();
  }

  advance(ms: number): void {
    this.#current += ms;
  }
}

/** A clock that never advances; for canonical-output assertions. */
export class FixedClock implements Clock {
  constructor(private readonly value = new Date(Date.UTC(2026, 0, 1)).toISOString()) {}

  now(): string {
    return this.value;
  }
}

export type RuntimeOverrides = Partial<
  Omit<NurseryRuntimeOptions, 'database' | 'bundleRoot'>
>;

export interface Harness {
  root: string;
  databasePath: string;
  database: EvidenceDatabase;
  clock: StepClock;
  runtime: NurseryRuntimeImpl;
  signerProvider: (runId: string) => SignerRegistry;
  /** Opens a second runtime on the same store, as a restart would. */
  restart(overrides?: RuntimeOverrides): Harness;
  close(): void;
  cleanup(): Promise<void>;
}

interface HarnessInput {
  root: string;
  databasePath: string;
  signerProvider: (runId: string) => SignerRegistry;
  clock: StepClock;
  overrides?: RuntimeOverrides;
}

function buildHarness(input: HarnessInput): Harness {
  const database = openEvidenceDatabase(input.databasePath);
  const runtime = createNurseryRuntime({
    database,
    bundleRoot: input.root,
    softwareCommit: SOFTWARE_COMMIT,
    checkpointFactory: simpleCheckpointFactory({
      clock: input.clock,
      softwareCommit: SOFTWARE_COMMIT,
    }),
    signerProvider: input.signerProvider,
    clock: input.clock,
    anchorPolicy: 'skip',
    ...input.overrides,
  });

  return {
    root: input.root,
    databasePath: input.databasePath,
    database,
    clock: input.clock,
    runtime,
    signerProvider: input.signerProvider,
    restart: (overrides) => {
      database.close();
      return buildHarness({
        ...input,
        overrides: { ...input.overrides, ...overrides },
      });
    },
    close: () => {
      database.close();
    },
    cleanup: async () => {
      try {
        database.close();
      } catch {
        // Already closed by a restart.
      }
      await rm(input.root, { recursive: true, force: true });
    },
  };
}

export async function createHarness(
  overrides: RuntimeOverrides = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ald-ops-'));
  const registries = new Map<string, SignerRegistry>();
  const signerProvider = (runId: string): SignerRegistry => {
    const existing = registries.get(runId);
    if (existing) {
      return existing;
    }
    const created = InMemorySignerRegistry.generate(runId);
    registries.set(runId, created);
    return created;
  };
  return buildHarness({
    root,
    databasePath: join(root, 'evidence.sqlite'),
    signerProvider,
    clock: new StepClock(),
    overrides,
  });
}

/** SPEC §18 defaults plus a symmetric `no-learning` pair. */
export function noLearningConfig(overrides: RunConfigOverrides): RunConfig {
  const config = buildRunConfig({
    deploymentMode: 'prototype',
    protocolGitCommit: 'git:test-protocol',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    ...overrides,
  });
  return overrides.evaluationTurns === undefined
    ? config
    : { ...config, evaluationTurns: overrides.evaluationTurns };
}

/** SPEC §18 defaults plus a symmetric `scratch-rl` pair (learns, has a policy). */
export function scratchRlConfig(overrides: RunConfigOverrides): RunConfig {
  const config = buildRunConfig({
    deploymentMode: 'prototype',
    protocolGitCommit: 'git:test-protocol',
    babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    learningSignal: 'extrinsic-task',
    ...overrides,
  });
  return overrides.evaluationTurns === undefined
    ? config
    : { ...config, evaluationTurns: overrides.evaluationTurns };
}

export function bundleDirOf(harness: Harness, runId: string): string {
  return join(harness.root, 'runs', runId);
}

// ---------------------------------------------------------------------------
// Adapter doubles for the §14.5 failure-mode tests
// ---------------------------------------------------------------------------

function senderEnvelope(turn: number, symbol: string): TurnProposalEnvelope {
  return {
    proposal: { kind: 'emit_symbols', publicArtifact: { symbols: [symbol] } },
    privateLedgerDraft: {
      eventType: 'intention.recorded',
      contentSchema: 'agent-native-ledger',
      subjectId: `symbol:${symbol}`,
      content: { artifactRef: `proposal:${symbol}` },
      blindingNonce: `nonce:${String(turn)}`,
      evidenceRefs: [],
    },
  };
}

function receiverEnvelope(
  turn: number,
  candidateRefs: readonly string[],
): TurnProposalEnvelope {
  const objectRef = candidateRefs[0] ?? 'o:missing';
  return {
    proposal: { kind: 'select_object', publicArtifact: { objectRef } },
    privateLedgerDraft: {
      eventType: 'intention.recorded',
      contentSchema: 'agent-native-ledger',
      subjectId: `candidate:${objectRef}`,
      content: { artifactRef: `proposal:${objectRef}` },
      blindingNonce: `nonce:r${String(turn)}`,
      evidenceRefs: [],
    },
  };
}

function interpretation(delivery: DeliveredChannelArtifact): LedgerDraftEnvelope {
  return {
    channelEventHash: delivery.channelEventHash,
    privateLedgerDraft: {
      eventType: 'interpretation.recorded',
      contentSchema: 'agent-native-ledger',
      subjectId: 'symbol:unknown',
      content: { artifactRef: delivery.channelEventHash },
      blindingNonce: `nonce:i${String(delivery.turn)}`,
      evidenceRefs: [`channel:${delivery.channelEventHash}`],
    },
  };
}

/** SPEC §9.1/§9.4: always proposes an out-of-inventory symbol, so every send is rejected. */
export class AlwaysRejectedAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  act(budget: TurnBudget): Promise<TurnProposalEnvelope> {
    if (budget.role === 'receiver') {
      return Promise.resolve(receiverEnvelope(budget.turn, budget.candidateRefs ?? []));
    }
    return Promise.resolve(senderEnvelope(budget.turn, 'NOT-IN-INVENTORY'));
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve(interpretation(delivery));
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'always-rejected' };
  }
}

/** SPEC §14.5: throws from `act`, exhausting the retry budget. */
export class CrashingAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  calls = 0;

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  act(_budget: TurnBudget): Promise<TurnProposalEnvelope> {
    this.calls += 1;
    return Promise.reject(new Error('adapter host crashed'));
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve(interpretation(delivery));
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'crashing' };
  }
}

/** SPEC §8.3/§14.5: never answers inside `turnResponseBudgetMs`. */
export class TimingOutAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  constructor(private readonly delayMs: number) {}

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  async act(budget: TurnBudget): Promise<TurnProposalEnvelope> {
    if (budget.role === 'sender') {
      await new Promise((resolve) => {
        setTimeout(resolve, this.delayMs);
      });
      return senderEnvelope(budget.turn, 'S01');
    }
    return receiverEnvelope(budget.turn, budget.candidateRefs ?? []);
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve(interpretation(delivery));
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'timing-out' };
  }
}

export function factoryFor(
  create: () => LearnerAdapter,
): LearnerAdapterFactory {
  return { track: 'no-learning', create };
}

/** A verifier double reporting the given exit code with an otherwise clean report. */
export function fakeVerifier(
  runId: string,
  exitCode: 0 | 1 = 0,
): (bundleDir: string) => Promise<VerificationReport> {
  return () =>
    Promise.resolve({
      version: 1,
      runId,
      checkedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      bundleManifestHash: null,
      verifierVersion: 'fake-verifier-v1',
      checks: {
        canonicalJsonValid: true,
        sequencesStrictlyIncreasing: true,
        entryHashesRebuilt: true,
        previousEntryLinksValid: true,
        writerSignaturesValid: true,
        merkleRootsRebuilt: true,
        inclusionProofsValid: true,
        consistencyProofsValid: true,
        checkpointHashesRebuilt: true,
        witnessSignaturesValid: true,
        anchorTxConfirmed: exitCode === 0,
        anchorChainIdMatches: exitCode === 0,
        unanchoredTailReported: true,
      },
      gaps: [],
      forks: [],
      finalVerifiedSizes: {},
      exitCode,
    });
}
