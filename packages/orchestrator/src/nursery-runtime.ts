/**
 * The Nursery Controller runtime (SPECIFICATION.md §4.1 item 2, §8.1, §12.5;
 * BACKLOG ALD-025, ALD-026, ALD-027, ALD-059 partial, ALD-071 partial).
 *
 * This class owns run and turn sequencing and nothing else. Every rule it
 * needs already lives in a deterministic service and is consumed through its
 * contract:
 *
 * - the §7.2 state machine is `RunLifecycle` — the runtime never derives a
 *   state itself, it applies an event and lets the table reject it;
 * - every event write goes through the one `EvidenceWriter` (§4.3: no other
 *   component may write an event table), including the atomic sender
 *   ledger/channel commit, which is reached only through the Symbol Gateway;
 * - scenario content, observations, and outcome evaluation come from the
 *   Scenario Engine; the runtime never inspects researcher-only ground truth
 *   and never passes it to a learner (§4.3 "MUST NOT supply semantic hints");
 * - Merkle work and manifest signing belong to the injected
 *   `CheckpointService`; anchoring to the injected `AnchorPublisher`;
 *   verification to an injected verifier function, which by §4.2 has no live
 *   runtime trust at all.
 *
 * What the runtime therefore contributes is ordering, budgets, counters, and
 * the audited side effects of §7.2 — plus the turn record (`turns` stream)
 * that carries the §14.3 replay tuple.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  babyIdForRole,
  CLAIM_BOUNDARY_STATEMENTS,
  ChannelEventSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  InterventionEventSchema,
  LedgerEventSchema,
  RunConfigSchema,
  STREAM_SIGNER,
  TurnProposalEnvelopeSchema,
  TurnRecordSchema,
  fixedTokenInventory,
  otherRole,
  type AgentActionProposal,
  type AnchorPublisher,
  type AnchorReceipt,
  type BabyRole,
  type ChannelEvent,
  type CheckpointManifest,
  type CheckpointReason,
  type CheckpointService,
  type Clock,
  type EventStream,
  type ExperimentRecord,
  type GatewaySubmitResult,
  type GatewayTurnContext,
  type Intervention,
  type InterventionEvent,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LedgerEvent,
  type LedgerEventDraft,
  type NurseryRuntime,
  type Observation,
  type Outcome,
  type PolicyCheckpointRef,
  type RunConfig,
  type RunManifest,
  type RunState,
  type RunSummary,
  type TurnResult,
  type ScenarioEngine,
  type ScenarioInstance,
  type ScenarioSplit,
  type Sha256Hash,
  type SignerRegistry,
  type TurnProposalEnvelope,
  type TurnRecord,
  type VerificationReport,
} from '@ald/types';
import {
  InMemorySignerRegistry,
  canonicalJson,
  deriveSeedHex,
  formatChainViolation,
  hashCanonical,
  parseCanonicalJson,
  SeededPrng,
  validateChain,
} from '@ald/hashing';
import {
  SqliteEvidenceWriter,
  exportRunBundle,
  type EvidenceDatabase,
} from '@ald/evidence';
import { RunLifecycle, validateRunConfig } from '@ald/lifecycle';
import {
  ReferentialScenarioEngine,
  assertObservationHygiene,
  hashObservation,
} from '@ald/scenario';
import {
  createLearnerAdapterFactory,
  loadLearnerContract,
  promptBundleHash,
  type LearnerAdapterOptions,
  type TrackLearnerContract,
} from '@ald/learners';
import {
  InterpretationRejectedError,
  SymbolGatewayImpl,
  TurnDeadlineExceededError,
} from '@ald/gateway';

import {
  AnchorPolicyError,
  ConfigurationMismatchError,
  DuplicateRunError,
  RunConfigurationError,
  RunStateError,
  UnknownRunError,
  UnsupportedConditionError,
  VerifierNotConfiguredError,
} from './errors.js';
import { RuntimePrivateLedgerClient } from './private-ledger.js';
import {
  replayDigest,
  scenarioReplayCheck,
  type ScenarioReplayResult,
} from './replay.js';

/** Both Babies, in the fixed order used for every symmetric operation. */
export const BABY_ROLES = ['baby-a', 'baby-b'] as const;

/** Actor recorded on interventions the runtime itself performs (§14.2). */
export const NURSERY_ACTOR_ID = 'nursery-controller';

/** SPEC §11.9 `anchorTxRef` placeholder before a transaction exists. */
export const UNANCHORED_TX_REF = `0x${'0'.repeat(64)}`;

/** SPEC §18 default evaluation-phase budget. */
export const DEFAULT_EVALUATION_TURNS = 200;

/** Default episode batch for the §9.6 `shuffled` condition. */
export const DEFAULT_BATCH_SIZE = 50;

/** Reason code of the §7.2 governance decision that skips anchoring. */
export const ANCHORING_SKIPPED_REASON = 'anchoring-skipped-prototype-mode';

/** Deviation recorded in the Experiment Record when anchoring is skipped. */
export const ANCHORING_SKIPPED_DEVIATION =
  'anchoring-skipped-prototype-mode: no Base anchor was submitted, so this run ' +
  'can never be marked valid (SPECIFICATION.md §7.2, §13.4)';

export interface NurseryRuntimeOptions {
  /** Open evidence store shared by every run of this runtime (LEDGER §3). */
  database: EvidenceDatabase;
  /** Commit of the running software, recorded in checkpoints and manifests. */
  softwareCommit: string;
  /** Bundles are written to `<bundleRoot>/runs/<runId>`. */
  bundleRoot: string;
  /** Builds the Checkpoint Service for one run's writer (LEDGER §7-§9). */
  checkpointFactory: (
    evidence: SqliteEvidenceWriter,
    signers: SignerRegistry,
  ) => CheckpointService;
  /**
   * Per-run signer registry (LEDGER §11). Defaults to freshly generated
   * in-memory keys; production passes `FileKeyStore.provisionRun` /
   * `FileKeyStore.loadRun` so a restart can sign again with the same keys.
   */
  signerProvider?: (runId: string) => SignerRegistry;
  scenarioFactory?: (config: RunConfig) => ScenarioEngine;
  /** Per-role learner knobs; `shared` applies to both Babies. */
  learnerOptions?: {
    babyA?: LearnerAdapterOptions;
    babyB?: LearnerAdapterOptions;
    shared?: LearnerAdapterOptions;
  };
  /**
   * Overrides the adapter factory for one role. The default builds the
   * track named by the run configuration; tests use this seam to install a
   * misbehaving or instrumented adapter without touching `@ald/learners`.
   */
  adapterFactoryFor?: (
    config: RunConfig,
    role: BabyRole,
  ) => LearnerAdapterFactory;
  anchorPublisher?: AnchorPublisher;
  /**
   * `skip` is admissible only for a prototype-mode run and is recorded as a
   * governance decision plus an Experiment Record deviation (§7.2).
   */
  anchorPolicy?: 'required' | 'skip';
  verifier?: (bundleDir: string) => Promise<VerificationReport>;
  /** Writes `proofs/**` into an exported bundle (Checkpoint Service work). */
  proofWriter?: (runId: string, bundleDir: string) => Promise<void>;
  clock?: Clock;
  evaluationTurnsDefault?: number;
  learnerContractsFor?: (config: RunConfig) => TrackLearnerContract[];
  /** Episodes per `shuffled` batch; default `min(evaluationTurns, 50)`. */
  batchSize?: number;
  /** Actor id recorded on runtime-initiated interventions. */
  actorId?: string;
}

/** One prepared episode of a §9.6 `shuffled` batch. */
interface BatchSlot {
  turn: number;
  instance: ScenarioInstance;
  /** Validated sender envelope, replayed when the batch's turn executes. */
  envelope?: TurnProposalEnvelope;
  /** Set instead of `envelope` when the pre-pass proposal was rejected. */
  rejection?: Extract<GatewaySubmitResult, { kind: 'rejected' }>;
}

