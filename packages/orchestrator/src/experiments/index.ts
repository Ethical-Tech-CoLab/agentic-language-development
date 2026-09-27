/**
 * Experiment harnesses (E03 controls, E11 naming game) and qualification
 * reporting — Phase D (BACKLOG ALD-072).
 *
 * These are harnesses, not new protocol rules: every run they create goes
 * through the ordinary `NurseryRuntime` contract (`createRun`,
 * `runToCompletion`, `seal`), and every statistic comes from `@ald/analysis`,
 * the pre-registered toolkit. Nothing here is itself a research finding —
 * see `QUALIFICATION_LABEL`.
 */
export {
  E03_CONDITIONS,
  QUALIFICATION_LABEL,
  runE03Controls,
  type E03Condition,
  type E03Params,
  type E03ProgressEvent,
  type E03Result,
  type E03RunSummary,
  type RunE03ControlsOptions,
} from './e03-controls.js';
export {
  LV01_BRANCHES,
  LV01_CALIBRATION_DYADS,
  LV01_PEAK_MEMORY_MULTIPLIER,
  LV01_PILOT_PRIMARY_SLOTS,
  LV01_RESOURCE_COUNTERS,
  LV01_SLOT_RESERVE_MULTIPLIER,
  assessLv01Admission,
  captureLv01SlotTerminal,
  computeLv01CalibrationReserves,
  createLv01PairedCasePlan,
  createLv01StageJournal,
  finalizeLv01Stage,
  recordLv01SlotCase,
  scaleLv01ReserveForSlots,
  transitionLv01Slot,
  verifyLv01PairedCase,
  type Lv01Admission,
  type Lv01AdmissionInput,
  type Lv01Branch,
  type Lv01CalibrationReserve,
  type Lv01PairedBranchEvidence,
  type Lv01PairedBranchPlan,
  type Lv01PairedCasePlan,
  type Lv01PairedCasePlanInput,
  type Lv01ResourceCounter,
  type Lv01ScaledReserve,
  type Lv01Slot,
  type Lv01SlotResources,
  type Lv01SlotTerminalReceipt,
  type Lv01SlotStatus,
  type Lv01Stage,
  type Lv01StageJournal,
} from './ledger-value.js';
export {
  LV01_MESSAGE_SCHEDULE_DOMAIN,
  LV01_ORDINARY_FIT_DOMAIN,
  LV01_PAIRED_PREDICTION_COMMITMENT_DOMAIN,
  buildLv01PairedPredictionPayload,
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  verifyLv01PairedPredictionPayload,
  type Lv01LedgerAuthenticate,
  type Lv01PairedPredictionAuditInput,
  type Lv01PairedPredictionBuildInput,
  type Lv01PairedPredictionPayload,
  type Lv01PairedPredictionProvider,
  type Lv01PairedPredictionState,
} from './lv01-paired-predictions.js';
export {
  LV01_ACTION_DRAW_COMMITMENT_DOMAIN,
  LV01_ACTION_DRAW_U_DOMAIN,
  assertLv01ActionDrawScope,
  commitLv01ActionDraw,
  deriveLv01ActionDrawSeed,
  drawLv01SharedUnit,
  verifyLv01ActionDraw,
  type Lv01ActionDrawCommitment,
  type Lv01ActionDrawCommitmentInput,
  type Lv01ActionDrawDisclosure,
  type Lv01ActionDrawScope,
} from './lv01-action-draw.js';
export {
  auditLv01StageCollection,
  type Lv01StageCaseAudit,
} from './lv01-stage-audit.js';
export {
  LV01_AUDIT_TRANSCRIPT_DOMAIN,
  authenticateFromManifest,
  loadLv01AuditShared,
  loadLv01AuditedBranch,
  parseBundleFiles,
  resolveLv01FrozenModel,
  type Lv01BundleDocs,
} from './lv01-audit-loader.js';
export {
  LV01_STAGE_BINDING_DOMAIN,
  LV01_STAGE_PACKET_DOMAIN,
  LV01_STAGE_PRERUN_DOMAIN,
  admitLv01Stage,
  bindLv01StagePacket,
  compileLv01StagePacket,
  lv01SlotPlanForStage,
  verifyLv01StageBinding,
  verifyLv01StagePacket,
  type Lv01StagePacketInput,
} from './lv01-stage-packets.js';
export {
  auditLv01PairedCase,
  LV01_AUDIT_CASE_DOMAIN,
  type Lv01AuditParentBundle,
  type Lv01AuditSharedInput,
  type Lv01AuditTranscriptEntry,
  type Lv01AuditTranscriptEventType,
  type Lv01AuditedBranch,
} from './lv01-auditor.js';
export {
  checkLv01BranchOrderStability,
  type Lv01BranchDigest,
} from './lv01-order-check.js';
export {
  extractLv01PolicySnapshots,
  type Lv01PolicySnapshotRef,
} from './lv01-snapshots.js';
export {
  LV01_LEDGER_TREATMENT_BATCH_DOMAIN,
  buildLedgerTreatmentBatch,
  deriveLv01DerangementSeed,
  ledgerShuffledDerangement,
  sliceLedgerTreatment,
  verifyLedgerTreatmentSlice,
  verifyLv01TreatmentTargets,
  type Lv01LedgerTreatmentBatch,
  type Lv01RoleNativeIndexes,
  type Lv01TreatedCase,
  type Lv01TreatmentCase,
  type Lv01TreatmentSlice,
} from './lv01-ledger-treatments.js';
export {
  LV01_SCHEDULE_PARTITIONS,
  buildLv01Schedule,
  scheduleCaseId,
  scheduledCaseFor,
  verifyLv01ScheduleCoverage,
  type Lv01Schedule,
  type Lv01ScheduleCounts,
  type Lv01ScheduledCase,
} from './lv01-schedule.js';
export {
  acquireLv01JournalLock,
  appendLv01Journal,
  initializeLv01Journal,
  lv01JournalExecutionState,
  readLv01Journal,
  verifyLv01JournalEvents,
  type Lv01JournalEvent,
  type Lv01JournalLock,
} from './ledger-value-journal.js';
export {
  LV01_UNCERTAIN_WRITE_DIAGNOSTIC_CLAIM,
  auditLv01UncertainWriteDiagnostic,
  injectLv01UncertainWrite,
  lv01UncertainWriteCounts,
  recoverLv01UncertainWrite,
  type Lv01UncertainWriteCounts,
  type Lv01UncertainWriteDiagnosticObservation,
  type Lv01UncertainWriteInjectObservation,
  type Lv01UncertainWriteRecoveryObservation,
} from './lv01-uncertain-write-diagnostic.js';
export {
  runE11NamingGame,
  type E11Aggregate,
  type E11LearnerOptions,
  type E11Params,
  type E11ProgressEvent,
  type E11Result,
  type E11RunSummary,
  type RunE11NamingGameOptions,
} from './e11-naming-game.js';
export {
  writeQualificationReport,
  type WriteQualificationReportOptions,
  type WriteQualificationReportResult,
} from './report.js';
export {
  auditLv01Stage,
  buildLv01TreatmentCases,
  collectLv01Slot,
  collectLv01Stage,
  createLv01CollectorHarness,
  executeLv01PairedCaseBranches,
  lv01ParentCheckpointHash,
  lv01SlotSeeds,
  lv01WorkloadForCollection,
  peekLv01BranchTarget,
  prepareLv01PairedCase,
  readLv01BundleDocs,
  rebuildLv01CasePlan,
  type Lv01BranchExecution,
  type Lv01CollectedSlot,
  type Lv01CollectionWorkload,
  type Lv01CollectorHarness,
  type Lv01PairedCaseInputs,
  type Lv01PeekedBranchTarget,
  type Lv01StageCollection,
} from './lv01-collector.js';
