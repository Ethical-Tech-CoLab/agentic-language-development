/**
 * `RemoteLearnerAdapter` — a `LearnerAdapter` (SPEC §6.2) whose state lives in
 * another process or container (SPEC §5.2, §5.3, §10.3; ALD-053, ALD-055,
 * ALD-056, ALD-040 transport half).
 *
 * From the Nursery runtime's side nothing changes: it holds an object with
 * `init`/`observe`/`act`/`receive`/`onOutcome`/`updatePolicy`/`exportPolicy`
 * and hands it the same `PrivateLedgerClient` it hands an in-process adapter.
 * Three things about that are not free across a process boundary, and this
 * file is mostly about them.
 *
 * **1. `exportPolicy()` is synchronous.** A boundary is not. Every method that
 * can move policy state answers with a `policyDigest`; when the digest
 * changes, the proxy pulls the policy once (`export_policy`) *before*
 * returning, recomputes the digest locally, and caches the value. So the
 * synchronous accessor is always the state as of the last completed call, and
 * the recomputation doubles as an integrity check: the digest the host
 * computed over its own object must equal the digest the runtime computes
 * after the round trip, which is what makes "identical policy hash to the
 * in-process adapter for the same seed" a property of the transport rather
 * than a coincidence.
 *
 * **2. Optional members must be visible before `init`.** SPEC §6.2 makes
 * `updatePolicy` absent for `no-learning` and `frozen-llm`, and callers test
 * for it (`@ald/learners`' conformance harness checks it before `init`). The
 * proxy declares `updatePolicy` from the track alone — the one rule the SPEC
 * fixes — and reconciles the rest of the optional members against the host's
 * `init` handshake, installing or deleting them so the proxy's surface is the
 * hosted adapter's surface.
 *
 * **3. Timing.** In Mode R turn timing normalization is a MUST (SPEC §5.3,
 * §10.3): "a rejected/failed turn and an accepted turn MUST produce externally
 * indistinguishable timing/size profiles where technically feasible". With
 * `timing: 'normalized'` every turn-path call returns on a fixed schedule —
 * padded to the deadline tick — whether the host answered in one millisecond,
 * threw, or never answered at all. Frame padding does the same for size.
 * `timing: 'immediate'` exists for Mode P and for tests; it is not admissible
 * for a Mode R run and `@ald/lifecycle`'s mode policy is what enforces that.
 */
