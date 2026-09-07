/**
 * E03 controls-and-oracle harness (EXPERIMENT-NOTEBOOK.md E03;
 * RESEARCH.md Appendix D; SPECIFICATION.md §9.6, §15.3; BACKLOG ALD-072).
 *
 * Runs every requested §9.6 communication condition (`disabled`, `constant`,
 * `random`, `shuffled`, `normal` with learning disabled, and `oracle`) for
 * `seeds` slots each, all `no-learning` so the only thing under test is the
 * Gateway/channel condition itself, then hands the per-seed evaluation
 * success proportions to `@ald/analysis`'s `e03Analysis` (RESEARCH.md
 * Appendix D §D.6-§D.10).
 *
 * Every run is Prototype Mode (§5.1) with `anchorPolicy: 'skip'` on the
 * injected runtime (see `production.ts`), so — per §7.2 — every run's
 * disposition is `invalid` by construction. `QUALIFICATION_LABEL` says this
 * plainly: nothing this harness produces is a pre-registered research finding
 * (ALD-072 acceptance criterion 3).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  E03_ORACLE_LOWER_BOUND,
  E03_SEPARATION_LOWER_BOUND,
  e03Analysis,
  type E03Analysis,
  type EpisodeCounts,
} from '@ald/analysis';
import { deriveSeedHex } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  VerificationReportSchema,
  type RunState,
  type VerificationReport,
} from '@ald/types';

import type { NurseryRuntimeImpl } from '../nursery-runtime.js';

/** SPEC §9.6 communication conditions E03 exercises, oracle included. */
export const E03_CONDITIONS = [
  'disabled',
  'constant',
  'random',
  'shuffled',
  'normal',
  'oracle',
] as const;

export type E03Condition = (typeof E03_CONDITIONS)[number];

/**
 * Non-confirmatory software-qualification banner (ALD-072 acceptance
 * criterion 3): every run this harness produces is Prototype Mode, is not
 * pre-registered, submits no Base anchor, and is `invalid` by construction
 * (SPECIFICATION.md §7.2) — so nothing here is a research finding.
 */
export const QUALIFICATION_LABEL =
  'Non-confirmatory software-qualification run executed in Prototype Mode: ' +
  'not pre-registered, no Base anchor submitted, every run disposition is ' +
  'invalid by construction (SPECIFICATION.md §7.2), and nothing here is a ' +
  'research finding.';

export interface E03ProgressEvent {
  readonly condition: E03Condition;
  readonly slot: number;
  readonly runId: string;
  readonly state: RunState;
  readonly successRate: number;
}

export interface RunE03ControlsOptions {
  /** Seeds (slots) per condition. */
  readonly seeds: number;
  /** Evaluation-phase turns per run (default 200). */
  readonly episodes?: number;
  /** Default: all six `E03_CONDITIONS`. Must include `'oracle'`. */
  readonly conditions?: readonly E03Condition[];
  readonly runIdPrefix?: string;
  readonly seedLabel?: string;
  readonly symbolInventorySize?: number;
  readonly maxSymbolsPerMessage?: number;
  readonly alpha?: number;
  readonly equivalenceLower?: number;
  readonly equivalenceUpper?: number;
  readonly oracleLowerBound?: number;
  readonly separationLowerBound?: number;
  readonly analysisSeed?: string;
  readonly softwareCommit: string;
  readonly onProgress?: (event: E03ProgressEvent) => void;
}

export interface E03RunSummary {
  readonly runId: string;
  readonly condition: E03Condition;
  readonly slot: number;
  readonly evaluationTurns: number;
  readonly successes: number;
  readonly proportion: number;
  readonly configurationHash: string;
  readonly finalCheckpointHash: string | undefined;
  readonly replayDigest: string;
  /** Full `disposition` history from `experimentRecords(runId)`. */
  readonly dispositions: string[];
  readonly verifierExitCode: number;
  readonly state: RunState;
}

export interface E03Params {
  readonly seeds: number;
  readonly episodes: number;
  readonly conditions: readonly E03Condition[];
  readonly symbolInventorySize: number;
  readonly maxSymbolsPerMessage: number;
  readonly alpha: number;
  readonly equivalenceLower: number;
  readonly equivalenceUpper: number;
  readonly oracleLowerBound: number;
  readonly separationLowerBound: number;
}

export interface E03Result {
  readonly experimentId: 'E03';
  readonly params: E03Params;
  readonly runs: E03RunSummary[];
  readonly analysis: E03Analysis;
  readonly verifierExitCodes: Record<string, number>;
  readonly allBundlesVerified: boolean;
  readonly generatedAt: string;
  readonly softwareCommit: string;
  readonly claimBoundaryStatement: string;
  readonly qualificationLabel: string;
}

/**
 * Appendix D §D.5: the non-oracle `normal` condition analysed here is the
 * no-learning control, distinct from E11's learning `normal` condition — so
 * it is keyed `normal-no-learning` in the analysis input.
 */
function analysisKeyFor(condition: E03Condition): string {
  return condition === 'normal' ? 'normal-no-learning' : condition;
}

/** Reads the verifier report `seal()` already wrote, or runs it if absent. */
async function readOrRunVerification(
  runtime: NurseryRuntimeImpl,
  runId: string,
): Promise<VerificationReport> {
  const bundleDir = runtime.bundleDirFor(runId);
  try {
    const raw = await readFile(
      join(bundleDir, 'verification-report.json'),
      'utf8',
    );
    return VerificationReportSchema.parse(JSON.parse(raw));
  } catch {
    return runtime.verify(runId, bundleDir);
  }
}

