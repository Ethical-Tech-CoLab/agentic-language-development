/**
 * `LearnerHostProtocol` — the wire contract between the runtime-side proxy
 * and a learner host process (SPEC §5.2, §6.2, §6.3, §10.3; ALD-055).
 *
 * The method set mirrors `LearnerAdapter` exactly, plus three methods that
 * exist only because the adapter is remote:
 *
 * - `describe_isolation` fills the `IsolationDescriptor` of SPEC §5.3 from
 *   inside the host, so `processId`/`containerId` are what the host itself
 *   reports rather than what the runtime assumed (ALD-055 criterion 1);
 * - `export_policy` exists because `LearnerAdapter.exportPolicy()` is
 *   *synchronous* and a process boundary is not. Every method that can change
 *   policy state answers with a `policyDigest`; when the digest moves, the
 *   proxy pulls the policy once and caches it, so the synchronous contract is
 *   honoured without a synchronous RPC (see `remote-adapter.ts`);
 * - `isolation_probe` is the audited self-test surface for SPEC §10.3's
 *   "no direct network, filesystem, clipboard, or process access from a Baby
 *   process/container beyond the Gateway RPC" and E01's filesystem/process
 *   attempt categories. It returns *outcome codes only* — never file
 *   contents, never a path, never an error message — and it is the runtime
 *   that asks; a hosted adapter can neither call it nor observe it.
 *
 * The reverse direction has exactly one method, `ledger_append`, because the
 * Ledger Writer stays in the Nursery trust zone (SPEC §4.1 item 7, §4.2).
 *
 * Every schema here is strict: an unknown key anywhere in a request is
 * `invalid-params`, not a silently stripped field. That is deliberate. A
 * stripped key is a channel the schema hides (the same reasoning as
 * `assertNoStrippedKeys` in `@ald/learners`' conformance harness), and on this
 * boundary the two peers are a Baby host and the Nursery.
 */
import { z } from 'zod';
import {
  AffectStateMeasurementSchema,
  AGENT_ACTION_KINDS,
  CurriculumStageSchema,
  DeliveredChannelArtifactSchema,
  LearnerTrackIdSchema,
  LearningSignalSchema,
  LedgerEventDraftSchema,
  LedgerEventSchema,
  ObservationSchema,
  RunConfigSchema,
} from '@ald/types';