interface EpisodeBatch {
  split: ScenarioSplit;
  slots: BatchSlot[];
  /** Validated artifacts of the batch, in `batchIndex` order. */
  artifacts: AgentActionProposal['publicArtifact'][];
  /** `batchIndex` of each turn that contributed an artifact. */
  indexByTurn: Map<number, number>;
}

/** Everything the runtime keeps for one live run. */
interface RunRuntime {
  runId: string;
  config: RunConfig;
  configurationHash: Sha256Hash;
  writer: SqliteEvidenceWriter;
  signers: SignerRegistry;
  lifecycle: RunLifecycle;
  gateway: SymbolGatewayImpl;
  engine: ScenarioEngine;
  adapters: Record<BabyRole, LearnerAdapter>;
  checkpoints: CheckpointService;
  contracts: TrackLearnerContract[];
  symbolInventory: string[];
  bundleDir: string;
  /** Next turn index to execute. */
  turn: number;
  /** Episodes drawn from the `train` split so far. */
  trainingCount: number;
  /** Turns executed in the `evaluating` phase so far. */
  evaluationCount: number;
  evaluationTurns: number;
  policyRefs: Partial<Record<BabyRole, PolicyCheckpointRef>>;
  lastOutcome: Outcome | undefined;
  /** `size` sum of the three mandatory chains at the last checkpoint. */
  lastCheckpointEventTotal: number;
  nonces: SeededPrng;
  batch: EpisodeBatch | undefined;
  deviations: string[];
  anchorReceipt: AnchorReceipt | undefined;
  finalCheckpointHash: Sha256Hash | undefined;
  policiesDirCreated: boolean;
}

export interface RunToCompletionOptions {
  onTurn?: (result: TurnResult) => void | Promise<void>;
}

/**
 * Streams whose committed prefix the runtime re-validates before a resume.
 *
 * This pre-check exists so the `safety-trigger` audit entry can be written
 * before `EvidenceWriter.recover` blocks the run; `recover` itself re-walks
 * every stream and is authoritative. `validateChain` honours each stream's
 * own link field (`previousChannelHash` for the channel, SPEC §11.5).
 */
const PRECHECKED_STREAMS: readonly EventStream[] = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'turns',
];

function forfeitOutcome(reason: string, reasonCode: string): Outcome {
  return { success: false, reward: 0, details: { reason, reasonCode } };
}

/** `sha256:`-prefixed form; `RunConfigSchema` also accepts bare hex. */
function strictHash(value: string): Sha256Hash {
  const lowered = value.toLowerCase();
  return lowered.startsWith('sha256:') ? lowered : `sha256:${lowered}`;
}

/**
 * SPEC §8.1 step 9: roles reverse on a fixed schedule so neither Baby holds a
 * permanently privileged role.
 */
export function senderForTurn(turn: number, roleReversalPeriod: number): BabyRole {
  return Math.floor(turn / roleReversalPeriod) % 2 === 0 ? 'baby-a' : 'baby-b';
}

export class NurseryRuntimeImpl implements NurseryRuntime {
  readonly #options: NurseryRuntimeOptions;
  readonly #runs = new Map<string, RunRuntime>();
  readonly #clock: Clock;
  readonly #actorId: string;
  readonly #anchorPolicy: 'required' | 'skip';
  readonly #evaluationTurnsDefault: number;

  constructor(options: NurseryRuntimeOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
    this.#actorId = options.actorId ?? NURSERY_ACTOR_ID;
    this.#anchorPolicy = options.anchorPolicy ?? 'required';
    this.#evaluationTurnsDefault =
      options.evaluationTurnsDefault ?? DEFAULT_EVALUATION_TURNS;
  }

  // -------------------------------------------------------------------------
  // Run creation (SPEC §7.2 draft -> preregistered -> initializing -> running)
  // -------------------------------------------------------------------------

