/**
 * @ald/analysis — the pre-registered statistics toolkit for the experiment
 * harnesses (BACKLOG ALD-032 carrier leakage and ALD-072 statistics scaffold;
 * SPECIFICATION.md §15.2-§15.3; RESEARCH.md §7.3 and Appendix D §D.6-§D.7;
 * EXPERIMENT-NOTEBOOK.md E03 and E11).
 *
 * Every export is a pure, deterministic function of its arguments. The package
 * performs no I/O, holds no state, and takes randomness only from
 * `SeededPrng` (@ald/hashing), so an analysis replays bit-for-bit from a
 * registered seed — the property Appendix D §D.1 needs from an analysis
 * script. Nothing here interprets a result: `e03Analysis` and `e11Summary`
 * return data structures, and their booleans are the mechanical outcome of a
 * pre-registered rule applied to the numbers, never a scientific conclusion
 * (ALD-072 acceptance criterion 3).
 *
 * Layers, lowest first:
 *
 * - `special.ts` — log-gamma, incomplete beta/gamma, normal and Student t
 *   CDFs and quantiles, binomial log-pmf.
 * - `descriptive.ts` — sample summaries, quantiles, proportions, Wilson
 *   intervals.
 * - `hypothesis.ts` — one-sample t test, TOST, Holm-Bonferroni, binomial test.
 * - `effects.ts` — Cohen's h, rank-biserial correlation (§15.3 mandatory
 *   effect sizes).
 * - `bootstrap.ts` — seeded percentile bootstrap, unpaired and paired.
 * - `equivalence.ts` — the control-equivalence decision helper.
 * - `e03.ts` / `e11.ts` — the two experiment-shaped readouts.
 * - `carrier-leakage.ts` — immutable, pre-registered mark-level leakage probes.
 */
export {
  AnalysisError,
  type AnalysisErrorCode,
} from './errors.js';
export {
  carrierCapacity,
  type CarrierCapacity,
  type CarrierCapacityInput,
} from './carrier-capacity.js';
export {
  binomialLogPmf,
  logBeta,
  logBinomialCoefficient,
  logGamma,
  normalCdf,
  normalPdf,
  normalQuantile,
  regularizedIncompleteBeta,
  regularizedLowerGamma,
  regularizedUpperGamma,
  studentTCdf,
  studentTQuantile,
} from './special.js';
export {
  mean,
  pooledProportion,
  proportion,
  proportionOfSuccesses,
  quantile,
  quantileSorted,
  summarize,
  wilsonInterval,
  type ConfidenceInterval,
  type DescriptiveSummary,
  type ProportionSummary,
  type WilsonInterval,
} from './descriptive.js';
export {
  binomialTest,
  holmBonferroni,
  oneSampleTTest,
  tost,
  type Alternative,
  type BinomialTestResult,
  type HolmBonferroniResult,
  type OneSampleTTestResult,
  type TostResult,
} from './hypothesis.js';
export {
  cohensH,
  rankBiserial,
  type RankBiserialResult,
} from './effects.js';
export {
  bootstrapMeanCi,
  bootstrapMeanReplicates,
  bootstrapPairedDifferenceCi,
  bootstrapPairedDifferenceReplicates,
  percentileInterval,
  type BootstrapCi,
  type BootstrapOptions,
} from './bootstrap.js';
export {
  MINIMUM_EQUIVALENCE_SEEDS,
  evaluateControlEquivalence,
  type ControlEquivalenceInput,
  type ControlEquivalenceResult,
  type EquivalenceDecision,
} from './equivalence.js';
export {
  E03_HIGH_SEED_SHARE_LIMIT,
  E03_HIGH_SEED_THRESHOLD,
  E03_MINIMUM_SEEDS,
  E03_ORACLE_LOWER_BOUND,
  E03_SEPARATION_LOWER_BOUND,
  e03Analysis,
  type E03Analysis,
  type E03AnalysisInput,
  type E03ConditionResult,
  type E03Criteria,
  type E03HighSeedAudit,
  type E03OracleResult,
  type E03SeparationResult,
  type EpisodeCounts,
} from './e03.js';
export {
  E03_COMMUNICATION_CONDITIONS,
  E03_DESIGN_MINIMUM_POWER,
  E03_DESIGN_REPETITIONS,
  E03_DESIGN_ROWS,
  E03_DESIGN_SEED,
  E03_DESIGN_SIMULATION_VERSION,
  E03_SEED_LABEL,
  buildE03SeedManifest,
  simulateE03DesignPower,
  type E03DesignPowerRow,
  type E03DesignSimulation,
  type E03DesignSimulationOptions,
  type E03SeedManifest,
  type E03SeedManifestEntry,
} from './e03-design.js';
export {
  E03_REGISTRATION_CLAIM_BOUNDARY,
  E03_REGISTRATION_COMPILER_VERSION,
  compileE03Registration,
  type CompileE03RegistrationInput,
  type CompiledE03Registration,
  type E03RegisteredRun,
} from './e03-registration.js';
export {
  E03_CHANCE_RATE,
  e11Summary,
  type E11Summary,
  type E11SummaryInput,
  type E11TrainingWindow,
} from './e11.js';
export {
  AFFECT_LEAKAGE_ANALYSIS_VERSION,
  AFFECT_LEAKAGE_ESTIMATOR,
  E20_EXCESS_CMI_BOUND_BITS,
  E20_MINIMUM_SEEDS,
  E20_MINIMUM_WINDOWS_PER_SEED,
  E20_PERMUTATIONS,
  evaluateAffectLeakage,
  type AffectLeakageDecision,
  type AffectLeakageInput,
  type AffectLeakageResult,
  type AffectLeakageSeedInput,
  type AffectLeakageSeedResult,
  type AffectLeakageWindow,
} from './affect-leakage.js';
export {
  CARRIER_LEAKAGE_ANALYSIS_VERSION,
  evaluateCarrierLeakage,
  type CarrierLeakageInput,
  type CarrierLeakageObservation,
  type CarrierLeakageProbeDecision,
  type CarrierLeakageProbePlan,
  type CarrierLeakageProbeResult,
  type CarrierLeakageResult,
  type CarrierMarkLeakageMetric,
  type RecognizableGlyphOutcome,
} from './carrier-leakage.js';
export {
  CAUSAL_PREDICTION_PIPELINE_VERSION,
  NON_LEDGER_COMPARATOR_IDS,
  commitProspectivePredictions,
  multiclassBrierScore,
  scoreCommittedPredictions,
  selectNonLedgerComparator,
  type CausalPredictionScore,
  type ComparatorInformation,
  type ComparatorModel,
  type ComparatorSelection,
  type ComparatorValidationScore,
  type LabeledPredictionCase,
  type NativeLedgerPredictionSet,
  type NonLedgerComparatorId,
  type PredictionCase,
  type PredictionOutcome,
  type ProbabilityPrediction,
  type ProspectivePredictionCommitment,
  type ScoredPredictionCase,
} from './causal-prediction.js';
export {
  REGISTRATION_BINDING_KEYS,
  REGISTRATION_PACKET_COMPILER_VERSION,
  compileRegistrationPacket,
  type CompileRegistrationPacketInput,
  type CompiledRegistrationPacket,
  type RegistrationBinding,
  type RegistrationBindingKey,
  type RegistrationPacketArtifact,
} from './registration-packet.js';

