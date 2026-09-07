/**
 * Service-boundary contracts shared by every runtime package.
 *
 * These interfaces are the integration seams between the deterministic
 * services named in SPECIFICATION.md §4.1: Event Signers, Evidence Writer and
 * Store, Checkpoint Service, Base Anchor Publisher, Scenario Engine, Symbol
 * Gateway, Learner Adapters, and the Nursery Controller runtime. Packages
 * depend on this package only; concrete implementations live in
 * `@ald/hashing`, `@ald/evidence`, `@ald/checkpoint`, `@ald/anchor`,
 * `@ald/scenario`, `@ald/gateway`, `@ald/learners`, and `@ald/orchestrator`.
 *
 * Conventions:
 * - hashes are `sha256:<64 hex>`; signatures `ed25519:<base64>`; public keys
 *   `ed25519-pub:<base64>` (raw 32-byte key);
 * - every method that may call a remote signer or adapter is async; SQLite
 *   transactions themselves are synchronous and run only after signatures
 *   have been obtained while the single writer holds its serialization lock;
 * - timestamps are ISO-8601 UTC strings from an injected `Clock` so tests are
 *   deterministic.
 */
import type {
  EventStream,
  SignerDomain,
} from './domains.js';
import type {
  AnchorReceipt,
  AuditLedgerEntry,
  CheckpointManifest,
  CheckpointReason,
  ConsistencyProof,
  InclusionProof,
  InterventionEvent,
  InterventionEventType,
  RunManifest,
  TurnRecord,
} from './schemas-integrity.js';
import type {
  AffectStateMeasurement,
  AgentActionProposal,
  ChannelEvent,
  DeliveredChannelArtifact,
  ExperimentRecord,
  LearnerTrackId,
  LedgerDraftEnvelope,
  LedgerEvent,
  LedgerEventDraft,
  Observation,
  RunConfig,
  TurnProposalEnvelope,
  VerificationReport,
} from './schemas.js';

export type BabyRole = 'baby-a' | 'baby-b';
export type BabyId = 'A' | 'B';
export type Sha256Hash = string;
export type Ed25519Signature = string;
export type Ed25519PublicKey = string;

export function babyIdForRole(role: BabyRole): BabyId {
  return role === 'baby-a' ? 'A' : 'B';
}

export function roleForBabyId(babyId: BabyId): BabyRole {
  return babyId === 'A' ? 'baby-a' : 'baby-b';
}

export function ledgerStreamForRole(role: BabyRole): EventStream {
  return role === 'baby-a' ? 'baby-a-ledger' : 'baby-b-ledger';
}

export function otherRole(role: BabyRole): BabyRole {
  return role === 'baby-a' ? 'baby-b' : 'baby-a';
}

/** Injectable wall clock. `now()` returns an ISO-8601 UTC timestamp. */
export interface Clock {
  now(): string;
}

// ---------------------------------------------------------------------------
// Event signers (LEDGER §11, SPEC §4.1 item 6)
// ---------------------------------------------------------------------------

export interface SignerPublicKey {
  domain: SignerDomain;
  keyId: string;
  publicKey: Ed25519PublicKey;
}

/** Signs only its own domain. Receives a complete entry hash, never content. */
export interface DomainSigner extends SignerPublicKey {
  sign(hash: Sha256Hash): Promise<Ed25519Signature>;
}

export interface SignerRegistry {
  readonly runId: string;
  signer(domain: SignerDomain): DomainSigner;
  publicKeys(): SignerPublicKey[];
}

// ---------------------------------------------------------------------------
// Evidence Store (LEDGER §3, SPEC §13.1) — read side
// ---------------------------------------------------------------------------

export interface ChainHead {
  stream: EventStream;
  /** Number of committed events; `0` means the head is the genesis hash. */
  size: number;
  lastEntryHash: Sha256Hash;
}

export interface StoredEvent {
  stream: EventStream;
  sequence: number;
  entryHash: Sha256Hash;
  previousEntryHash: Sha256Hash;
  recordedAt: string;
  /** Canonical JSON of the complete signed event, exactly as exported to JSONL. */
  canonicalJson: string;
}

