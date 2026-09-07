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
