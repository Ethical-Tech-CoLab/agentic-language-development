/**
 * Shared harness for the orchestrator tests: a real SQLite evidence store in
 * a temp directory, a real Symbol Gateway, real learner adapters, the
 * `SimpleCheckpointService` stand-in for `@ald/checkpoint`, no anchor
 * publisher, and a deterministic clock.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEvidenceDatabase, type EvidenceDatabase } from '@ald/evidence';
import {
  InMemorySignerRegistry,
  computeEntryHash,
  verifyHashSignature,
} from '@ald/hashing';
import { StepClock } from '@ald/gateway';
import { buildRunConfig, type RunConfigOverrides } from '@ald/lifecycle';
import type {
  AgentActionProposal,
  AnchorPublisher,
  AnchorReceipt,
  CheckpointManifest,
  Clock,
  DeliveredChannelArtifact,
  LearnerAdapter,
  LearnerAdapterFactory,
  LearnerInitContext,
  LedgerDraftEnvelope,
  Observation,
  OutcomeEvent,
  PolicyCheckpointRef,
  RunConfig,
  SignerRegistry,
  TurnBudget,
  TurnProposalEnvelope,
  UpdateBatch,
  VerificationReport,
} from '@ald/types';

import {
  SimpleCheckpointService,
  createNurseryRuntime,
  createSimpleProofWriter,
  simpleCheckpointFactory,
  type NurseryRuntimeImpl,
  type NurseryRuntimeOptions,
} from '../src/index.js';

export const SOFTWARE_COMMIT = 'git:orchestrator-test';

export type RuntimeOverrides = Partial<
  Omit<NurseryRuntimeOptions, 'database' | 'bundleRoot'>
>;

export interface Harness {
  root: string;
  databasePath: string;
  database: EvidenceDatabase;
  clock: Clock;
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
  overrides?: RuntimeOverrides;
}

function buildHarness(input: HarnessInput): Harness {
  const database = openEvidenceDatabase(input.databasePath);
  const clock = input.overrides?.clock ?? new StepClock();
  const runtime = createNurseryRuntime({
    database,
    bundleRoot: input.root,
    softwareCommit: SOFTWARE_COMMIT,
    checkpointFactory: simpleCheckpointFactory({
      clock,
      softwareCommit: SOFTWARE_COMMIT,
    }),
    signerProvider: input.signerProvider,
    clock,
    anchorPolicy: 'skip',
    ...input.overrides,
  });

  const harness: Harness = {
    root: input.root,
    databasePath: input.databasePath,
    database,
    clock,
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
        // already closed by a restart
      }
      await rm(input.root, { recursive: true, force: true });
    },
  };
  return harness;
}

/** One temp directory, one evidence store, one runtime. */
export async function createHarness(
  overrides: RuntimeOverrides = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ald-orchestrator-'));
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
  return buildHarness({ root, databasePath: join(root, 'evidence.sqlite'), signerProvider, overrides });
}

/**
 * SPEC §18 defaults plus the knobs a test cares about.
 *
 * `buildRunConfig` does not carry `evaluationTurns` through (it is optional in
 * `RunConfigSchema` and has a runtime default), so it is re-applied here.
 */
export function testConfig(overrides: RunConfigOverrides): RunConfig {
  const config = buildRunConfig({
    deploymentMode: 'prototype',
    protocolGitCommit: 'git:test-protocol',
    ...overrides,
  });
  return overrides.evaluationTurns === undefined
    ? config
    : { ...config, evaluationTurns: overrides.evaluationTurns };
}

/**
 * `validateChain` reads `previousEntryHash`, which the `channel` stream calls
 * `previousChannelHash` (SPEC §11.5), so the channel chain is walked here
 * with the same four checks: canonical entry hash, chain link, signature, and
 * strictly increasing sequences.
 */
export function channelChainViolations(
  events: readonly Record<string, unknown>[],
  options: { runId: string; publicKey: string },
): string[] {
  const violations: string[] = [];
  let previous = `sha256:${'0'.repeat(64)}`;

  events.forEach((event, index) => {
    const label = `channel#${String(event.sequence)}`;
    if (event.sequence !== index + 1) {
      violations.push(`${label}: expected sequence ${String(index + 1)}`);
    }
    if (event.runId !== options.runId) {
      violations.push(`${label}: runId ${String(event.runId)}`);
    }
    if (event.previousChannelHash !== previous) {
      violations.push(`${label}: previousChannelHash does not chain`);
    }
    const recomputed = computeEntryHash('channel', event);
    if (recomputed !== event.entryHash) {
      violations.push(`${label}: entry hash mismatch`);
    }
    if (
      typeof event.writerSignature !== 'string' ||
      !verifyHashSignature(
        recomputed,
        event.writerSignature,
        options.publicKey,
      )
    ) {
      violations.push(`${label}: writer signature does not verify`);
    }
    previous = String(event.entryHash);
  });

  return violations;
}

export function noLearningOverrides(
  overrides: RunConfigOverrides,
): RunConfigOverrides {
  return {
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    ...overrides,
  };
}