export interface RunMetadataRecord {
  runId: string;
  createdAt: string;
  deploymentMode: RunConfig['deploymentMode'];
  configurationHash: Sha256Hash;
  configurationJson: string;
  parentRunId: string | null;
  derivedFromCheckpointHash: Sha256Hash | null;
}

export interface EventRange {
  fromSequence?: number;
  toSequence?: number;
}

export interface EvidenceReader {
  listRuns(): string[];
  readRunMetadata(runId: string): RunMetadataRecord | undefined;
  chainHead(runId: string, stream: EventStream): ChainHead;
  readEvents(runId: string, stream: EventStream, range?: EventRange): StoredEvent[];
  readCheckpoints(runId: string): CheckpointManifest[];
  readAnchorReceipts(runId: string): AnchorReceipt[];
  readExperimentRecords(runId: string): ExperimentRecord[];
}

// ---------------------------------------------------------------------------
// Evidence Writer (SPEC §4.1 item 7, §8.2, §12.7) — write side
// ---------------------------------------------------------------------------

/**
 * Gateway → Evidence Writer request for one accepted Baby proposal. The writer
 * assigns the next sender-ledger and channel sequences, builds and hashes the
 * sender intention event first, then the channel event (which binds
 * `senderLedgerSequence`/`senderEntryHash`), obtains both signatures, and
 * inserts both rows in one SQLite transaction. `deliveredArtifact` is the
 * artifact after communication-control substitution (§9.6) and is `null`
 * under the `disabled` condition.
 */
export interface TurnCommitRequest {
  runId: string;
  turn: number;
  sender: BabyRole;
  recipient: BabyRole;
  carrier: RunConfig['carrierMode'];
  communicationCondition: Exclude<RunConfig['communicationCondition'], 'oracle'>;
  proposal: AgentActionProposal;
  intentionDraft: LedgerEventDraft;
  deliveredArtifact: AgentActionProposal['publicArtifact'] | null;
}

export interface TurnCommitResult {
  senderLedgerEvent: LedgerEvent;
  channelEvent: ChannelEvent;
  /** `null` when nothing is delivered (`disabled`). */
  delivery: DeliveredChannelArtifact | null;
}

export interface RejectionCommitRequest {
  runId: string;
  turn: number;
  sender: BabyRole;
  carrier: RunConfig['carrierMode'];
  communicationCondition: RunConfig['communicationCondition'];
  reasonCode: string;
  /** Domain-separated hash of the rejected payload; the raw payload is never stored. */
  rejectedPayloadHash: Sha256Hash;
}

/** E03 `oracle` only: artifact generated by the Scenario Engine, origin `gateway-control`. */
export interface ControlArtifactCommitRequest {
  runId: string;
  turn: number;
  logicalSender: BabyRole;
  recipient: BabyRole;
  carrier: RunConfig['carrierMode'];
  deliveredArtifact: AgentActionProposal['publicArtifact'];
}

export interface LedgerAppendRequest {
  runId: string;
  babyId: BabyId;
  turn: number;
  draft: LedgerEventDraft;
  /** Required for interpretation events; validated against the recorded delivery. */
  channelEventHash?: Sha256Hash;
}

export interface TurnRecordAppendRequest {
  runId: string;
  turn: number;
  phase: TurnRecord['phase'];
  roles: TurnRecord['roles'];
  communicationCondition: TurnRecord['communicationCondition'];
  scenarioRef: string;
  scenarioStateHash: Sha256Hash;
  observationHashes: TurnRecord['observationHashes'];
  babyProposalHash: Sha256Hash | null;
  deliveredArtifactHash: Sha256Hash;
  channelEventHash: Sha256Hash | null;
  actionHash: Sha256Hash;
  outcomeHash: Sha256Hash;
  outcome: Record<string, unknown>;
}

export interface InterventionAppendRequest {
  runId: string;
  eventType: InterventionEventType;
  actorId: string;
  reasonCode: string;
  details?: Record<string, unknown>;
}

export interface AuditLedgerAppendRequest {
  runId: string;
  babyId: BabyId;
  sourceEntryHash: Sha256Hash;
  interpreterVersion: string;
  content: AuditLedgerEntry['content'];
}

