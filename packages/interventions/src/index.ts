/**
 * `@ald/interventions` — the SPEC §15.2 intervention test suite and the
 * experiment-readiness scaffolds behind E14, E15, E16, E22, E31 and E50.
 *
 * Owning BACKLOG items: **ALD-072** (acceptance criterion 1: an intervention
 * is toggled by configuration with no code change per intervention;
 * criterion 3: the output is a data structure for a researcher's downstream
 * analysis and draws no conclusions), and the software readiness underlying
 * **ALD-074** criterion 3 (E14 role reversal/repair, E15 held-out
 * composition, E16 causal interventions), **ALD-075** criterion 3 (E22 staged
 * curriculum), **ALD-076** criterion 2 (E31 drift across checkpoints) and
 * **ALD-077** criterion 2 (E50 multi-seed aggregation).
 *
 * SPEC sections implemented: §8.1 (turn phases and role reversal, as the
 * schedule this package plans against), §9.6 (the control conditions a probe
 * is scored beside), §11.4 (agent-native ledger content the claim index
 * reads), §14.3 (seeded, replayable analyses), §15.2 (the mandatory suite and
 * its descriptive-versus-confirmatory split), §15.3 (α, Holm-Bonferroni,
 * mandatory effect sizes, seed minimums), §18 (`interventionPlan`,
 * `interventionSuiteThreshold`, `curriculumMode`, `roleReversalPeriod`).
 *
 * Module map:
 *
 * - `run-plan.ts` — {@link buildInterventionRunPlan}: the one
 *   configuration-driven entry point (ALD-072 criterion 1).
 * - `claims.ts` — the agent-native ledger claim index a probe targets.
 * - `plan.ts` — {@link planEvaluationProbes}: the ordered probe schedule with
 *   its ledger-predicted directions, fixed before outcomes exist (E16).
 * - `suite.ts` — {@link evaluateInterventionSuite}: per-probe agreement, the
 *   descriptive 70% readiness readout, and the seed-clustered confirmatory
 *   analyses.
 * - `scrambling.ts` — the offline-only §15.2 scrambling control.
 * - `repair.ts` — E14 repair, role-symmetry and reuse metrics.
 * - `curriculum.ts` — the E22 staged executor and its transition log.
 * - `replication.ts` — E50 multi-seed aggregation with failed and partial
 *   replications always included.
 * - `attachment.ts` — canonical-JSON packaging for the bundle attachments
 *   (`intervention-suite`, `curriculum-transitions`, `drift-evaluation`).
 *
 * The statistics themselves live in `@ald/analysis` (`hierarchical.ts`,
 * `composition.ts`, `drift.ts` are this workstream's additions there), so a
 * researcher can use them without pulling in the planner.
 *
 * Everything here is pure, deterministic and seeded: no evidence store, no
 * runtime, no clock, no network. **Nothing in this package draws a research
 * conclusion.** A field named `decision`, `meetsDescriptiveReadinessThreshold`
 * or `replicationStatus` reports the mechanical outcome of a pre-registered
 * rule applied to the numbers, and every readout carries
 * `claimBoundary: 'software-readiness-only'` to keep that explicit in the
 * artifact itself.
 */
export {
  InterventionError,
  type InterventionErrorCode,
} from './errors.js';
export {
  indexLedgerClaims,
  type LedgerClaimIndex,
  type LedgerFormClaim,
} from './claims.js';
export {
  readPolicyFormClaims,
  type PolicyFormClaims,
} from './policy-claims.js';
export {
  LEDGER_PREDICTION_FUNCTION_VERSION,
  PROBE_KINDS,
  PROBE_SCHEDULE_VERSION,
  evaluationTurnRange,
  hashProbe,
  planEvaluationProbes,
  probeCountFor,
  receiverForTurn,
  type LedgerPredictedDirection,
  type PlannedProbe,
  type PredictedCandidateShift,
  type ProbeKind,
  type ProbePlanInput,
  type ProbePositionBasis,
  type ProbeSchedule,
  type ProbeShortfallCode,
} from './plan.js';
export {
  DEFAULT_CHANCE_RATE,
  DEFAULT_INTERVENTION_SUITE_THRESHOLD,
  INTERVENTION_SUITE_ANALYSIS_VERSION,
  evaluateInterventionSuite,
  interventionSuiteAttachment,
  scoreProbeAgreement,
  type AgreementBlock,
  type InterventionSuiteInput,
  type InterventionSuiteResult,
  type ObservedProbeOutcome,
  type ProbeScoring,
  type ProbeScoringBasis,
  type ProbeUnscoredReasonCode,
  type ScoredProbe,
} from './suite.js';
export {
  SCRAMBLING_CONTROL_VERSION,
  evaluateScramblingControl,
  scramblingControlAttachment,
  type ScramblingDecision,
  type ScramblingInput,
  type ScramblingResult,
} from './scrambling.js';
export {
  REPAIR_ANALYSIS_VERSION,
  evaluateRepair,
  repairMetricsAttachment,
  type ProportionWithWilson,
  type RepairAttempt,
  type RepairEpisode,
  type RepairInput,
  type RepairResult,
  type RepairReuseResult,
  type RepairViolationCode,
  type RoleSymmetryResult,
} from './repair.js';
export {
  CURRICULUM_KNOBS,
  CURRICULUM_TRANSITIONS_VERSION,
  CurriculumExecutor,
  MAX_SYMBOLS_PER_MESSAGE_CEILING,
  assertStagesSupported,
  curriculumTransitionsAttachment,
  knobsOf,
  validateCurriculumStages,
  type CurriculumCapabilities,
  type CurriculumKnob,
  type CurriculumTransition,
  type CurriculumTransitionLog,
  type CurriculumValidationInput,
} from './curriculum.js';
export {
  PUBLICATION_MINIMUM_SEEDS,
  REPLICATION_ANALYSIS_VERSION,
  aggregateAcrossSeeds,
  replicationAttachment,
  type ReplicationArm,
  type ReplicationArmSummary,
  type ReplicationFindingInput,
  type ReplicationFindingResult,
  type ReplicationInput,
  type ReplicationResult,
  type ReplicationRule,
  type ReplicationStatus,
  type ReplicationStatusReasonCode,
} from './replication.js';
export {
  PROBE_SEED_DOMAIN,
  buildInterventionRunPlan,
  deriveInterventionSeed,
  driftEvaluationTurns,
  type InterventionRunPlan,
  type InterventionRunPlanInput,
  type InterventionToggleState,
} from './run-plan.js';
export {
  buildAttachment,
  fileSha256,
  toCanonicalJsonValue,
  type AttachmentFile,
  type InterventionAttachmentKind,
} from './attachment.js';