export function bundleDir(harness: Harness, runId: string): string {
  return join(harness.root, 'runs', runId);
}

/** Success rate over the turn records of one phase. */
export function successRate(
  outcomes: readonly { success: boolean }[],
): number {
  return outcomes.length === 0
    ? 0
    : outcomes.filter((outcome) => outcome.success).length / outcomes.length;
}

// ---------------------------------------------------------------------------
// Adapter test doubles
// ---------------------------------------------------------------------------

/**
 * Wraps a real adapter and records every sender proposal by turn, so a test
 * can compare the Baby's own artifact with the artifact the §9.6 condition
 * actually delivered. `updatePolicy` is only forwarded when the wrapped track
 * has one, because its presence is what disables learning in `evaluating`.
 */
class RecordingAdapter implements LearnerAdapter {
  readonly track: LearnerAdapter['track'];

  updatePolicy?: (batch: UpdateBatch) => Promise<PolicyCheckpointRef>;

  constructor(
    private readonly inner: LearnerAdapter,
    private readonly proposals: Map<number, AgentActionProposal>,
  ) {
    this.track = inner.track;
    const update = inner.updatePolicy;
    if (update) {
      this.updatePolicy = (batch) => update.call(inner, batch);
    }
  }

  init(context: LearnerInitContext): Promise<void> {
    return this.inner.init(context);
  }

  observe(observation: Observation): Promise<void> {
    return this.inner.observe(observation);
  }

  async act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    const envelope = await this.inner.act(turnBudget);
    if (turnBudget.role === 'sender') {
      this.proposals.set(turnBudget.turn, envelope.proposal);
    }
    return envelope;
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return this.inner.receive(delivery);
  }

  onOutcome(outcome: OutcomeEvent): Promise<void> {
    return this.inner.onOutcome(outcome);
  }

  exportPolicy(): unknown {
    return this.inner.exportPolicy();
  }
}

export function recordingFactory(
  inner: LearnerAdapterFactory,
  proposals: Map<number, AgentActionProposal>,
): LearnerAdapterFactory {
  return {
    track: inner.track,
    create: () => new RecordingAdapter(inner.create(), proposals),
  };
}

/**
 * A Baby that always emits a symbol outside the run's inventory: every one of
 * its proposals must be rejected by the Gateway (SPEC §9.1, §9.4).
 */
export class MisbehavingAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  #candidateRefs: string[] = [];

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    if (turnBudget.role === 'receiver') {
      this.#candidateRefs = [...(turnBudget.candidateRefs ?? [])];
      const objectRef = this.#candidateRefs[0] ?? 'o:missing';
      return Promise.resolve({
        proposal: { kind: 'select_object', publicArtifact: { objectRef } },
        privateLedgerDraft: {
          eventType: 'intention.recorded',
          contentSchema: 'agent-native-ledger',
          subjectId: `candidate:${objectRef}`,
          content: { artifactRef: `proposal:${objectRef}` },
          blindingNonce: `nonce:${String(turnBudget.turn)}`,
          evidenceRefs: [],
        },
      });
    }
    return Promise.resolve({
      // Not in `fixedTokenInventory`: the Gateway must reject it.
      proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['NOPE'] } },
      privateLedgerDraft: {
        eventType: 'intention.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:NOPE',
        content: { artifactRef: 'proposal:nope' },
        blindingNonce: `nonce:${String(turnBudget.turn)}`,
        evidenceRefs: [],
      },
    });
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve({
      channelEventHash: delivery.channelEventHash,
      privateLedgerDraft: {
        eventType: 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:unknown',
        content: { artifactRef: delivery.channelEventHash },
        blindingNonce: `nonce:i${String(delivery.turn)}`,
        evidenceRefs: [`channel:${delivery.channelEventHash}`],
      },
    });
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'misbehaving' };
  }
}

export const misbehavingFactory: LearnerAdapterFactory = {
  track: 'no-learning',
  create: () => new MisbehavingAdapter(),
};

/** A Baby that never answers inside `turnResponseBudgetMs` (SPEC §8.3). */
export class SlowAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;

  constructor(private readonly delayMs: number) {}

  init(_context: LearnerInitContext): Promise<void> {
    return Promise.resolve();
  }

  observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  async act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    if (turnBudget.role === 'sender') {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return {
        proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
        privateLedgerDraft: {
          eventType: 'intention.recorded',
          contentSchema: 'agent-native-ledger',
          subjectId: 'symbol:S01',
          content: { artifactRef: 'proposal:late' },
          blindingNonce: `nonce:${String(turnBudget.turn)}`,
          evidenceRefs: [],
        },
      };
    }
    const objectRef = turnBudget.candidateRefs?.[0] ?? 'o:missing';
    return {
      proposal: { kind: 'select_object', publicArtifact: { objectRef } },
      privateLedgerDraft: {
        eventType: 'intention.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: `candidate:${objectRef}`,
        content: { artifactRef: `proposal:${objectRef}` },
        blindingNonce: `nonce:r${String(turnBudget.turn)}`,
        evidenceRefs: [],
      },
    };
  }

  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    return Promise.resolve({
      channelEventHash: delivery.channelEventHash,
      privateLedgerDraft: {
        eventType: 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { artifactRef: delivery.channelEventHash },
        blindingNonce: `nonce:i${String(delivery.turn)}`,
        evidenceRefs: [`channel:${delivery.channelEventHash}`],
      },
    });
  }

  onOutcome(_outcome: OutcomeEvent): Promise<void> {
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'slow' };
  }
}