export interface EvidenceWriter extends EvidenceReader {
  /** Inserts `run_metadata`; returns the canonical configuration hash. */
  registerRun(config: RunConfig): { configurationHash: Sha256Hash };
  commitTurn(request: TurnCommitRequest): Promise<TurnCommitResult>;
  commitRejection(request: RejectionCommitRequest): Promise<ChannelEvent>;
  commitControlArtifact(
    request: ControlArtifactCommitRequest,
  ): Promise<{ channelEvent: ChannelEvent; delivery: DeliveredChannelArtifact }>;
  appendLedgerEvent(request: LedgerAppendRequest): Promise<LedgerEvent>;
  appendTurnRecord(request: TurnRecordAppendRequest): Promise<TurnRecord>;
  appendInterventionEvent(
    request: InterventionAppendRequest,
  ): Promise<InterventionEvent>;
  appendAuditLedgerEntry(
    request: AuditLedgerAppendRequest,
  ): Promise<AuditLedgerEntry>;
  insertCheckpointManifest(manifest: CheckpointManifest): void;
  insertAnchorReceipt(receipt: AnchorReceipt): void;
  appendExperimentRecord(record: ExperimentRecord): void;
  /** LEDGER §15: verify committed prefixes; report forks; never truncate. */
  recover(runId: string): Promise<RecoveryReport>;
}

export interface ForkReport {
  stream: EventStream;
  sequence: number;
  entryHashes: Sha256Hash[];
}

export interface RecoveryReport {
  runId: string;
  ok: boolean;
  heads: ChainHead[];
  forks: ForkReport[];
  chainViolations: string[];
}

// ---------------------------------------------------------------------------
// Checkpoint Service (LEDGER §7-§9) and Base Anchor Publisher (LEDGER §10)
// ---------------------------------------------------------------------------

export interface CheckpointService {
  createCheckpoint(
    runId: string,
    reason: CheckpointReason,
  ): Promise<CheckpointManifest>;
  inclusionProof(
    runId: string,
    stream: EventStream,
    sequence: number,
    checkpointSequence: number,
  ): InclusionProof;
  consistencyProof(
    runId: string,
    stream: EventStream,
    fromCheckpointSequence: number,
    toCheckpointSequence: number,
  ): ConsistencyProof;
}

export interface AnchorPublisher {
  readonly network: AnchorReceipt['network'];
  submit(manifest: CheckpointManifest): Promise<AnchorReceipt>;
  awaitConfirmation(receipt: AnchorReceipt): Promise<AnchorReceipt>;
}

// ---------------------------------------------------------------------------
// Run lifecycle (SPEC §7)
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'draft',
  'preregistered',
  'initializing',
  'running',
  'pausing',
  'paused',
  'resuming',
  'evaluating',
  'sealing',
  'sealing-blocked',
  'sealed',
  'aborting',
  'aborted-sealed',
  'forked-invalid',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * Events driving the SPEC §7.2 transition table. Two-step transitions such as
 * `running → pausing → paused` are modeled as `pause` followed by
 * `pause-complete`; `aborting → aborted-sealed` as `abort` then
 * `abort-complete`; `resuming → running` as `resume` then `resume-complete`.
 */
export const RUN_EVENTS = [
  'preregister',
  'start',
  'ready',
  'pause',
  'pause-complete',
  'resume',
  'resume-complete',
  'begin-evaluation',
  'evaluation-complete',
  'seal-complete',
  'seal-blocked',
  'seal-retry',
  'abandon-recovery',
  'abort',
  'abort-complete',
  'fork-detected',
] as const;

export type RunEvent = (typeof RUN_EVENTS)[number];

export interface RunTransition {
  from: RunState;
  event: RunEvent;
  to: RunState;
}

export interface RunStateMachine {
  readonly runId: string;
  readonly state: RunState;
  canApply(event: RunEvent): boolean;
  /** Applies a listed transition or throws an "invalid transition" error. */
  apply(event: RunEvent): RunState;
  history(): readonly RunTransition[];
}

// ---------------------------------------------------------------------------
// Scenario Engine (SPEC §4.1 item 4, §9.5, §10.1, §11.2)
// ---------------------------------------------------------------------------

export type ScenarioSplit = 'train' | 'held-out' | 'evaluation';