  async createRun(config: RunConfig): Promise<RunSummary> {
    const declared = validateRunConfig(config);
    if (!declared.ok) {
      throw new RunConfigurationError(declared.errors);
    }

    const contracts = this.#contractsFor(declared.config);
    const engine = this.#buildEngine(declared.config);

    // SPEC §15.1: the run is bound to the bundles it actually loaded. A
    // caller may pass the documented genesis placeholder and let the runtime
    // fill the real hash in; any other value must already agree.
    const resolvedConfig: RunConfig = {
      ...declared.config,
      promptBundleHash: this.#bindHash(
        'promptBundleHash',
        declared.config.promptBundleHash,
        promptBundleHash(contracts),
      ),
      scenarioBundleHash: this.#bindHash(
        'scenarioBundleHash',
        declared.config.scenarioBundleHash,
        engine.bundleHash,
      ),
    };

    const validated = validateRunConfig(resolvedConfig);
    if (!validated.ok) {
      throw new RunConfigurationError(validated.errors);
    }
    const runConfig = validated.config;
    const runId = runConfig.runId;
    if (this.#runs.has(runId)) {
      throw new DuplicateRunError(runId);
    }
    this.#assertConditionSupported(runConfig);
    this.#assertAnchorPolicy(runConfig);

    const signers = this.#signerProvider()(runId);
    const writer = new SqliteEvidenceWriter({
      database: this.#options.database,
      signers,
      clock: this.#clock,
      softwareCommit: this.#options.softwareCommit,
    });
    const { configurationHash } = writer.registerRun(runConfig);

    const lifecycle = new RunLifecycle(runId, 'draft');
    lifecycle.apply('preregister');
    lifecycle.apply('start');

    const symbolInventory = fixedTokenInventory(
      runConfig.symbolInventorySize ?? 32,
    );
    const gateway = new SymbolGatewayImpl(
      {
        runId,
        config: runConfig,
        symbolInventory,
        seed: runConfig.randomSeed,
      },
      writer,
    );

    const run: RunRuntime = {
      runId,
      config: runConfig,
      configurationHash,
      writer,
      signers,
      lifecycle,
      gateway,
      engine,
      adapters: this.#createAdapters(runConfig),
      checkpoints: this.#options.checkpointFactory(writer, signers),
      contracts,
      symbolInventory,
      bundleDir: this.#bundleDirFor(runId),
      turn: 0,
      trainingCount: 0,
      evaluationCount: 0,
      evaluationTurns: runConfig.evaluationTurns ?? this.#evaluationTurnsDefault,
      policyRefs: {},
      lastOutcome: undefined,
      lastCheckpointEventTotal: 0,
      nonces: new SeededPrng(runConfig.randomSeed).derive('nursery/nonce'),
      batch: undefined,
      deviations: [],
      anchorReceipt: undefined,
      finalCheckpointHash: undefined,
      policiesDirCreated: false,
    };
    this.#runs.set(runId, run);

    await this.#initializeAdapters(run);
    this.#appendExperimentRecord(run, {
      disposition: 'invalid',
      checkpointManifestRef: GENESIS_HASH,
      anchorTxRef: UNANCHORED_TX_REF,
      verifierReportRef: 'pending',
      deviations: [],
    });

    // §7.2 `initializing --ready--> running` requires checkpoint 0 first.
    await this.#checkpoint(run, 'run-initialized');
    lifecycle.apply('ready');

    return this.#summary(run);
  }

  // -------------------------------------------------------------------------
  // One turn (SPEC §8.1)
  // -------------------------------------------------------------------------

  async step(runId: string): Promise<TurnResult> {
    const run = this.#requireRun(runId);
    run.lifecycle.assertAcceptsTurn();

    const phase: TurnRecord['phase'] =
      run.lifecycle.state === 'evaluating' ? 'evaluating' : 'running';
    const turn = run.turn;
    const sender = senderForTurn(turn, run.config.roleReversalPeriod);
    const receiver = otherRole(sender);
    const split: ScenarioSplit = phase === 'evaluating' ? 'evaluation' : 'train';

    const slot = await this.#slotFor(run, turn, phase, split);
    const instance =
      slot?.instance ??
      run.engine.generate(this.#episodeIndex(run, phase), split, {
        sender,
        receiver,
      });

    // §8.1 step 1 / §10.1: the only observation a Baby ever sees comes from
    // the engine's builder and is re-checked by the hygiene filter here, so
    // there is no path into an adapter that bypasses the gate.
    const observations: Record<BabyRole, Observation> = {
      'baby-a': assertObservationHygiene(
        run.engine.observationFor(instance, runId, turn, 'baby-a'),
      ),
      'baby-b': assertObservationHygiene(
        run.engine.observationFor(instance, runId, turn, 'baby-b'),
      ),
    };
    for (const role of BABY_ROLES) {
      await run.adapters[role].observe(observations[role]);
    }

    const turnContext: GatewayTurnContext = {
      turn,
      sender,
      recipient: receiver,
      ...this.#batchBinding(run, turn),
    };

    let channelEvent: ChannelEvent | null = null;
    let babyProposalHash: Sha256Hash | null = null;
    let deliveredArtifactHash: Sha256Hash;
    let action: AgentActionProposal | null = null;
    let outcome: Outcome;
    let pauseRequested = false;

    if (run.config.communicationCondition === 'oracle') {
      // §9.6 `oracle`: the artifact is generated from researcher-only ground
      // truth and no learner output is used at all.
      const artifact = run.engine.oracleArtifact(instance);
      const control = await run.gateway.submitControlArtifact(
        turnContext,
        artifact,
      );
      channelEvent = control.channelEvent;
      deliveredArtifactHash = control.channelEvent.publicArtifactHash;
      action = run.engine.oracleAction(instance, artifact);
      outcome = run.engine.evaluate(instance, action);
    } else {
      const submission = await this.#submitSender(run, turnContext, slot, sender);
      channelEvent = submission.channelEvent;

      if (submission.kind === 'rejected') {
        // §8.3, §9.4: a rejected proposal forfeits the turn; the Scenario
        // Engine records a null action, never a retry.
        deliveredArtifactHash = submission.channelEvent.publicArtifactHash;
        outcome = forfeitOutcome('forfeit', submission.reasonCode);
        pauseRequested = submission.pauseRequested;
      } else {
        babyProposalHash = submission.babyProposalHash;
        deliveredArtifactHash = submission.deliveredArtifactHash;
        const receiverTurn = await this.#runReceiver(
          run,
          turnContext,
          receiver,
          instance,
          submission,
        );
        outcome = receiverTurn.outcome;
        action = receiverTurn.action;
        pauseRequested = receiverTurn.pauseRequested;
      }
    }

    // §8.1 step 7: only the approved nonverbal outcome reaches a Baby.
    for (const role of BABY_ROLES) {
      await run.adapters[role].onOutcome({
        runId,
        turn,
        role: role === sender ? 'sender' : 'receiver',
        success: outcome.success,
        reward:
          run.config.learningSignal === 'extrinsic-task' ? outcome.reward : null,
        payload: [outcome.success ? 1 : 0],
      });
    }

    // §8.1 step 8 / §7.2: `updatePolicy` is disabled once evaluation starts.
    if (phase === 'running') {
      for (const role of BABY_ROLES) {
        const adapter = run.adapters[role];
        if (adapter.updatePolicy) {
          run.policyRefs[role] = await adapter.updatePolicy({
            runId,
            turns: [turn],
            learningSignal: run.config.learningSignal,
          });
          await this.#writePolicyFile(run, role, 'latest');
        }
      }
    }

    const recordedOutcome: Record<string, unknown> = {
      success: outcome.success,
      reward: outcome.reward,
      details: outcome.details,
      ...(outcome.agreement === undefined ? {} : { agreement: outcome.agreement }),
      ...(outcome.utilities === undefined ? {} : { utilities: outcome.utilities }),
    };
    const turnRecord = await run.writer.appendTurnRecord({
      runId,
      turn,
      phase,
      roles: { sender, receiver },
      communicationCondition: run.config.communicationCondition,
      scenarioRef: instance.scenarioRef,
      scenarioStateHash: instance.stateHash,
      observationHashes: {
        babyA: hashObservation(observations['baby-a']),
        babyB: hashObservation(observations['baby-b']),
      },
      babyProposalHash,
      deliveredArtifactHash,
      channelEventHash: channelEvent?.entryHash ?? null,
      actionHash: hashCanonical(HASH_DOMAINS.action, action),
      outcomeHash: hashCanonical(HASH_DOMAINS.outcome, recordedOutcome),
      outcome: recordedOutcome,
    });

    run.lastOutcome = outcome;
    run.turn = turn + 1;
    if (phase === 'running') {
      run.trainingCount += 1;
    } else {
      run.evaluationCount += 1;
    }

    // LEDGER §9: a checkpoint every `checkpointEventInterval` accepted
    // events. The time-based trigger belongs to the Checkpoint Service.
    if (
      this.#eventTotal(run) - run.lastCheckpointEventTotal >=
      run.config.checkpointEventInterval
    ) {
      await this.#checkpoint(run, 'event-interval');
    }

    if (pauseRequested) {
      await this.#autoPause(run, turn);
    } else if (
      phase === 'running' &&
      run.turn >= run.config.maxTurnsPerRun
    ) {
      await this.#policyCheckpoint(run, turn);
      run.lifecycle.apply('begin-evaluation');
    } else if (
      phase === 'evaluating' &&
      run.evaluationCount >= run.evaluationTurns
    ) {
      run.lifecycle.apply('evaluation-complete');
    } else if (
      phase === 'running' &&
      run.turn % run.config.checkpointEventInterval === 0
    ) {
      await this.#policyCheckpoint(run, turn);
    }

    return {
      turn,
      phase,
      outcome,
      channelEvent,
      turnRecord,
      state: run.lifecycle.state,
    };
  }

  /** Steps until the run stops accepting turns, then seals it if it can. */
  async runToCompletion(
    runId: string,
    options: RunToCompletionOptions = {},
  ): Promise<RunSummary> {
    const run = this.#requireRun(runId);
    while (run.lifecycle.acceptsTurns) {
      const result = await this.step(runId);
      await options.onTurn?.(result);
    }
    if (run.lifecycle.state === 'sealing') {
      return this.seal(runId);
    }
    return this.#summary(run);
  }

  // -------------------------------------------------------------------------
  // Interventions (SPEC §7.3, §14.2, §14.5; ALD-026, ALD-059)
  // -------------------------------------------------------------------------

  async pause(runId: string, intervention: Intervention): Promise<RunSummary> {
    const run = this.#requireRun(runId);
    if (!run.lifecycle.canApply('pause')) {
      throw new RunStateError(runId, run.lifecycle.state, 'pause');
    }
    run.lifecycle.apply('pause');
    await run.writer.appendInterventionEvent({
      runId,
      eventType: 'pause',
      actorId: intervention.actorId,
      reasonCode: intervention.reasonCode,
      ...(intervention.details === undefined
        ? {}
        : { details: intervention.details }),
    });
    await this.#checkpoint(run, 'pause');
    run.lifecycle.apply('pause-complete');
    return this.#summary(run);
  }

  async resume(runId: string, intervention: Intervention): Promise<RunSummary> {
    const run = this.#requireRun(runId);
    if (!run.lifecycle.canApply('resume')) {
      throw new RunStateError(runId, run.lifecycle.state, 'resume');
    }
    run.lifecycle.apply('resume');

    const report = await this.#verifyCommittedPrefix(run);
    if (!report.ok) {
      return this.#summary(run);
    }

    await run.writer.appendInterventionEvent({
      runId,
      eventType: 'resume',
      actorId: intervention.actorId,
      reasonCode: intervention.reasonCode,
      details: {
        ...(intervention.details ?? {}),
        heads: report.heads,
      },
    });
    // §14.2: every operator intervention also produces a checkpoint.
    await this.#checkpoint(run, 'intervention');
    // §9.4: the rejection streak that triggered the pause has been reviewed
    // by the operator who resumed, so the counter starts again.
    run.gateway.resetRejectionCounter();
    run.lifecycle.apply('resume-complete');
    return this.#summary(run);
  }

  /**
   * SPEC §14.2 `annotate`: an operator note on a live run. It is an audited
   * intervention like pause and resume — same actor, same reason code, same
   * mandatory checkpoint — but it does not change the run state.
   */
  async annotate(
    runId: string,
    intervention: Intervention,
  ): Promise<InterventionEvent> {
    const run = this.#requireRun(runId);
    const event = await run.writer.appendInterventionEvent({
      runId,
      eventType: 'annotate',
      actorId: intervention.actorId,
      reasonCode: intervention.reasonCode,
      ...(intervention.details === undefined
        ? {}
        : { details: intervention.details }),
    });
    await this.#checkpoint(run, 'intervention');
    return event;
  }

  /**
   * SPEC §14.2: every human read is logged as a low-noise, informational
   * `human-view` audit event. It is deliberately not checkpointed — it
   * changes nothing — and never blocks the read it describes.
   */
  async recordHumanView(
    runId: string,
    intervention: Intervention,
  ): Promise<InterventionEvent> {
    const run = this.#requireRun(runId);
    return run.writer.appendInterventionEvent({
      runId,
      eventType: 'human-view',
      actorId: intervention.actorId,
      reasonCode: intervention.reasonCode,
      ...(intervention.details === undefined
        ? {}
        : { details: intervention.details }),
    });
  }

  async abort(runId: string, intervention: Intervention): Promise<RunSummary> {
    const run = this.#requireRun(runId);
    if (!run.lifecycle.canApply('abort')) {
      throw new RunStateError(runId, run.lifecycle.state, 'abort');
    }
    run.lifecycle.apply('abort');
    await run.writer.appendInterventionEvent({
      runId,
      eventType: 'abort',
      actorId: intervention.actorId,
      reasonCode: intervention.reasonCode,
      ...(intervention.details === undefined
        ? {}
        : { details: intervention.details }),
    });

    // LEDGER §15: an aborted run still receives `run.sealed`, a final
    // checkpoint, and an anchor attempt.
    await this.#appendRunSealedEvents(run);
    const manifest = await this.#checkpoint(run, 'run-aborted');
    run.finalCheckpointHash = manifest.checkpointHash;

    const anchor = await this.#anchor(run, manifest);
    if (anchor.blocked) {
      this.#appendExperimentRecord(run, {
        disposition: 'aborted',
        checkpointManifestRef: manifest.checkpointHash,
        anchorTxRef: UNANCHORED_TX_REF,
        verifierReportRef: 'not-run',
        deviations: [...run.deviations],
      });
      await this.#exportBundle(run);
      await this.#writeExperimentRecordFile(run);
      run.lifecycle.apply('seal-blocked');
      return this.#summary(run);
    }

    this.#appendExperimentRecord(run, {
      disposition: 'aborted',
      checkpointManifestRef: manifest.checkpointHash,
      anchorTxRef: anchor.receipt?.transactionHash ?? UNANCHORED_TX_REF,
      verifierReportRef: 'not-run',
      deviations: [...run.deviations],
    });
    await this.#exportBundle(run);
    await this.#writeExperimentRecordFile(run);
    run.lifecycle.apply('abort-complete');
    return this.#summary(run);
  }

  // -------------------------------------------------------------------------
  // Sealing (SPEC §7.2 `sealing`, §11.9, LEDGER §15)
  // -------------------------------------------------------------------------

  async seal(runId: string): Promise<RunSummary> {
    const run = this.#requireRun(runId);
    if (run.lifecycle.state !== 'sealing') {
      throw new RunStateError(runId, run.lifecycle.state, 'sealing');
    }

    await this.#policyCheckpoint(run, run.turn);
    await this.#appendRunSealedEvents(run);
    const manifest = await this.#checkpoint(run, 'run-sealed');
    run.finalCheckpointHash = manifest.checkpointHash;

    const anchor = await this.#anchor(run, manifest);
    if (anchor.blocked) {
      // §7.2: export or anchor unavailable after bounded retry.
      run.lifecycle.apply('seal-blocked');
      this.#appendExperimentRecord(run, {
        disposition: 'invalid',
        checkpointManifestRef: manifest.checkpointHash,
        anchorTxRef: UNANCHORED_TX_REF,
        verifierReportRef: 'not-run',
        deviations: [...run.deviations],
      });
      await this.#exportBundle(run);
      await this.#writeExperimentRecordFile(run);
      return this.#summary(run);
    }

    const anchored = anchor.receipt?.status === 'confirmed';
    this.#appendExperimentRecord(run, {
      disposition: 'invalid',
      checkpointManifestRef: manifest.checkpointHash,
      anchorTxRef: anchor.receipt?.transactionHash ?? UNANCHORED_TX_REF,
      verifierReportRef: 'pending-verification',
      deviations: [...run.deviations],
    });

    await this.#exportBundle(run);
    if (this.#options.proofWriter) {
      await this.#options.proofWriter(runId, run.bundleDir);
    }

    const report = this.#options.verifier
      ? await this.#options.verifier(run.bundleDir)
      : undefined;

    // §15.1: the Verifier is authoritative for integrity, so a run is only
    // `valid` once it is anchored *and* the report passed.
    this.#appendExperimentRecord(run, {
      disposition: anchored && report?.exitCode === 0 ? 'valid' : 'invalid',
      checkpointManifestRef: manifest.checkpointHash,
      anchorTxRef: anchor.receipt?.transactionHash ?? UNANCHORED_TX_REF,
      verifierReportRef: report
        ? hashCanonical(HASH_DOMAINS.runManifest, report)
        : 'not-run',
      deviations: [...run.deviations],
    });
    await this.#writeExperimentRecordFile(run);

    if (anchored) {
      run.lifecycle.apply('seal-complete');
    } else {
      // §7.2: an unanchorable run is `sealing-blocked`, and an operator who
      // abandons recovery ends at `aborted-sealed` with a permanent
      // `invalid` disposition.
      run.lifecycle.apply('seal-blocked');
      run.lifecycle.apply('abandon-recovery');
    }
    return this.#summary(run);
  }

  // -------------------------------------------------------------------------
  // Recovery and fork handling (SPEC §7.3, LEDGER §15; ALD-027)
  // -------------------------------------------------------------------------

  /**
   * Rebuilds one run from the evidence store after a restart: verify the
   * committed prefix, continue at the next unused sequence, reload the
   * per-Baby policies, and record an explicit recovery event.
   */
  async recover(runId: string): Promise<RunSummary> {
    const existing = this.#runs.get(runId);
    const run = existing ?? this.#reconstruct(runId);

    const report = await this.#verifyCommittedPrefix(run);
    if (!report.ok) {
      return this.#summary(run);
    }

    const records = this.#turnRecords(run);
    const last = records.at(-1);
    run.turn = last === undefined ? 0 : last.turn + 1;
    run.trainingCount = records.filter(
      (record) => record.phase === 'running',
    ).length;
    run.evaluationCount = records.filter(
      (record) => record.phase === 'evaluating',
    ).length;
    run.lastCheckpointEventTotal = this.#eventTotal(run);
    run.batch = undefined;

    const policyRestored: Record<string, boolean> = {};
    for (const role of BABY_ROLES) {
      const policy = await this.#readPolicyFile(run, role);
      policyRestored[role] = policy !== undefined;
      await this.#initializeAdapter(run, role, policy);
    }

    await run.writer.appendInterventionEvent({
      runId,
      eventType: 'recovery',
      actorId: this.#actorId,
      reasonCode: 'restart-recovery',
      details: {
        turnsRestored: records.length,
        nextTurn: run.turn,
        heads: report.heads,
        policyRestored,
      },
    });
    await this.#checkpoint(run, 'recovery');

    if (
      run.lifecycle.state === 'evaluating' &&
      run.evaluationCount >= run.evaluationTurns
    ) {
      run.lifecycle.apply('evaluation-complete');
    }
    return this.#summary(run);
  }

  // -------------------------------------------------------------------------
  // Reproducibility (SPEC §14.3)
  // -------------------------------------------------------------------------

  /** SPEC §14.3 execution-replay digest over this run's turn records. */
  replayDigest(runId: string): Sha256Hash {
    return replayDigest(this.#turnRecords(this.#requireRun(runId)));
  }

  /** SPEC §14.3 scenario replay from the recorded configuration and seed. */
  scenarioReplayCheck(runId: string): ScenarioReplayResult {
    const run = this.#requireRun(runId);
    const stored = run.writer.readRunMetadata(runId);
    const config = stored
      ? RunConfigSchema.parse(JSON.parse(stored.configurationJson))
      : run.config;
    return scenarioReplayCheck({
      runId,
      records: this.#turnRecords(run),
      engine: this.#buildEngine(config),
    });
  }

  // -------------------------------------------------------------------------
  // Queries (SPEC §12.5, §12.6)
  // -------------------------------------------------------------------------

  getRun(runId: string): RunSummary | undefined {
    const run = this.#runs.get(runId);
    return run === undefined ? undefined : this.#summary(run);
  }

  listRuns(): RunSummary[] {
    return [...this.#runs.values()].map((run) => this.#summary(run));
  }

  transcript(runId: string): ChannelEvent[] {
    return this.#readStream(runId, 'channel').map((event) =>
      ChannelEventSchema.parse(event),
    );
  }

  ledgers(runId: string): { babyA: LedgerEvent[]; babyB: LedgerEvent[] } {
    return {
      babyA: this.#readStream(runId, 'baby-a-ledger').map((event) =>
        LedgerEventSchema.parse(event),
      ),
      babyB: this.#readStream(runId, 'baby-b-ledger').map((event) =>
        LedgerEventSchema.parse(event),
      ),
    };
  }

  auditLog(runId: string): InterventionEvent[] {
    return this.#readStream(runId, 'intervention').map((event) =>
      InterventionEventSchema.parse(event),
    );
  }

  checkpoints(runId: string): CheckpointManifest[] {
    return this.#requireRun(runId).writer.readCheckpoints(runId);
  }

  experimentRecords(runId: string): ExperimentRecord[] {
    return this.#requireRun(runId).writer.readExperimentRecords(runId);
  }

  turnRecords(runId: string): TurnRecord[] {
    return this.#turnRecords(this.#requireRun(runId));
  }

  async exportBundle(runId: string, outputDir: string): Promise<RunManifest> {
    const run = this.#requireRun(runId);
    return exportRunBundle(run.writer, runId, outputDir, {
      softwareCommit: this.#options.softwareCommit,
      learnerContracts: run.contracts.map((contract) => ({
        track: contract.track,
        version: contract.version,
        text: contract.text,
      })),
      overwrite: true,
    });
  }

  async verify(runId: string, bundleDir: string): Promise<VerificationReport> {
    this.#requireRun(runId);
    const verifier = this.#options.verifier;
    if (!verifier) {
      throw new VerifierNotConfiguredError();
    }
    return verifier(bundleDir);
  }

  // -------------------------------------------------------------------------
  // Harness handles (read-only access for experiment analysis)
  // -------------------------------------------------------------------------

  writerFor(runId: string): SqliteEvidenceWriter {
    return this.#requireRun(runId).writer;
  }

  gatewayFor(runId: string): SymbolGatewayImpl {
    return this.#requireRun(runId).gateway;
  }

  adaptersFor(runId: string): Readonly<Record<BabyRole, LearnerAdapter>> {
    return this.#requireRun(runId).adapters;
  }

  bundleDirFor(runId: string): string {
    return this.#requireRun(runId).bundleDir;
  }

  // -------------------------------------------------------------------------
  // Turn internals
  // -------------------------------------------------------------------------

  /** SPEC §8.1 steps 2-4, plus the §8.3 response deadline. */
  async #submitSender(
    run: RunRuntime,
    turnContext: GatewayTurnContext,
    slot: BatchSlot | undefined,
    sender: BabyRole,
  ): Promise<GatewaySubmitResult> {
    if (slot?.rejection !== undefined) {
      return slot.rejection;
    }

    const cached = slot?.envelope;
    if (cached !== undefined) {
      return run.gateway.submitProposal(turnContext, cached);
    }

    let envelope: TurnProposalEnvelope;
    try {
      envelope = await run.gateway.withTurnDeadline(
        run.adapters[sender].act({
          turn: turnContext.turn,
          role: 'sender',
          responseBudgetMs: run.config.turnResponseBudgetMs,
          availableActions: [...run.gateway.carrierProtocol.allowedKinds],
        }),
        run.config.turnResponseBudgetMs,
      );
    } catch (error) {
      if (error instanceof TurnDeadlineExceededError) {
        return run.gateway.rejectForTimeout(turnContext, sender);
      }
      throw error;
    }
    return run.gateway.submitProposal(turnContext, envelope);
  }

  /** SPEC §8.1 steps 5-7 for the receiver half of one accepted turn. */
  async #runReceiver(
    run: RunRuntime,
    turnContext: GatewayTurnContext,
    receiver: BabyRole,
    instance: ScenarioInstance,
    submission: Extract<GatewaySubmitResult, { kind: 'accepted' }>,
  ): Promise<{
    outcome: Outcome;
    action: AgentActionProposal | null;
    pauseRequested: boolean;
  }> {
    const adapter = run.adapters[receiver];

    // §8.2 with `ledgerLagTurns: 0`: the interpretation event is committed
    // in the same turn cycle, before the receiver's own proposal.
    if (submission.delivery !== null) {
      const interpretation = await adapter.receive(submission.delivery);
      try {
        await run.gateway.submitInterpretation(
          turnContext,
          receiver,
          interpretation,
        );
      } catch (error) {
        if (!(error instanceof InterpretationRejectedError)) {
          throw error;
        }
        return {
          outcome: forfeitOutcome('forfeit', error.reasonCode),
          action: null,
          pauseRequested: error.pauseRequested,
        };
      }
    }

    let envelope: TurnProposalEnvelope;
    try {
      envelope = await run.gateway.withTurnDeadline(
        adapter.act({
          turn: turnContext.turn,
          role: 'receiver',
          responseBudgetMs: run.config.turnResponseBudgetMs,
          availableActions: ['select_object'],
          candidateRefs: instance.candidateRefs,
        }),
        run.config.turnResponseBudgetMs,
      );
    } catch (error) {
      if (!(error instanceof TurnDeadlineExceededError)) {
        throw error;
      }
      const rejection = await run.gateway.rejectForTimeout(
        turnContext,
        receiver,
      );
      return {
        outcome: forfeitOutcome('forfeit', rejection.reasonCode),
        action: null,
        pauseRequested: rejection.pauseRequested,
      };
    }

    const parsed = TurnProposalEnvelopeSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.proposal.kind !== 'select_object') {
      // §10.1/§14.2: a blocked field is an audited event, never a silent drop.
      await run.writer.appendInterventionEvent({
        runId: run.runId,
        eventType: 'hygiene-block',
        actorId: this.#actorId,
        reasonCode: 'invalid-task-action',
        details: { turn: turnContext.turn, role: receiver },
      });
      return {
        outcome: forfeitOutcome('invalid-task-action', 'invalid-task-action'),
        action: null,
        pauseRequested: false,
      };
    }

    await run.writer.appendLedgerEvent({
      runId: run.runId,
      babyId: babyIdForRole(receiver),
      turn: turnContext.turn,
      draft: parsed.data.privateLedgerDraft,
    });

    return {
      outcome: run.engine.evaluate(instance, parsed.data.proposal),
      action: parsed.data.proposal,
      pauseRequested: false,
    };
  }

  #episodeIndex(run: RunRuntime, phase: TurnRecord['phase']): number {
    return phase === 'evaluating' ? run.evaluationCount : run.trainingCount;
  }

  /**
   * SPEC §9.6 `shuffled` needs the whole batch's validated artifacts before
   * the batch's first delivery, so a batch is prepared in one pre-pass:
   * observe, act, validate, and commit any invalid proposal as a rejection.
   *
   * The pre-pass is only sound for a stateless adapter, which is why
   * `shuffled` is restricted to the `no-learning` track: a learning adapter
   * would be acting on turn `n + k` before it has seen the outcome of turn
   * `n`. The envelope produced here is the one the turn later submits, so no
   * adapter is asked to act twice for the same turn.
   */
  async #slotFor(
    run: RunRuntime,
    turn: number,
    phase: TurnRecord['phase'],
    split: ScenarioSplit,
  ): Promise<BatchSlot | undefined> {
    if (run.config.communicationCondition !== 'shuffled') {
      return undefined;
    }

    const active = run.batch?.slots.find((slot) => slot.turn === turn);
    if (active !== undefined) {
      return active;
    }

    const remaining =
      phase === 'evaluating'
        ? run.evaluationTurns - run.evaluationCount
        : run.config.maxTurnsPerRun - run.trainingCount;
    const size = Math.max(1, Math.min(this.#batchSize(run), remaining));

    const batch: EpisodeBatch = {
      split,
      slots: [],
      artifacts: [],
      indexByTurn: new Map(),
    };
    let episodeIndex = this.#episodeIndex(run, phase);

    for (let offset = 0; offset < size; offset += 1) {
      const slotTurn = turn + offset;
      const slotSender = senderForTurn(slotTurn, run.config.roleReversalPeriod);
      const slotReceiver = otherRole(slotSender);
      const instance = run.engine.generate(episodeIndex, split, {
        sender: slotSender,
        receiver: slotReceiver,
      });
      episodeIndex += 1;

      await run.adapters[slotSender].observe(
        assertObservationHygiene(
          run.engine.observationFor(instance, run.runId, slotTurn, slotSender),
        ),
      );
      const envelope = await run.gateway.withTurnDeadline(
        run.adapters[slotSender].act({
          turn: slotTurn,
          role: 'sender',
          responseBudgetMs: run.config.turnResponseBudgetMs,
          availableActions: [...run.gateway.carrierProtocol.allowedKinds],
        }),
        run.config.turnResponseBudgetMs,
      );

      const validation = run.gateway.carrierProtocol.validate(
        envelope.proposal,
        run.gateway.carrierContext,
      );
      if (!validation.ok) {
        // The Gateway owns rejection evidence: submitting the envelope now
        // commits the `channel.rejected` event with the right reason code
        // and excludes the episode from the batch.
        const rejected = await run.gateway.submitProposal(
          { turn: slotTurn, sender: slotSender, recipient: slotReceiver },
          envelope,
        );
        batch.slots.push(
          rejected.kind === 'rejected'
            ? { turn: slotTurn, instance, rejection: rejected }
            : { turn: slotTurn, instance },
        );
        continue;
      }

      batch.indexByTurn.set(slotTurn, batch.artifacts.length);
      batch.artifacts.push(validation.artifact);
      batch.slots.push({ turn: slotTurn, instance, envelope });
    }

    run.batch = batch;
    return batch.slots.find((slot) => slot.turn === turn);
  }

  #batchSize(run: RunRuntime): number {
    return (
      this.#options.batchSize ??
      Math.min(run.evaluationTurns, DEFAULT_BATCH_SIZE)
    );
  }

  #batchBinding(
    run: RunRuntime,
    turn: number,
  ): Pick<GatewayTurnContext, 'batchArtifacts' | 'batchIndex'> {
    const batch = run.batch;
    if (batch === undefined) {
      return {};
    }
    const batchIndex = batch.indexByTurn.get(turn);
    if (batchIndex === undefined) {
      return {};
    }
    return { batchArtifacts: batch.artifacts, batchIndex };
  }

  /** SPEC §9.4/§14.5: the automatic pause a rejection streak triggers. */
  async #autoPause(run: RunRuntime, turn: number): Promise<void> {
    if (!run.lifecycle.canApply('pause')) {
      // The §7.2 table has no pause out of this state; the Gateway already
      // committed the `safety-trigger` entry, so record why nothing paused.
      await run.writer.appendInterventionEvent({
        runId: run.runId,
        eventType: 'safety-trigger',
        actorId: this.#actorId,
        reasonCode: 'pause-not-available',
        details: { turn, state: run.lifecycle.state },
      });
      return;
    }
    run.lifecycle.apply('pause');
    await this.#checkpoint(run, 'pause');
    run.lifecycle.apply('pause-complete');
  }

  // -------------------------------------------------------------------------
  // Checkpoints, policies, records
  // -------------------------------------------------------------------------

  async #checkpoint(
    run: RunRuntime,
    reason: CheckpointReason,
  ): Promise<CheckpointManifest> {
    const manifest = await run.checkpoints.createCheckpoint(run.runId, reason);
    run.lastCheckpointEventTotal = this.#eventTotal(run);
    return manifest;
  }

  /** LEDGER §9: sizes of the three mandatory chains. */
  #eventTotal(run: RunRuntime): number {
    let total = 0;
    for (const stream of ['baby-a-ledger', 'baby-b-ledger', 'channel'] as const) {
      total += run.writer.chainHead(run.runId, stream).size;
    }
    return total;
  }

  /**
   * LEDGER §5/§9: a `policy.checkpointed` ledger event per Baby, the exported
   * policy on disk, and a checkpoint around it.
   */
  async #policyCheckpoint(run: RunRuntime, turn: number): Promise<void> {
    let wrote = false;
    for (const role of BABY_ROLES) {
      const adapter = run.adapters[role];
      if (!adapter.updatePolicy) {
        continue;
      }
      const policy = adapter.exportPolicy();
      const policyHash = hashCanonical(HASH_DOMAINS.policyCheckpoint, policy);
      const ref = run.policyRefs[role]?.policyCheckpointRef ?? `policy:${policyHash}`;
      const draft: LedgerEventDraft = {
        eventType: 'policy.checkpointed',
        contentSchema: 'agent-native-ledger',
        subjectId: 'policy',
        content: { policyCheckpointRef: ref, policyHash },
        blindingNonce: this.#nonce(run),
        evidenceRefs: [],
      };
      await run.writer.appendLedgerEvent({
        runId: run.runId,
        babyId: babyIdForRole(role),
        turn,
        draft,
      });
      await this.#writePolicyFile(run, role, String(turn));
      wrote = true;
    }
    if (wrote) {
      await this.#checkpoint(run, 'policy-checkpoint');
    }
  }

  async #appendRunSealedEvents(run: RunRuntime): Promise<void> {
    // The final checkpoint is created immediately after these events, so its
    // sequence is the next one the manifest chain will assign.
    const checkpointRef = `checkpoint:${run.writer.readCheckpoints(run.runId).length}`;
    for (const role of BABY_ROLES) {
      await run.writer.appendLedgerEvent({
        runId: run.runId,
        babyId: babyIdForRole(role),
        turn: run.turn,
        draft: {
          eventType: 'run.sealed',
          contentSchema: 'agent-native-ledger',
          subjectId: 'run',
          content: { checkpointRef },
          blindingNonce: this.#nonce(run),
          evidenceRefs: [],
        },
      });
    }
  }

  #nonce(run: RunRuntime): string {
    const high = run.nonces.nextUint32().toString(16).padStart(8, '0');
    const low = run.nonces.nextUint32().toString(16).padStart(8, '0');
    return `nonce:${high}${low}`;
  }

  /** SPEC §11.9: append-only, versioned by `(runId, recordVersion)`. */
  #appendExperimentRecord(
    run: RunRuntime,
    fields: Pick<
      ExperimentRecord,
      | 'disposition'
      | 'checkpointManifestRef'
      | 'anchorTxRef'
      | 'verifierReportRef'
      | 'deviations'
    >,
  ): ExperimentRecord {
    const previous = run.writer.readExperimentRecords(run.runId);
    const contract = run.contracts.find(
      (candidate) => candidate.track === run.config.babyA.track,
    );
    const record: ExperimentRecord = {
      version: 1,
      recordVersion: previous.length + 1,
      runId: run.runId,
      experimentId: run.config.experimentId,
      deploymentMode: run.config.deploymentMode,
      learnerContractVersion: `${run.config.babyA.track}.v${contract?.version ?? '1'}`,
      runConfigRef: run.configurationHash,
      protocolGitCommit: run.config.protocolGitCommit,
      preRegistrationHash: run.config.preRegistrationHash,
      claimBoundaryStatement:
        CLAIM_BOUNDARY_STATEMENTS[run.config.deploymentMode],
      ...fields,
    };
    run.writer.appendExperimentRecord(record);
    return record;
  }

  /**
   * `experiment-record.json` carries the current record plus its full
   * history (`ExperimentRecordFileSchema`). The exporter writes it from the
   * store at export time, so the file is rewritten here once the later
   * versions exist.
   */
  async #writeExperimentRecordFile(run: RunRuntime): Promise<void> {
    const history = run.writer.readExperimentRecords(run.runId);
    const current = history.at(-1);
    if (current === undefined) {
      return;
    }
    await mkdir(run.bundleDir, { recursive: true });
    await writeFile(
      join(run.bundleDir, 'experiment-record.json'),
      `${canonicalJson({ current, history })}\n`,
      'utf8',
    );
  }

  async #exportBundle(run: RunRuntime): Promise<RunManifest> {
    await mkdir(run.bundleDir, { recursive: true });
    return this.exportBundle(run.runId, run.bundleDir);
  }

  // -------------------------------------------------------------------------
  // Anchoring (LEDGER §10, SPEC §13.4)
  // -------------------------------------------------------------------------

  async #anchor(
    run: RunRuntime,
    manifest: CheckpointManifest,
  ): Promise<{ receipt?: AnchorReceipt; blocked: boolean }> {
    const publisher = this.#options.anchorPublisher;
    if (publisher) {
      try {
        const submitted = await publisher.submit(manifest);
        const receipt = await publisher.awaitConfirmation(submitted);
        run.writer.insertAnchorReceipt(receipt);
        run.anchorReceipt = receipt;
        return { receipt, blocked: false };
      } catch (error) {
        run.deviations.push(
          `anchor-unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { blocked: true };
      }
    }

    // §7.2: skipping the anchor is an audited governance decision and a
    // permanent deviation; the run can never be marked valid.
    await run.writer.appendInterventionEvent({
      runId: run.runId,
      eventType: 'governance-decision',
      actorId: this.#actorId,
      reasonCode: ANCHORING_SKIPPED_REASON,
      details: {
        deploymentMode: run.config.deploymentMode,
        anchorNetwork: run.config.anchorNetwork,
        checkpointHash: manifest.checkpointHash,
      },
    });
    if (!run.deviations.includes(ANCHORING_SKIPPED_DEVIATION)) {
      run.deviations.push(ANCHORING_SKIPPED_DEVIATION);
    }
    return { blocked: false };
  }

  // -------------------------------------------------------------------------
  // Integrity (LEDGER §15)
  // -------------------------------------------------------------------------

  /**
   * SPEC §7.3: verify the committed prefix before accepting new writes. The
   * read-only pre-check runs first so the `safety-trigger` audit entry can
   * still be written — `EvidenceWriter.recover` blocks every write of a run
   * whose prefix does not verify, interventions included.
   */
  async #verifyCommittedPrefix(
    run: RunRuntime,
  ): Promise<{ ok: boolean; heads: { stream: EventStream; size: number }[] }> {
    const findings = this.#integrityFindings(run);
    if (findings.length > 0) {
      try {
        await run.writer.appendInterventionEvent({
          runId: run.runId,
          eventType: 'safety-trigger',
          actorId: this.#actorId,
          reasonCode: 'integrity-violation',
          details: { findings: findings.slice(0, 32) },
        });
      } catch {
        // The writer that lost the race is already blocked for this run
        // (LEDGER §15), so the audit entry cannot be appended. The preserved
        // fork artifacts and the `forked-invalid` state below are the
        // evidence; nothing is retried or truncated.
      }
    }

    const report = await run.writer.recover(run.runId);
    if (!report.ok) {
      if (run.lifecycle.canApply('fork-detected')) {
        run.lifecycle.apply('fork-detected');
      }
      return { ok: false, heads: report.heads };
    }
    return { ok: true, heads: report.heads };
  }

  #integrityFindings(run: RunRuntime): string[] {
    const findings: string[] = [];
    for (const artifact of run.writer.readForkArtifacts(run.runId)) {
      findings.push(
        `fork ${artifact.stream}#${artifact.sequence}: ${artifact.entryHash}`,
      );
    }

    const keys = new Map(
      run.writer
        .readRunSigners(run.runId)
        .map((signer) => [signer.domain, signer.publicKey]),
    );
    for (const stream of PRECHECKED_STREAMS) {
      const events = this.#readStream(run.runId, stream);
      const publicKey = keys.get(
        STREAM_SIGNER[stream as Exclude<EventStream, 'intervention'>],
      );
      const result = validateChain(stream, events, {
        runId: run.runId,
        requireSignatures: true,
        ...(publicKey === undefined ? {} : { publicKey }),
        ...(stream === 'baby-a-ledger'
          ? { babyId: 'A' as const }
          : stream === 'baby-b-ledger'
            ? { babyId: 'B' as const }
            : {}),
      });
      findings.push(
        ...result.violations.map((violation) =>
          formatChainViolation(stream, violation),
        ),
      );
    }
    return findings;
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  #signerProvider(): (runId: string) => SignerRegistry {
    return (
      this.#options.signerProvider ??
      ((runId: string) => InMemorySignerRegistry.generate(runId))
    );
  }

  #buildEngine(config: RunConfig): ScenarioEngine {
    if (this.#options.scenarioFactory) {
      return this.#options.scenarioFactory(config);
    }
    return new ReferentialScenarioEngine(
      {
        version: 1,
        symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
        interactionMode: config.interactionMode,
      },
      config.randomSeed,
    );
  }

  #contractsFor(config: RunConfig): TrackLearnerContract[] {
    if (this.#options.learnerContractsFor) {
      return this.#options.learnerContractsFor(config);
    }
    const tracks = [...new Set([config.babyA.track, config.babyB.track])];
    return tracks.map((track) => loadLearnerContract(track));
  }

  #learnerOptions(role: BabyRole): LearnerAdapterOptions {
    const options = this.#options.learnerOptions ?? {};
    return {
      ...options.shared,
      ...(role === 'baby-a' ? options.babyA : options.babyB),
    };
  }

  #createAdapters(config: RunConfig): Record<BabyRole, LearnerAdapter> {
    const build = (role: BabyRole): LearnerAdapter => {
      if (this.#options.adapterFactoryFor) {
        return this.#options.adapterFactoryFor(config, role).create();
      }
      const track = role === 'baby-a' ? config.babyA.track : config.babyB.track;
      return createLearnerAdapterFactory(
        track,
        this.#learnerOptions(role),
      ).create();
    };
    return { 'baby-a': build('baby-a'), 'baby-b': build('baby-b') };
  }

  async #initializeAdapters(run: RunRuntime): Promise<void> {
    for (const role of BABY_ROLES) {
      const initialPolicy = await this.#readParentPolicy(run, role);
      await this.#initializeAdapter(run, role, initialPolicy);
    }
  }

  async #initializeAdapter(
    run: RunRuntime,
    role: BabyRole,
    initialPolicy: unknown,
  ): Promise<void> {
    const track = role === 'baby-a' ? run.config.babyA.track : run.config.babyB.track;
    const contract =
      run.contracts.find((candidate) => candidate.track === track) ??
      run.contracts[0];
    if (contract === undefined) {
      throw new RunConfigurationError([
        { path: 'promptBundleHash', message: `no learner contract for ${track}` },
      ]);
    }
    await run.adapters[role].init({
      runId: run.runId,
      role,
      babyId: babyIdForRole(role),
      config: run.config,
      learnerContract: contract,
      // §6.2: the per-Baby seed is private and is never shared with the
      // other Baby or with the Gateway.
      seed: deriveSeedHex(run.config.randomSeed, role),
      symbolInventory: run.symbolInventory,
      ledger: new RuntimePrivateLedgerClient(
        run.writer,
        run.runId,
        babyIdForRole(role),
        () => run.turn,
      ),
      ...(initialPolicy === undefined ? {} : { initialPolicy }),
    });
  }

  /** SPEC §7.4: a derived run starts from the parent's exported policy. */
  async #readParentPolicy(run: RunRuntime, role: BabyRole): Promise<unknown> {
    if (run.config.parentRunId === undefined) {
      return undefined;
    }
    return this.#readPolicyFileAt(
      join(this.#bundleDirFor(run.config.parentRunId), 'policies'),
      role,
      'latest',
    );
  }

  #reconstruct(runId: string): RunRuntime {
    const signers = this.#signerProvider()(runId);
    const writer = new SqliteEvidenceWriter({
      database: this.#options.database,
      signers,
      clock: this.#clock,
      softwareCommit: this.#options.softwareCommit,
    });
    const metadata = writer.readRunMetadata(runId);
    if (metadata === undefined) {
      throw new UnknownRunError(runId);
    }
    const config = RunConfigSchema.parse(JSON.parse(metadata.configurationJson));
    const contracts = this.#contractsFor(config);
    const evaluationTurns =
      config.evaluationTurns ?? this.#evaluationTurnsDefault;

    const records = writer
      .readEvents(runId, 'turns')
      .map((event) => TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)));
    const lastRecord = records.at(-1);
    const evaluationCount = records.filter(
      (record) => record.phase === 'evaluating',
    ).length;
    const trainingCount = records.filter(
      (record) => record.phase === 'running',
    ).length;
    const state: RunState =
      evaluationCount > 0 || trainingCount >= config.maxTurnsPerRun
        ? 'evaluating'
        : 'running';

    const symbolInventory = fixedTokenInventory(config.symbolInventorySize ?? 32);
    const run: RunRuntime = {
      runId,
      config,
      configurationHash: strictHash(metadata.configurationHash),
      writer,
      signers,
      lifecycle: new RunLifecycle(runId, state),
      gateway: new SymbolGatewayImpl(
        { runId, config, symbolInventory, seed: config.randomSeed },
        writer,
      ),
      engine: this.#buildEngine(config),
      adapters: this.#createAdapters(config),
      checkpoints: this.#options.checkpointFactory(writer, signers),
      contracts,
      symbolInventory,
      bundleDir: this.#bundleDirFor(runId),
      turn: lastRecord === undefined ? 0 : lastRecord.turn + 1,
      trainingCount,
      evaluationCount,
      evaluationTurns,
      policyRefs: {},
      lastOutcome: undefined,
      lastCheckpointEventTotal: 0,
      nonces: new SeededPrng(config.randomSeed).derive('nursery/nonce'),
      batch: undefined,
      deviations: [],
      anchorReceipt: undefined,
      finalCheckpointHash: undefined,
      policiesDirCreated: false,
    };
    this.#runs.set(runId, run);
    return run;
  }

  #assertConditionSupported(config: RunConfig): void {
    if (config.communicationCondition !== 'shuffled') {
      return;
    }
    if (
      config.babyA.track !== 'no-learning' ||
      config.babyB.track !== 'no-learning'
    ) {
      throw new UnsupportedConditionError(
        'the shuffled condition pre-generates a batch of proposals and is ' +
          'therefore restricted to the stateless no-learning track (SPEC §9.6)',
      );
    }
  }

  #assertAnchorPolicy(config: RunConfig): void {
    if (this.#anchorPolicy === 'skip') {
      if (config.deploymentMode !== 'prototype') {
        throw new AnchorPolicyError(
          `anchorPolicy "skip" is only permitted in prototype mode, not ${config.deploymentMode}`,
        );
      }
      return;
    }
    if (!this.#options.anchorPublisher) {
      throw new AnchorPolicyError(
        'anchorPolicy "required" needs an anchorPublisher (SPEC §7.2, §13.4)',
      );
    }
  }

  #bindHash(
    field: 'scenarioBundleHash' | 'promptBundleHash',
    declared: string,
    actual: string,
  ): string {
    if (declared === GENESIS_HASH) {
      return actual;
    }
    if (strictHash(declared) !== strictHash(actual)) {
      throw new ConfigurationMismatchError(field, declared, actual);
    }
    return declared;
  }

  // -------------------------------------------------------------------------
  // Files and small helpers
  // -------------------------------------------------------------------------

  #bundleDirFor(runId: string): string {
    return join(this.#options.bundleRoot, 'runs', runId);
  }

  #policiesDir(run: RunRuntime): string {
    return join(run.bundleDir, 'policies');
  }

  async #writePolicyFile(
    run: RunRuntime,
    role: BabyRole,
    label: string,
  ): Promise<void> {
    const directory = this.#policiesDir(run);
    if (!run.policiesDirCreated) {
      await mkdir(directory, { recursive: true });
      run.policiesDirCreated = true;
    }
    const policy = run.adapters[role].exportPolicy();
    await writeFile(
      join(directory, this.#policyFileName(role, label)),
      `${canonicalJson(policy)}\n`,
      'utf8',
    );
  }

  /**
   * `docs/evidence-bundle-format.md` §1 names per-turn policy checkpoints
   * `<role>-policy-<turn>.json`; `<role>-latest.json` is the rolling copy the
   * recovery path reloads.
   */
  #policyFileName(role: BabyRole, label: string): string {
    return label === 'latest'
      ? `${role}-latest.json`
      : `${role}-policy-${label}.json`;
  }

  async #readPolicyFile(run: RunRuntime, role: BabyRole): Promise<unknown> {
    return this.#readPolicyFileAt(this.#policiesDir(run), role, 'latest');
  }

  async #readPolicyFileAt(
    directory: string,
    role: BabyRole,
    label: string,
  ): Promise<unknown> {
    try {
      const text = await readFile(
        join(directory, this.#policyFileName(role, label)),
        'utf8',
      );
      return parseCanonicalJson(text.trimEnd());
    } catch {
      return undefined;
    }
  }

  #readStream(runId: string, stream: EventStream): Record<string, unknown>[] {
    const run = this.#requireRun(runId);
    return run.writer
      .readEvents(runId, stream)
      .map(
        (event) =>
          parseCanonicalJson(event.canonicalJson) as Record<string, unknown>,
      );
  }

  #turnRecords(run: RunRuntime): TurnRecord[] {
    return run.writer
      .readEvents(run.runId, 'turns')
      .map((event) =>
        TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)),
      );
  }

  #requireRun(runId: string): RunRuntime {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new UnknownRunError(runId);
    }
    return run;
  }

  #summary(run: RunRuntime): RunSummary {
    return {
      runId: run.runId,
      experimentId: run.config.experimentId,
      deploymentMode: run.config.deploymentMode,
      state: run.lifecycle.state,
      turn: run.turn,
      configurationHash: run.configurationHash,
    };
  }
}

/** Builds a Nursery Controller runtime over one open evidence store. */
export function createNurseryRuntime(
  options: NurseryRuntimeOptions,
): NurseryRuntimeImpl {
  return new NurseryRuntimeImpl(options);
}