// ---------------------------------------------------------------------------
// Intervention-suite and experiment-readiness scaffolds (BACKLOG ALD-072;
// ALD-074 E14/E15/E16, ALD-076 E31). Owned by the `@ald/interventions`
// workstream: seed-clustered inference (SPEC §15.2), the E15 composition
// readout, and the E31 checkpoint-drift readout.
// ---------------------------------------------------------------------------
export {
  HIERARCHICAL_ANALYSIS_VERSION,
  QUALIFICATION_MINIMUM_SEEDS,
  betaBinomialAgreement,
  fitBetaBinomial,
  seedLevelAgreement,
  welchTTest,
  type AgreementDecision,
  type BetaBinomialAgreementInput,
  type BetaBinomialAgreementResult,
  type BetaBinomialFit,
  type SeedAgreementCount,
  type SeedAgreementProportion,
  type SeedLevelAgreementInput,
  type SeedLevelAgreementResult,
  type WelchTTestResult,
} from './hierarchical.js';
export {
  COMPOSITION_ANALYSIS_VERSION,
  E15_CONFIRMATORY_MINIMUM_SEEDS,
  TOPOGRAPHIC_MAX_EPISODES,
  attributeHammingDistance,
  checkHeldOutSplitIntegrity,
  evaluateComposition,
  messageEditDistance,
  spearmanCorrelation,
  symbolReuse,
  topographicSimilarity,
  type BandwidthConditionInput,
  type BandwidthContrastResult,
  type BandwidthInferenceClass,
  type CompositionEpisode,
  type CompositionInput,
  type CompositionResult,
  type OrderProbeOutcome,
  type OrderSensitivityResult,
  type ProportionWithInterval,
  type SeedProportionInput,
  type SplitIntegrityResult,
  type SplitIntegrityViolationCode,
  type SymbolReuseResult,
  type TopographicResult,
} from './composition.js';
export {
  DEFAULT_STABILITY_TOLERANCE_BITS,
  DRIFT_ANALYSIS_VERSION,
  evaluateCheckpointDrift,
  symbolUsageDivergenceBits,
  type CheckpointEvaluation,
  type CheckpointPairDrift,
  type DriftInput,
  type DriftResult,
  type PairUnscoredReasonCode,
  type RegimeSeparation,
  type RegimeSeparationDecision,
  type StabilityInterval,
} from './drift.js';