import {
  HASH_DOMAINS,
  type AffectStateMeasurement,
  type CurriculumStage,
  type DeliveredChannelArtifact,
  type IsolationBoundary,
  type IsolationDescriptor,
  type LearnerAdapter,
  type LearnerInitContext,
  type LearnerProvenance,
  type LearnerTrackId,
  type LearnerVisibleRunConfig,
  type LedgerDraftEnvelope,
  type Observation,
  type OutcomeEvent,
  type PolicyCheckpointRef,
  type PrivateLedgerClient,
  type Sha256Hash,
  type TurnBudget,
  type TurnProposalEnvelope,
  type UpdateBatch,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';

import { FrameConnection, type FrameChannel } from './channel.js';
import {
  HostProtocolError,
  IsolationError,
  isHostProtocolError,
  type HostErrorCode,
} from './errors.js';
import { DEFAULT_FRAME_SIZE } from './frames.js';
import {
  CheckpointResultSchema,
  EnvelopeResultSchema,
  ExportPolicyResultSchema,
  HOST_CAPABILITIES,
  InitResultSchema,
  IsolationDescriptorSchema,
  IsolationProbeResultSchema,
  LedgerAppendParamsSchema,
  MeasureAffectResultSchema,
  PolicyStateResultSchema,
  ProvenanceResultSchema,
  TURN_PATH_METHODS,
  type HostCapability,
  type HostMethod,
  type IsolationProbeResult,
} from './protocol.js';
import { systemTimer, type IsolationTimer } from './timer.js';

/** Fallback per-call deadline when no configuration has been seen yet. */
export const DEFAULT_CALL_DEADLINE_MS = 30_000;

/** Grace period for the `shutdown` courtesy call in `dispose()`. */
const SHUTDOWN_DEADLINE_MS = 1000;

/**
 * SPEC §6.2: "`updatePolicy` is absent for the no-learning and frozen-llm
 * tracks". This is the only capability the proxy can know before the
 * handshake, and it must know it: callers branch on the property.
 */
export const TRACKS_WITHOUT_POLICY_UPDATES: readonly LearnerTrackId[] = [
  'no-learning',
  'frozen-llm',
];

const TURN_PATH: ReadonlySet<string> = new Set(TURN_PATH_METHODS);

/** One learner host, however it is reached. */
export interface HostTransport {
  readonly boundary: IsolationBoundary;
  readonly hostLabel?: string;
  /** The channel if the transport already has one (a spawned child does). */
  current(): FrameChannel | undefined;
  /** Open (or return) the channel. Called once, from `init`. */
  open(): Promise<FrameChannel>;
  /** Kill the host without a handshake. Used by `dispose` and kill tests. */
  terminate(): Promise<void>;
}

export interface RemoteLearnerAdapterOptions {
  track: LearnerTrackId;
  transport: HostTransport;
  /** JSON-safe options for the host's `createLearnerAdapterFactory` call. */
  learnerOptions?: Record<string, unknown>;
  frameSize?: number;
  maxPayloadBytes?: number;
  /** Mode R requires `normalized` (SPEC §5.3). Default `normalized`. */
  timing?: 'normalized' | 'immediate';
  /** Overrides `RunConfig.turnResponseBudgetMs` as the per-call deadline. */
  deadlineMs?: number;
  timer?: IsolationTimer;
}

/** Runtime-side counters. Never sent anywhere; never Baby-visible. */
export interface RemoteAdapterDiagnostics {
  calls: number;
  deadlineExceeded: number;
  hostErrors: number;
  policyRefreshes: number;
  paddedCalls: number;
  ledgerAppends: number;
}

export class RemoteLearnerAdapter implements LearnerAdapter {
  readonly track: LearnerTrackId;

  readonly diagnostics: RemoteAdapterDiagnostics = {
    calls: 0,
    deadlineExceeded: 0,
    hostErrors: 0,
    policyRefreshes: 0,
    paddedCalls: 0,
    ledgerAppends: 0,
  };

  /** Present exactly when the hosted adapter has it (SPEC §6.2). */
  updatePolicy?: (batch: UpdateBatch) => Promise<PolicyCheckpointRef>;
  measureAffect?: () => Promise<AffectStateMeasurement>;
  applyCurriculumStage?: (stage: CurriculumStage) => Promise<void>;
  describeProvenance?: () => LearnerProvenance;

  private readonly options: RemoteLearnerAdapterOptions;
  private readonly timer: IsolationTimer;
  private readonly timing: 'normalized' | 'immediate';
  private connection: FrameConnection | undefined;
  private ledger: PrivateLedgerClient | undefined;
  private config: LearnerVisibleRunConfig | undefined;
  private descriptor: IsolationDescriptor;
  private provenance: LearnerProvenance | undefined;
  private policy: { digest: Sha256Hash; value: unknown } | undefined;
  private capabilities: readonly HostCapability[] = [];
  private disposed = false;
  private lastLedgerFailure: unknown;

  constructor(options: RemoteLearnerAdapterOptions) {
    this.options = options;
    this.track = options.track;
    this.timer = options.timer ?? systemTimer;
    this.timing = options.timing ?? 'normalized';

    const processId = options.transport.current()?.processId;
    this.descriptor = {
      boundary: options.transport.boundary,
      timingNormalization: this.timing,
      ...(processId === undefined ? {} : { processId }),
      ...(options.transport.hostLabel === undefined
        ? {}
        : { hostLabel: options.transport.hostLabel }),
    };

    if (!TRACKS_WITHOUT_POLICY_UPDATES.includes(options.track)) {
      this.installCapability('updatePolicy');
    }
  }

  /** SPEC §5.3: where this adapter executes. Enriched by the handshake. */
  get isolation(): IsolationDescriptor {
    return { ...this.descriptor };
  }

  /** The host's own error, kept locally for the operator (never on the wire). */
  get lastLedgerError(): unknown {
    return this.lastLedgerFailure;
  }

  /** Frame/byte counters of the boundary, for the ALD-040 measurements. */
  get transportStats(): FrameConnection['stats'] | undefined {
    return this.connection?.stats;
  }

  async init(context: LearnerInitContext): Promise<void> {
    if (this.disposed) {
      throw new IsolationError('disposed', { method: 'init' });
    }
    if (this.connection !== undefined) {
      throw new IsolationError('already-initialized', { method: 'init' });
    }
    this.config = context.config;
    this.ledger = context.ledger;

    const channel = await this.options.transport.open();
    this.connection = new FrameConnection({
      channel,
      originator: 'r',
      frameSize: this.options.frameSize ?? DEFAULT_FRAME_SIZE,
      ...(this.options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: this.options.maxPayloadBytes }),
      timer: this.timer,
      handler: (method, params) => this.serveHostRequest(method, params),
      errorCodeFor: (error) => runtimeWireCodeFor(error),
    });
    const channelProcessId = channel.processId;
    if (channelProcessId !== undefined) {
      this.descriptor = { ...this.descriptor, processId: channelProcessId };
    }

    const result = await this.call(
      'init',
      {
        track: this.track,
        ...(this.options.learnerOptions === undefined
          ? {}
          : { learnerOptions: this.options.learnerOptions }),
        runId: context.runId,
        role: context.role,
        babyId: context.babyId,
        config: learnerVisibleWireConfig(context.config),
        learnerContract: {
          version: context.learnerContract.version,
          text: context.learnerContract.text,
          ...(context.learnerContract.track === undefined
            ? {}
            : { track: context.learnerContract.track }),
        },
        seed: context.seed,
        symbolInventory: [...context.symbolInventory],
        ...(context.initialPolicy === undefined
          ? {}
          : { initialPolicy: context.initialPolicy }),
      },
      (raw) => InitResultSchema.parse(raw),
    );

    this.reconcileCapabilities(result.capabilities);
    this.descriptor = mergeDescriptor(this.descriptor, result.isolation);
    this.provenance = result.provenance;
    await this.syncPolicy(result.policyDigest, 'init');
  }

  async observe(observation: Observation): Promise<void> {
    const result = await this.call(
      'observe',
      {
        runId: observation.runId,
        turn: observation.turn,
        recipient: observation.recipient,
        encoding: observation.encoding,
        payload: observation.payload,
        scenarioRef: observation.scenarioRef,
      },
      (raw) => PolicyStateResultSchema.parse(raw),
    );
    await this.syncPolicy(result.policyDigest, 'observe');
  }

  async act(budget: TurnBudget): Promise<TurnProposalEnvelope> {
    const result = await this.call(
      'act',
      {
        turn: budget.turn,
        role: budget.role,
        responseBudgetMs: budget.responseBudgetMs,
        availableActions: [...budget.availableActions],
        ...(budget.candidateRefs === undefined
          ? {}
          : { candidateRefs: [...budget.candidateRefs] }),
        ...(budget.window === undefined ? {} : { window: budget.window }),
      },
      (raw) => EnvelopeResultSchema.parse(raw),
    );
    await this.syncPolicy(result.policyDigest, 'act');
    // Verbatim: judging the envelope is the Gateway's job (SPEC §9.4).
    return result.envelope as TurnProposalEnvelope;
  }

  async receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope> {
    const result = await this.call(
      'receive',
      {
        runId: delivery.runId,
        turn: delivery.turn,
        logicalSender: delivery.logicalSender,
        carrier: delivery.carrier,
        publicArtifact: delivery.publicArtifact,
        channelEventHash: delivery.channelEventHash,
      },
      (raw) => EnvelopeResultSchema.parse(raw),
    );
    await this.syncPolicy(result.policyDigest, 'receive');
    return result.envelope as LedgerDraftEnvelope;
  }

  async onOutcome(outcome: OutcomeEvent): Promise<void> {
    const result = await this.call(
      'on_outcome',
      outcomeToWire(outcome),
      (raw) => PolicyStateResultSchema.parse(raw),
    );
    await this.syncPolicy(result.policyDigest, 'on_outcome');
  }

  /**
   * The policy as of the last completed call (see this file's header). Throws
   * rather than guessing when the handshake has not happened: a policy
   * checkpoint hash over a placeholder would be evidence of nothing.
   */
  exportPolicy(): unknown {
    if (this.policy === undefined) {
      throw new IsolationError('not-initialized', { method: 'exportPolicy' });
    }
    return this.policy.value;
  }

  /** Digest of {@link exportPolicy}, recomputed locally after each refresh. */
  get policyDigest(): Sha256Hash | undefined {
    return this.policy?.digest;
  }

  /**
   * Ask the host to attempt each access SPEC §10.3 says it does not have.
   * Returns outcome codes only (see `protocol.ts`).
   */
  async probeIsolation(
    request: {
      readPath?: string;
      connect?: { host: string; port: number; timeoutMs?: number };
    } = {},
  ): Promise<IsolationProbeResult> {
    return this.call(
      'isolation_probe',
      {
        ...(request.readPath === undefined ? {} : { readPath: request.readPath }),
        ...(request.connect === undefined ? {} : { connect: request.connect }),
      },
      (raw) => IsolationProbeResultSchema.parse(raw),
    );
  }

  /**
   * Re-read the hosted adapter's self-declared provenance (SPEC §6.5).
   *
   * `describeProvenance()` is synchronous, so the value it returns is the one
   * captured at `init`; this is how a caller that wants a fresh declaration —
   * the ALD-057 semantic-leakage battery, for instance — asks for one.
   */
  async refreshProvenance(): Promise<LearnerProvenance> {
    const result = await this.call('describe_provenance', {}, (raw) =>
      ProvenanceResultSchema.parse(raw),
    );
    this.provenance = result.provenance;
    return result.provenance;
  }

  /** Re-read the host's descriptor (container id appears only inside one). */
  async refreshIsolation(): Promise<IsolationDescriptor> {
    const result = await this.call('describe_isolation', {}, (raw) =>
      IsolationDescriptorSchema.parse(raw),
    );
    this.descriptor = mergeDescriptor(this.descriptor, result);
    return this.isolation;
  }

  /** Graceful teardown: ask, then close, then make sure. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const connection = this.connection;
    if (connection !== undefined && !connection.isClosed) {
      try {
        await connection.request('shutdown', {}, SHUTDOWN_DEADLINE_MS);
      } catch {
        // A host that will not answer `shutdown` is killed below.
      }
      connection.close();
    }
    await this.options.transport.terminate();
  }

  /** Kill the host with no handshake (ALD-055 criterion 3). */
  async terminate(): Promise<void> {
    await this.options.transport.terminate();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private installCapability(capability: HostCapability): void {
    switch (capability) {
      case 'updatePolicy':
        this.updatePolicy = async (batch: UpdateBatch): Promise<PolicyCheckpointRef> => {
          const result = await this.call(
            'update_policy',
            {
              runId: batch.runId,
              turns: [...batch.turns],
              learningSignal: batch.learningSignal,
            },
            (raw) => CheckpointResultSchema.parse(raw),
          );
          await this.syncPolicy(result.policyDigest, 'update_policy');
          return result.checkpoint;
        };
        return;
      case 'measureAffect':
        this.measureAffect = async (): Promise<AffectStateMeasurement> => {
          const result = await this.call('measure_affect', {}, (raw) =>
            MeasureAffectResultSchema.parse(raw),
          );
          await this.syncPolicy(result.policyDigest, 'measure_affect');
          return result.measurement;
        };
        return;
      case 'applyCurriculumStage':
        this.applyCurriculumStage = async (stage: CurriculumStage): Promise<void> => {
          const result = await this.call(
            'apply_curriculum_stage',
            { stage },
            (raw) => PolicyStateResultSchema.parse(raw),
          );
          await this.syncPolicy(result.policyDigest, 'apply_curriculum_stage');
        };
        return;
      case 'describeProvenance':
        this.describeProvenance = (): LearnerProvenance => {
          if (this.provenance === undefined) {
            throw new IsolationError('not-initialized', {
              method: 'describeProvenance',
            });
          }
          return this.provenance;
        };
        return;
      default: {
        const exhaustive: never = capability;
        throw new IsolationError('configuration', { method: String(exhaustive) });
      }
    }
  }

  /**
   * Make the proxy's optional surface equal the host's.
   *
   * A member the host does not have is deleted rather than left in place to
   * throw later: `if (adapter.updatePolicy)` is how the runtime and the
   * conformance harness read SPEC §6.2, so the property's *presence* is part
   * of the contract, not just its behaviour.
   */
  private reconcileCapabilities(reported: readonly HostCapability[]): void {
    this.capabilities = [...reported];
    for (const capability of HOST_CAPABILITIES) {
      const wanted = reported.includes(capability);
      const present = this[capability] !== undefined;
      if (wanted && !present) {
        this.installCapability(capability);
      } else if (!wanted && present) {
        delete this[capability];
      }
    }
  }

  /** Capabilities the host reported at `init`. */
  get hostCapabilities(): readonly HostCapability[] {
    return this.capabilities;
  }

  private deadline(): number {
    return (
      this.options.deadlineMs ??
      this.config?.turnResponseBudgetMs ??
      DEFAULT_CALL_DEADLINE_MS
    );
  }

  private requireConnection(method: HostMethod): FrameConnection {
    if (this.disposed) {
      throw new IsolationError('disposed', { method });
    }
    const connection = this.connection;
    if (connection === undefined) {
      throw new IsolationError('not-initialized', { method });
    }
    return connection;
  }

  /**
   * One host call: deadline, schema, policy digest, and — on the turn path in
   * Mode R — the fixed-schedule pad, applied whether the call succeeded,
   * failed, or timed out.
   */
  private async call<T>(
    method: HostMethod,
    params: unknown,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const connection = this.requireConnection(method);
    const deadlineMs = this.deadline();
    const normalize = this.timing === 'normalized' && TURN_PATH.has(method);
    const startedAt = this.timer.now();
    this.diagnostics.calls += 1;
    try {
      const raw = await connection.request(method, params, deadlineMs);
      try {
        return parse(raw);
      } catch (cause) {
        throw new IsolationError('protocol-violation', { method, cause });
      }
    } catch (error) {
      if (error instanceof IsolationError) {
        if (error.code === 'deadline-exceeded') {
          this.diagnostics.deadlineExceeded += 1;
        } else if (error.code === 'host-error') {
          this.diagnostics.hostErrors += 1;
        }
      }
      throw error;
    } finally {
      if (normalize) {
        await this.padToDeadline(startedAt, deadlineMs);
      }
    }
  }

  /**
   * Hold the result until the deadline tick.
   *
   * This is the timing half of SPEC §10.3: an accepted turn, a turn the host
   * refused, and a turn the host never answered all return to the caller at
   * the same point on the schedule.
   */
  private async padToDeadline(startedAt: number, deadlineMs: number): Promise<void> {
    const remaining = deadlineMs - (this.timer.now() - startedAt);
    if (remaining <= 0) {
      return;
    }
    this.diagnostics.paddedCalls += 1;
    await this.timer.delay(remaining).promise;
  }

  /**
   * Pull and cache the policy when the host says it moved.
   *
   * The digest is recomputed from the received value: if the transport had
   * altered the policy in any way, the recomputed digest would differ from
   * the host's and this raises `protocol-violation` instead of silently
   * checkpointing a different object than the host holds.
   */
  private async syncPolicy(digest: Sha256Hash, method: HostMethod): Promise<void> {
    if (this.policy?.digest === digest) {
      return;
    }
    const connection = this.requireConnection('export_policy');
    const raw = await connection.request('export_policy', {}, this.deadline());
    let result: { policy: unknown; policyDigest: Sha256Hash };
    try {
      result = ExportPolicyResultSchema.parse(raw);
    } catch (cause) {
      throw new IsolationError('protocol-violation', {
        method: 'export_policy',
        cause,
      });
    }
    const recomputed = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      result.policy,
    );
    if (recomputed !== result.policyDigest) {
      throw new IsolationError('protocol-violation', { method: 'export_policy' });
    }
    if (recomputed !== digest) {
      // Only one call is ever in flight per host, so the state cannot have
      // moved between the two: a mismatch means the peer (or an adapter whose
      // `exportPolicy()` is not deterministic) is broken, and caching a policy
      // that disagrees with the method result would corrupt the checkpoint.
      throw new IsolationError('protocol-violation', { method });
    }
    this.diagnostics.policyRefreshes += 1;
    this.policy = { digest: recomputed, value: result.policy };
  }

  /** The one method the host may call: `ledger.append` (SPEC §6.3, §4.2). */
  private async serveHostRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method !== 'ledger_append') {
      throw new HostProtocolError('unknown-method');
    }
    const ledger = this.ledger;
    if (ledger === undefined) {
      throw new HostProtocolError('not-initialized');
    }
    const parsed = LedgerAppendParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new HostProtocolError('invalid-params');
    }
    try {
      const event = await ledger.append(
        parsed.data.draft,
        parsed.data.channelEventHash === undefined
          ? undefined
          : { channelEventHash: parsed.data.channelEventHash },
      );
      this.diagnostics.ledgerAppends += 1;
      return { event };
    } catch (error) {
      // The host learns `internal` and nothing else: why the Nursery's
      // Evidence Writer refused is not a Baby's business (SPEC §4.2, §10.3).
      this.lastLedgerFailure = error;
      throw error;
    }
  }
}