/**
 * Runs every requested condition for `seeds` slots, then evaluates the
 * Appendix D §D.10 decision rule over the resulting seed-level success
 * proportions. See the module doc for what `qualifies` does and does not
 * mean at qualification-run seed counts.
 */
export async function runE03Controls(
  runtime: NurseryRuntimeImpl,
  options: RunE03ControlsOptions,
): Promise<E03Result> {
  const episodes = options.episodes ?? 200;
  const conditions = options.conditions ?? E03_CONDITIONS;
  if (!conditions.includes('oracle')) {
    throw new Error(
      "runE03Controls: 'oracle' must be included — Appendix D's " +
        'chance-baseline analysis compares every control against it',
    );
  }
  const runIdPrefix = options.runIdPrefix ?? 'e03';
  const seedLabel = options.seedLabel ?? 'ald-e03-v1';
  const symbolInventorySize = options.symbolInventorySize ?? 32;
  const maxSymbolsPerMessage = options.maxSymbolsPerMessage ?? 1;
  const alpha = options.alpha ?? 0.05;
  const equivalenceLower = options.equivalenceLower ?? 0.2;
  const equivalenceUpper = options.equivalenceUpper ?? 0.3;
  const oracleLowerBound = options.oracleLowerBound ?? E03_ORACLE_LOWER_BOUND;
  const separationLowerBound =
    options.separationLowerBound ?? E03_SEPARATION_LOWER_BOUND;

  const proportionsByCondition = new Map<E03Condition, number[]>(
    conditions.map((condition) => [condition, []]),
  );
  const runs: E03RunSummary[] = [];
  const verifierExitCodes: Record<string, number> = {};

  for (const condition of conditions) {
    for (let slot = 1; slot <= options.seeds; slot += 1) {
      const randomSeed = deriveSeedHex(seedLabel, String(slot));
      const runId = `${runIdPrefix}-${condition}-s${String(slot)}`;

      const config = buildRunConfig({
        runId,
        experimentId: 'E03',
        randomSeed,
        deploymentMode: 'prototype',
        babyA: {
          track: 'no-learning',
          modelRef: 'uniform-random-v1',
          trainingIsolation: 'independent',
        },
        babyB: {
          track: 'no-learning',
          modelRef: 'uniform-random-v1',
          trainingIsolation: 'independent',
        },
        learningSignal: 'none',
        communicationCondition: condition,
        // Schema minimum: E03's no-learning Babies never train, so the one
        // admissible training turn is excluded from the evaluation analysis
        // below (only `phase === 'evaluating'` turn records are counted).
        maxTurnsPerRun: 1,
        evaluationTurns: episodes,
        symbolInventorySize,
        maxSymbolsPerMessage,
        evaluationSeeds: options.seeds,
      });

      await runtime.createRun(config);
      const summary = await runtime.runToCompletion(runId);

      const evaluationRecords = runtime
        .turnRecords(runId)
        .filter((record) => record.phase === 'evaluating');
      const successes = evaluationRecords.filter(
        (record) => (record.outcome as { success?: unknown }).success === true,
      ).length;
      const proportion =
        evaluationRecords.length === 0
          ? 0
          : successes / evaluationRecords.length;
      proportionsByCondition.get(condition)?.push(proportion);

      const configurationHash =
        runtime.getRun(runId)?.configurationHash ?? '';
      const finalCheckpointHash = runtime
        .checkpoints(runId)
        .at(-1)?.checkpointHash;
      const report = await readOrRunVerification(runtime, runId);
      verifierExitCodes[runId] = report.exitCode;

      runs.push({
        runId,
        condition,
        slot,
        evaluationTurns: evaluationRecords.length,
        successes,
        proportion,
        configurationHash,
        finalCheckpointHash,
        replayDigest: runtime.replayDigest(runId),
        dispositions: runtime
          .experimentRecords(runId)
          .map((record) => record.disposition),
        verifierExitCode: report.exitCode,
        state: summary.state,
      });

      options.onProgress?.({
        condition,
        slot,
        runId,
        state: summary.state,
        successRate: proportion,
      });
    }
  }

  const conditionsInput: Record<string, number[]> = {};
  const episodeCounts: Record<string, EpisodeCounts> = { oracle: episodes };
  for (const condition of conditions) {
    if (condition === 'oracle') {
      continue;
    }
    const key = analysisKeyFor(condition);
    conditionsInput[key] = proportionsByCondition.get(condition) ?? [];
    episodeCounts[key] = episodes;
  }

  const analysis = e03Analysis({
    alpha,
    equivalenceLower,
    equivalenceUpper,
    oracleLowerBound,
    separationLowerBound,
    seed: options.analysisSeed ?? deriveSeedHex(seedLabel, 'analysis'),
    conditions: conditionsInput,
    oracle: proportionsByCondition.get('oracle') ?? [],
    episodeCounts,
  });

  return {
    experimentId: 'E03',
    params: {
      seeds: options.seeds,
      episodes,
      conditions,
      symbolInventorySize,
      maxSymbolsPerMessage,
      alpha,
      equivalenceLower,
      equivalenceUpper,
      oracleLowerBound,
      separationLowerBound,
    },
    runs,
    analysis,
    verifierExitCodes,
    allBundlesVerified: Object.values(verifierExitCodes).every(
      (code) => code === 0,
    ),
    generatedAt: new Date().toISOString(),
    softwareCommit: options.softwareCommit,
    claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS.prototype,
    qualificationLabel: QUALIFICATION_LABEL,
  };
}