export function slowFactory(delayMs: number): LearnerAdapterFactory {
  return { track: 'no-learning', create: () => new SlowAdapter(delayMs) };
}

/** What the publisher double reports and where it stores the receipt row. */
export interface FakeAnchorPublisherOptions {
  /**
   * Terminal status `awaitConfirmation` reports. `confirmed` and `failed` are
   * terminal decisions and are stored; `submitted` models the publisher
   * giving up on the confirmation poll, which stores nothing (the pending
   * sidecar stays the resume handle).
   */
  finalStatus?: AnchorReceipt['status'];
  /**
   * The store that owns the single append-only receipt row, resolved lazily
   * because the runtime is built before the harness exists. `BaseAnchorPublisher`
   * inserts exactly once at a terminal decision; the runtime never does.
   */
  evidence?: () => { insertAnchorReceipt(receipt: AnchorReceipt): void } | undefined;
}

/**
 * A Base Anchor Publisher double: `submit` returns a `submitted` receipt and
 * `awaitConfirmation` the terminal one, binding `inputData` to the 32-byte
 * checkpoint digest exactly as `docs/evidence-bundle-format.md` §8 requires.
 */
export class FakeAnchorPublisher implements AnchorPublisher {
  readonly network = 'base-sepolia' as const;

  readonly submitted: AnchorReceipt[] = [];

  constructor(
    private readonly failing = false,
    private readonly finalStatus: AnchorReceipt['status'] = 'confirmed',
  ) {}

  submit(manifest: CheckpointManifest): Promise<AnchorReceipt> {
    if (this.failing) {
      return Promise.reject(new Error('rpc endpoint unavailable'));
    }
    const digest = manifest.checkpointHash.slice('sha256:'.length);
    const receipt: AnchorReceipt = {
      version: 1,
      runId: 'unset',
      checkpointSequence: manifest.checkpointSequence,
      checkpointHash: manifest.checkpointHash,
      network: this.network,
      chainId: 84532,
      transactionHash: `0x${digest}`,
      from: `0x${'1'.repeat(40)}`,
      to: `0x${'2'.repeat(40)}`,
      inputData: `0x${digest}`,
      blockNumber: null,
      blockHash: null,
      status: 'submitted',
      confirmations: 0,
      finalityPolicy: '1-confirmation',
      rpcEndpointLabel: 'fake-local',
      recordedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    };
    this.submitted.push(receipt);
    return Promise.resolve(receipt);
  }

  awaitConfirmation(receipt: AnchorReceipt): Promise<AnchorReceipt> {
    if (this.finalStatus === 'submitted') {
      // The confirmation-poll budget ran out: not a terminal decision, so no
      // row is stored and the unstored `submitted` receipt comes back.
      return Promise.resolve(receipt);
    }
    return Promise.resolve({
      ...receipt,
      blockNumber: 1_234_567,
      blockHash: `0x${'3'.repeat(64)}`,
      status: this.finalStatus,
      confirmations: 1,
    });
  }
}

/**
 * Binds a publisher double to one run id (the receipt schema requires it).
 * Like `BaseAnchorPublisher`, the publisher — never the runtime — inserts the
 * single append-only receipt row, and only at a terminal decision.
 */
export function anchorPublisherFor(
  runId: string,
  failing = false,
  options: FakeAnchorPublisherOptions = {},
): AnchorPublisher {
  const inner = new FakeAnchorPublisher(failing, options.finalStatus);
  return {
    network: inner.network,
    submit: async (manifest) => ({ ...(await inner.submit(manifest)), runId }),
    awaitConfirmation: async (receipt) => {
      const settled = await inner.awaitConfirmation(receipt);
      if (settled.status !== 'submitted') {
        options.evidence?.()?.insertAnchorReceipt(settled);
      }
      return settled;
    },
  };
}

/**
 * A `proofWriter` bound lazily to the harness, because the runtime that owns
 * the writer is built before the harness object exists.
 */
export function createSimpleProofWriterFor(
  harnessRef: () => Harness | undefined,
): (runId: string, bundleDir: string) => Promise<void> {
  return async (runId, directory) => {
    const harness = harnessRef();
    if (harness === undefined) {
      return;
    }
    const evidence = harness.runtime.writerFor(runId);
    const checkpoints = new SimpleCheckpointService({
      evidence,
      signers: harness.signerProvider(runId),
      clock: harness.clock,
      softwareCommit: SOFTWARE_COMMIT,
    });
    await createSimpleProofWriter(evidence, checkpoints)(runId, directory);
  };
}

/** A verifier double: reports a clean bundle with the given exit code. */
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