export interface Outcome {
  success: boolean;
  /** Task reward under `extrinsic-task`; `0` or `1` for referential games. */
  reward: number;
  utilities?: Record<BabyRole, number>;
  agreement?: boolean;
  /** Researcher-only detail. Never delivered to a Baby. */
  details: Record<string, unknown>;
}

export interface ScenarioInstance {
  /** Opaque, non-descriptive identifier (SPEC §11.2 `scenarioRef`). */
  scenarioRef: string;
  episodeIndex: number;
  split: ScenarioSplit;
  interactionMode: RunConfig['interactionMode'];
  roles: { sender: BabyRole; receiver: BabyRole };
  /** Purely numeric private observations per role (SPEC §10.1). */
  observations: Record<BabyRole, Observation['payload']>;
  /** Opaque object references in the receiver's candidate order. */
  candidateRefs: string[];
  /** Researcher-only ground truth (target, attributes, utilities). */
  groundTruth: Record<string, unknown>;
  /** Domain-separated hash over ground truth and observations. */
  stateHash: Sha256Hash;
}

export interface ScenarioEngine {
  /** Hash of the frozen generation config (`RunConfig.scenarioBundleHash`). */
  readonly bundleHash: Sha256Hash;
  /** Pre-registered chance success rate, e.g. `0.25` for four candidates. */
  readonly chanceSuccessRate: number;
  generate(
    episodeIndex: number,
    split: ScenarioSplit,
    roles: { sender: BabyRole; receiver: BabyRole },
  ): ScenarioInstance;
  /** Evaluates the receiver's task action against researcher ground truth. */
  evaluate(instance: ScenarioInstance, action: AgentActionProposal): Outcome;
  /** E03 `oracle`: minimal sufficient artifact from researcher-only ground truth. */
  oracleArtifact(instance: ScenarioInstance): AgentActionProposal['publicArtifact'];
  /** E03 `oracle`: deterministic decode of the oracle artifact into a task action. */
  oracleAction(
    instance: ScenarioInstance,
    artifact: AgentActionProposal['publicArtifact'],
  ): AgentActionProposal;
  /** Build the SPEC §11.2 Observation for one role. */
  observationFor(
    instance: ScenarioInstance,
    runId: string,
    turn: number,
    role: BabyRole,
  ): Observation;
}

// ---------------------------------------------------------------------------
// Learner Adapter (SPEC §6.2, §6.3)
// ---------------------------------------------------------------------------

/**
 * Append-only client to this Baby's own Ledger Writer. Implements the
 * `append_private_ledger_entry` tool (SPEC §6.3). The runtime binds the
 * request to the authenticated Baby identity and current turn; a Baby cannot
 * address another ledger.
 */
export interface PrivateLedgerClient {
  append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent>;
}

export interface LearnerContract {
  version: string;
  text: string;
}

export interface LearnerInitContext {
  runId: string;
  role: BabyRole;
  babyId: BabyId;
  config: RunConfig;
  learnerContract: LearnerContract;
  /** Private per-Baby seed derived by the runtime; never shared. */
  seed: string;
  symbolInventory: string[];
  ledger: PrivateLedgerClient;
  /** Present only for derived runs (SPEC §7.4). */
  initialPolicy?: unknown;
}

export interface TurnBudget {
  turn: number;
  role: 'sender' | 'receiver';
  responseBudgetMs: number;
  availableActions: AgentActionProposal['kind'][];
  /** Opaque object references the receiver may select (receiver role only). */
  candidateRefs?: string[];
}

export interface OutcomeEvent {
  runId: string;
  turn: number;
  role: 'sender' | 'receiver';
  success: boolean;
  /** Scalar task reward; `null` when the track receives no reward signal. */
  reward: number | null;
  /** Approved nonverbal numeric outcome payload delivered to both Babies. */
  payload: number[];
}

export interface UpdateBatch {
  runId: string;
  turns: number[];
  learningSignal: RunConfig['learningSignal'];
}

export interface PolicyCheckpointRef {
  policyCheckpointRef: string;
  policyHash: Sha256Hash;
  turn: number;
}

export interface LearnerAdapter {
  readonly track: LearnerTrackId;
  init(context: LearnerInitContext): Promise<void>;
  observe(observation: Observation): Promise<void>;
  act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope>;
  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope>;
  onOutcome(outcome: OutcomeEvent): Promise<void>;
  updatePolicy?(batch: UpdateBatch): Promise<PolicyCheckpointRef>;
  measureAffect?(): Promise<AffectStateMeasurement>;
  /** Canonicalizable policy state for policy-checkpoint hashing and derived runs. */
  exportPolicy(): unknown;
}

