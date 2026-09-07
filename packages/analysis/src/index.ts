/**
 * @ald/analysis — the pre-registered statistics toolkit for the experiment
 * harnesses (BACKLOG ALD-072 "baseline/statistics scaffold";
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
 */
export {
  AnalysisError,
  type AnalysisErrorCode,
} from './errors.js';
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
  E03_CHANCE_RATE,
  e11Summary,
  type E11Summary,
  type E11SummaryInput,
  type E11TrainingWindow,
} from './e11.js';