/** Methods a learner host serves. */
export const HOST_METHODS = [
  'init',
  'observe',
  'act',
  'receive',
  'on_outcome',
  'update_policy',
  'measure_affect',
  'apply_curriculum_stage',
  'describe_provenance',
  'export_policy',
  'describe_isolation',
  'isolation_probe',
  'shutdown',
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

/** Methods the runtime serves for a host (reverse RPC). */
export const RUNTIME_METHODS = ['ledger_append'] as const;

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

/**
 * Methods whose response is normalized to the fixed turn schedule in Mode R
 * (SPEC §10.3, §8.3). They are exactly the methods a *turn* consists of: what
 * the other Baby could in principle correlate with. `init`,
 * `update_policy`, `export_policy` and the descriptive methods are
 * runtime-initiated bookkeeping outside any turn and are not padded, which
 * keeps a training run from taking one full deadline per policy update.
 */
export const TURN_PATH_METHODS: readonly HostMethod[] = [
  'observe',
  'act',
  'receive',
  'on_outcome',
  'measure_affect',
];

const roleSchema = z.enum(['baby-a', 'baby-b']);
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/**
 * `LearnerVisibleRunConfig` (`RunConfig` minus `randomSeed`, SPEC §6.2) as a
 * schema.
 *
 * `RunConfigSchema` carries cross-field refinements, so zod v4 refuses
 * `.omit()` on it; the shape is re-wrapped instead. The cross-field checks
 * are not re-run here on purpose: the runtime validated the whole
 * configuration before the run was created, and this boundary's job is to
 * refuse a *shape* that does not belong on the wire (an extra key, a wrong
 * type, or `randomSeed` itself, which a Baby must never receive).
 */
const visibleConfigShape = Object.fromEntries(
  Object.entries(RunConfigSchema.shape).filter(([key]) => key !== 'randomSeed'),
) as Omit<typeof RunConfigSchema.shape, 'randomSeed'>;

export const LearnerVisibleRunConfigSchema = z.strictObject(visibleConfigShape);

export const AffectWindowSchema = z.strictObject({
  windowId: z.string().min(1),
  turn: z.number().int().min(0),
  sender: roleSchema,
  recipient: roleSchema,
  opensAfter: z.literal('outcome'),
});

export const TurnBudgetSchema = z.strictObject({
  turn: z.number().int().min(0),
  role: z.enum(['sender', 'receiver']),
  responseBudgetMs: z.number().int().positive(),
  availableActions: z.array(z.enum(AGENT_ACTION_KINDS)),
  candidateRefs: z.array(z.string().min(1)).optional(),
  window: AffectWindowSchema.optional(),
});

/**
 * `OutcomeEvent` on the wire.
 *
 * `rewardWithheld` is how a reward-free learning signal survives the
 * boundary. SPEC §6.1's `self-supervised` track and the intrinsic modes must
 * never read a task reward, and `@ald/learners`' conformance harness proves
 * that by making `outcome.reward` *throw* when read. A proxy that read the
 * property to serialize it would defeat the very test it is meant to carry,
 * so the proxy inspects the property descriptor instead: an accessor becomes
 * `rewardWithheld: true` and the host reinstalls a throwing accessor. The
 * violation then still happens inside the hosted adapter, where it belongs.
 */
export const OutcomeEventSchema = z.strictObject({
  runId: z.string().min(1),
  turn: z.number().int().min(0),
  role: z.enum(['sender', 'receiver']),
  success: z.boolean(),
  reward: z.number().nullable().optional(),
  rewardWithheld: z.boolean().optional(),
  payload: z.array(z.number()),
});

export const UpdateBatchSchema = z.strictObject({
  runId: z.string().min(1),
  turns: z.array(z.number().int().min(0)),
  learningSignal: LearningSignalSchema,
});

export const LearnerContractSchema = z.strictObject({
  version: z.string().min(1),
  text: z.string().min(1),
  track: LearnerTrackIdSchema.optional(),
});

export const InitParamsSchema = z.strictObject({
  track: LearnerTrackIdSchema,
  /** JSON-safe factory options for `createLearnerAdapterFactory`. */
  learnerOptions: z.record(z.string(), z.unknown()).optional(),
  runId: z.string().min(1),
  role: roleSchema,
  babyId: z.enum(['A', 'B']),
  config: LearnerVisibleRunConfigSchema,
  learnerContract: LearnerContractSchema,
  seed: z.string().min(1),
  symbolInventory: z.array(z.string().min(1)),
  initialPolicy: z.unknown().optional(),
});

export type InitParams = z.infer<typeof InitParamsSchema>;

export const IsolationDescriptorSchema = z.strictObject({
  boundary: z.enum(['in-process', 'separate-process', 'separate-container']),
  processId: z.number().int().positive().optional(),
  containerId: z.string().min(1).optional(),
  hostLabel: z.string().min(1).optional(),
});

export const LearnerComponentRecordSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum([
    'sensory-encoder',
    'world-model',
    'communication-policy',
    'value-function',
    'language-model',
    'memory',
    'other',
  ]),
  provenance: z.enum([
    'random-init',
    'frozen-open-weight',
    'frozen-visual-features',
    'derived-run-policy',
    'none',
  ]),
  hash: hashSchema,
  textAligned: z.boolean(),
});

/**
 * `LearnerProvenance` (SPEC §6.5) as a schema. `@ald/types` declares it as an
 * interface only; the boundary needs a validator, so one lives here (see this
 * package's `notesForIntegrator`: it belongs in `@ald/types` eventually).
 */
export const LearnerProvenanceSchema = z.strictObject({
  track: LearnerTrackIdSchema,
  modelRef: z.string().min(1),
  textTokenizerPresent: z.boolean(),
  textAlignedEncoderPresent: z.boolean(),
  weightUpdatePath: z.enum(['none', 'private-buffers-only', 'centralized']),
  components: z.array(LearnerComponentRecordSchema),
});