export interface LearnerAdapterFactory {
  readonly track: LearnerTrackId;
  create(): LearnerAdapter;
}

// ---------------------------------------------------------------------------
// Symbol Gateway (SPEC §4.1 item 3, §9)
// ---------------------------------------------------------------------------

export interface GatewayRunContext {
  runId: string;
  config: RunConfig;
  symbolInventory: string[];
  /** Run-level seed; the gateway derives per-condition randomness from it. */
  seed: string;
}

export interface GatewayTurnContext {
  turn: number;
  sender: BabyRole;
  recipient: BabyRole;
  /** `shuffled` only: validated artifacts of the other episodes in the batch. */
  batchArtifacts?: AgentActionProposal['publicArtifact'][];
  /** `shuffled` only: this episode's index within `batchArtifacts`. */
  batchIndex?: number;
}

export type GatewaySubmitResult =
  | {
      kind: 'accepted';
      channelEvent: ChannelEvent;
      senderLedgerEvent: LedgerEvent;
      delivery: DeliveredChannelArtifact | null;
      babyProposalHash: Sha256Hash;
      deliveredArtifactHash: Sha256Hash;
    }
  | {
      kind: 'rejected';
      channelEvent: ChannelEvent;
      reasonCode: string;
      rejectedPayloadHash: Sha256Hash;
      consecutiveRejections: number;
      /** True once `maxConsecutiveRejections` is reached (SPEC §9.4). */
      pauseRequested: boolean;
    };

export interface SymbolGateway {
  readonly runContext: GatewayRunContext;
  /** Validate, apply the communication-control condition, commit, deliver. */
  submitProposal(
    turn: GatewayTurnContext,
    envelope: TurnProposalEnvelope,
  ): Promise<GatewaySubmitResult>;
  /** E03 `oracle`: commit a Scenario Engine artifact with no learner output. */
  submitControlArtifact(
    turn: GatewayTurnContext,
    artifact: AgentActionProposal['publicArtifact'],
  ): Promise<{ channelEvent: ChannelEvent; delivery: DeliveredChannelArtifact }>;
  /** Receiver interpretation; the echoed `channelEventHash` must match the delivery. */
  submitInterpretation(
    turn: GatewayTurnContext,
    recipient: BabyRole,
    envelope: LedgerDraftEnvelope,
  ): Promise<LedgerEvent>;
  consecutiveRejections(): number;
  resetRejectionCounter(): void;
}

// ---------------------------------------------------------------------------
// Nursery Controller runtime (SPEC §12.5, §12.6) — consumed by twin packs
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  experimentId: string;
  deploymentMode: RunConfig['deploymentMode'];
  state: RunState;
  turn: number;
  configurationHash: Sha256Hash;
}

export interface TurnResult {
  turn: number;
  phase: TurnRecord['phase'];
  outcome: Outcome;
  channelEvent: ChannelEvent | null;
  turnRecord: TurnRecord;
  state: RunState;
}

export interface Intervention {
  actorId: string;
  reasonCode: string;
  details?: Record<string, unknown>;
}

export interface NurseryRuntime {
  createRun(config: RunConfig): Promise<RunSummary>;
  getRun(runId: string): RunSummary | undefined;
  listRuns(): RunSummary[];
  step(runId: string): Promise<TurnResult>;
  pause(runId: string, intervention: Intervention): Promise<RunSummary>;
  resume(runId: string, intervention: Intervention): Promise<RunSummary>;
  abort(runId: string, intervention: Intervention): Promise<RunSummary>;
  seal(runId: string): Promise<RunSummary>;
  transcript(runId: string): ChannelEvent[];
  ledgers(runId: string): { babyA: LedgerEvent[]; babyB: LedgerEvent[] };
  auditLog(runId: string): InterventionEvent[];
  checkpoints(runId: string): CheckpointManifest[];
  exportBundle(runId: string, outputDir: string): Promise<RunManifest>;
  verify(runId: string, bundleDir: string): Promise<VerificationReport>;
}