/**
 * The configuration a Baby host may see (SPEC §6.2, §9.5, §10.1).
 *
 * `LearnerInitContext.config` is typed as `LearnerVisibleRunConfig`, but a
 * caller holding a full `RunConfig` satisfies that type structurally and
 * `@ald/learners`' conformance harness passes exactly that. `randomSeed` is
 * therefore stripped here rather than assumed absent: with the run seed and
 * the public Scenario Engine, a host could regenerate researcher-only ground
 * truth and the other Baby's private seed. The host's own schema also rejects
 * the key, so the withholding is enforced on both sides of the boundary.
 */
function learnerVisibleWireConfig(
  config: LearnerVisibleRunConfig,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter(
      ([key]) => key !== 'randomSeed',
    ),
  );
}

/** Merge the host's self-report into the descriptor without losing local facts. */
function mergeDescriptor(
  local: IsolationDescriptor,
  reported: {
    boundary: IsolationBoundary;
    processId?: number;
    containerId?: string;
    hostLabel?: string;
  },
): IsolationDescriptor {
  const processId = reported.processId ?? local.processId;
  const hostLabel = reported.hostLabel ?? local.hostLabel;
  return {
    boundary: reported.boundary,
    ...(local.timingNormalization === undefined
      ? {}
      : { timingNormalization: local.timingNormalization }),
    ...(processId === undefined ? {} : { processId }),
    ...(reported.containerId === undefined
      ? {}
      : { containerId: reported.containerId }),
    ...(hostLabel === undefined ? {} : { hostLabel }),
  };
}

/**
 * `OutcomeEvent` → wire form, without reading a reward the learning signal
 * forbids reading (see `OutcomeEventSchema`'s doc comment).
 */
export function outcomeToWire(outcome: OutcomeEvent): Record<string, unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(outcome, 'reward');
  const withheld = descriptor !== undefined && descriptor.get !== undefined;
  return {
    runId: outcome.runId,
    turn: outcome.turn,
    role: outcome.role,
    success: outcome.success,
    payload: [...outcome.payload],
    ...(withheld ? { rewardWithheld: true } : { reward: outcome.reward }),
  };
}

function runtimeWireCodeFor(error: unknown): HostErrorCode {
  return isHostProtocolError(error) ? error.code : 'internal';
}