/** Optional `LearnerAdapter` members a host reports after `init`. */
export const HOST_CAPABILITIES = [
  'updatePolicy',
  'measureAffect',
  'applyCurriculumStage',
  'describeProvenance',
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export const InitResultSchema = z.strictObject({
  capabilities: z.array(z.enum(HOST_CAPABILITIES)),
  isolation: IsolationDescriptorSchema,
  policyDigest: hashSchema,
  provenance: LearnerProvenanceSchema.optional(),
  /** Protocol version the host speaks; must equal the proxy's. */
  protocolVersion: z.literal(1),
});

/**
 * Result of a method that may have changed policy state.
 *
 * `envelope` is `z.unknown()` and stays **verbatim**: the runtime must see
 * exactly what the hosted adapter produced, including an illegal extra field
 * or a malformed proposal, because judging it is the Symbol Gateway's job
 * (SPEC §9.4) and a transport that quietly normalized it would hide the very
 * violation the rejection framework exists to record.
 */
export const EnvelopeResultSchema = z.strictObject({
  envelope: z.unknown(),
  policyDigest: hashSchema,
});

export const PolicyStateResultSchema = z.strictObject({
  policyDigest: hashSchema,
});

export const CheckpointResultSchema = z.strictObject({
  checkpoint: z.strictObject({
    policyCheckpointRef: z.string().min(1),
    policyHash: hashSchema,
    turn: z.number().int().min(0),
  }),
  policyDigest: hashSchema,
});

export const ExportPolicyResultSchema = z.strictObject({
  policy: z.unknown(),
  policyDigest: hashSchema,
});

export const MeasureAffectResultSchema = z.strictObject({
  measurement: AffectStateMeasurementSchema,
  policyDigest: hashSchema,
});

export const ProvenanceResultSchema = z.strictObject({
  provenance: LearnerProvenanceSchema,
});

/** Outcome of one attempted forbidden access inside the host. */
export const PROBE_OUTCOMES = [
  /** The platform refused it (Node permission model, or the OS). */
  'denied',
  /** It succeeded — the channel is open and therefore NOT claimed closed. */
  'allowed',
  /** The API exists and was reachable but the peer refused the connection. */
  'refused',
  /** Not attempted in this probe. */
  'skipped',
] as const;

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export const IsolationProbeParamsSchema = z.strictObject({
  /** A decoy path the host must not be able to read. */
  readPath: z.string().min(1).optional(),
  /** A loopback endpoint used only to show whether sockets are reachable. */
  connect: z
    .strictObject({
      host: z.string().min(1),
      port: z.number().int().positive().max(65_535),
      timeoutMs: z.number().int().positive().max(2000).default(300),
    })
    .optional(),
});

export const IsolationProbeResultSchema = z.strictObject({
  /** Whether Node's permission model is active in this host. */
  permissionModel: z.boolean(),
  fsRead: z.enum(PROBE_OUTCOMES),
  clipboard: z.enum(PROBE_OUTCOMES),
  childProcess: z.enum(PROBE_OUTCOMES),
  worker: z.enum(PROBE_OUTCOMES),
  network: z.enum(PROBE_OUTCOMES),
  /**
   * Environment variable *names* only. A Baby host's environment is the
   * simplest place to leak a peer's address, a database path, or a key file,
   * so the test asserts on this set; values are never returned.
   */
  envKeys: z.array(z.string()),
  /** Number of argv entries, so a test can assert nothing extra was passed. */
  argvCount: z.number().int().min(0),
  processId: z.number().int().positive(),
});

export type IsolationProbeResult = z.infer<typeof IsolationProbeResultSchema>;

export const LedgerAppendParamsSchema = z.strictObject({
  draft: z.strictObject(LedgerEventDraftSchema.shape),
  channelEventHash: hashSchema.optional(),
});

export const LedgerAppendResultSchema = z.strictObject({
  event: LedgerEventSchema,
});

/** Params schema per host method, so dispatch validates before it acts. */
export const HOST_PARAM_SCHEMAS = {
  init: InitParamsSchema,
  observe: z.strictObject(ObservationSchema.shape),
  act: TurnBudgetSchema,
  receive: z.strictObject(DeliveredChannelArtifactSchema.shape),
  on_outcome: OutcomeEventSchema,
  update_policy: UpdateBatchSchema,
  measure_affect: z.strictObject({}),
  apply_curriculum_stage: z.strictObject({ stage: CurriculumStageSchema }),
  describe_provenance: z.strictObject({}),
  export_policy: z.strictObject({}),
  describe_isolation: z.strictObject({}),
  isolation_probe: IsolationProbeParamsSchema,
  shutdown: z.strictObject({}),
} as const satisfies Record<HostMethod, z.ZodType>;
