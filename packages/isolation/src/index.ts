/**
 * `@ald/isolation` — Research-Grade Mode (Mode R) learner isolation:
 * separate-process and separate-container `LearnerAdapter`s behind the
 * ordinary SPEC §6.2 interface.
 *
 * Specification sections implemented here: §5.2 (Mode R), §5.3 (the mode
 * comparison table's process-boundary and timing-normalization rows), §6.2
 * (the adapter interface, unchanged across the boundary), §6.3 (tool-only
 * interaction and the private-ledger tool as the host's single reverse RPC),
 * §8.3 (per-turn response deadline), §10.3 (side-channel controls: normalized
 * envelope size, constant-shape error behavior, fixed turn schedule, no
 * filesystem/process access from a Baby beyond the Gateway RPC), §10.4
 * (training isolation — an update step can only reach this process's own
 * buffers), §12.7 (the private deterministic-service boundary the reverse RPC
 * respects), §13.5 (no key material in a Baby host).
 *
 * Owning backlog items: ALD-055 (separate-container isolation for Mode R),
 * ALD-056 isolation half (training isolation verified under separation),
 * ALD-053 support (the `IsolationDescriptor`/`isolation` boundary the runtime
 * enforces), ALD-040 transport half (normalized envelope, constant-shape
 * errors, fixed timing on the host protocol).
 *
 * What this package does **not** claim: the process transport does not deny
 * network access (Node's permission model has no network dimension), and no
 * transport here is a formally verified isolation proof. The container
 * topology in `deploy/mode-r/` is the SPEC §5.2 shape; `README.md` maps every
 * §10.3 threat-model item to the transport that actually covers it, and says
 * which ones neither covers.
 */
export {
  FrameConnection,
  type ConnectionStats,
  type FrameChannel,
  type FrameConnectionOptions,
  type FrameRequestHandler,
} from './channel.js';
export {
  HOST_ERROR_CODES,
  HostProtocolError,
  ISOLATION_ERROR_CODES,
  ISOLATION_FAILURE_CLASSES,
  IsolationError,
  isHostErrorCode,
  isHostProtocolError,
  isIsolationError,
  type HostErrorCode,
  type IsolationErrorCode,
  type IsolationErrorContext,
} from './errors.js';
export {
  ContainerHostTransport,
  ProcessHostTransport,
  createIsolatedAdapterFactory,
  type IsolatedAdapterFactory,
  type IsolatedAdapterFactoryOptions,
} from './factory.js';
export {
  DEFAULT_FRAME_SIZE,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FRAME_OVERHEAD_BYTES,
  FRAME_VERSION,
  FrameAssembler,
  FrameSchema,
  LineReader,
  MAX_CHUNKS,
  MAX_FRAME_SIZE,
  MIN_FRAME_SIZE,
  assertValidFrameSize,
  canonicalPayload,
  correlationId,
  decodeFrameLine,
  encodeFrames,
  frameCapacity,
  type EncodeFramesOptions,
  type Frame,
  type FrameKind,
  type FrameOriginator,
} from './frames.js';
export {
  LearnerHost,
  StdioFrameChannel,
  detectContainerId,
  isolationProbe,
  outcomeFromWire,
  parseHostCliOptions,
  policyDigestOf,
  runLearnerHostCli,
  type HostCliOptions,
  type LearnerHostOptions,
} from './host.js';
export {
  defaultHostEntry,
  defaultReadAllowList,
  isolationPackageRoot,
  nodePermissionArgs,
  ProcessHostChannel,
  workspaceRoot,
  type HostDiagnostics,
  type NodePermissionOptions,
  type ProcessTransportOptions,
} from './process-transport.js';
export {
  AffectWindowSchema,
  CheckpointResultSchema,
  EnvelopeResultSchema,
  ExportPolicyResultSchema,
  HOST_CAPABILITIES,
  HOST_METHODS,
  HOST_PARAM_SCHEMAS,
  InitParamsSchema,
  InitResultSchema,
  IsolationDescriptorSchema,
  IsolationProbeParamsSchema,
  IsolationProbeResultSchema,
  LearnerProvenanceSchema,
  LearnerVisibleRunConfigSchema,
  LedgerAppendParamsSchema,
  LedgerAppendResultSchema,
  MeasureAffectResultSchema,
  OutcomeEventSchema,
  PROBE_OUTCOMES,
  PolicyStateResultSchema,
  ProvenanceResultSchema,
  RUNTIME_METHODS,
  TURN_PATH_METHODS,
  TurnBudgetSchema,
  UpdateBatchSchema,
  type HostCapability,
  type HostMethod,
  type InitParams,
  type IsolationProbeResult,
  type ProbeOutcome,
  type RuntimeMethod,
} from './protocol.js';
export {
  DEFAULT_CALL_DEADLINE_MS,
  RemoteLearnerAdapter,
  TRACKS_WITHOUT_POLICY_UPDATES,
  outcomeToWire,
  type HostTransport,
  type RemoteAdapterDiagnostics,
  type RemoteLearnerAdapterOptions,
} from './remote-adapter.js';
export {
  TcpFrameChannel,
  connectTcpFrameChannel,
  createTcpFrameServer,
  type TcpConnectOptions,
  type TcpFrameServer,
  type TcpFrameServerOptions,
} from './tcp-transport.js';
export {
  DirectHostTransport,
  LoopbackChannel,
  createLoopbackChannelPair,
  type LoopbackPair,
} from './testing.js';
export {
  RecordingTimer,
  systemTimer,
  type IsolationDelay,
  type IsolationTimer,
} from './timer.js';
