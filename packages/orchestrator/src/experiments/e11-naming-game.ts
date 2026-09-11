/**
 * E11 from-scratch-RL naming-game harness (EXPERIMENT-NOTEBOOK.md E11;
 * SPECIFICATION.md §6.1 `scratch-rl`, §15.3; BACKLOG ALD-072).
 *
 * Runs `seeds` independent `scratch-rl` vs `scratch-rl` runs under the
 * `normal` communication condition with an extrinsic-task learning signal,
 * then hands the per-turn outcomes to `@ald/analysis`'s `e11Summary`
 * (windowed training curve, evaluation Wilson interval, and a one-sided
 * above-chance comparison) and adds three readouts the analysis package does
 * not compute: vocabulary utilisation, evaluation-phase symbol entropy, and
 * policy-hash constancy across the evaluation phase.
 *
 * The `LearnerAdapterOptions` a caller intends for this run (learning rate,
 * softmax temperature, message length) are a construction-time option of the
 * *runtime*, not of this function (see `NurseryRuntimeOptions.learnerOptions`)
 * — so the caller must build the runtime with `createProductionRuntime({
 * learnerOptions: { shared: options.learnerOptions } })` (or per-role) using
 * the same values passed here, or the adapters and this harness's
 * `maxSymbolsPerMessage` will disagree. `NurseryRuntimeImpl` does not expose
 * the options it was built with, so this harness cannot assert the match
 * itself; it documents the requirement instead (ALD-072 acceptance
 * criterion 1: the runtime's *configuration* is what changes per run, not
 * its code).
 *
 * Every run is Prototype Mode with `anchorPolicy: 'skip'`, so — per §7.2 —
 * every disposition is `invalid` by construction; `QUALIFICATION_LABEL` says
 * so plainly.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  E03_CHANCE_RATE,
  e11Summary,
  type BinomialTestResult,
  type E11Summary as E11SummaryStats,
  type WilsonInterval,
} from '@ald/analysis';
import { deriveSeedHex } from '@ald/hashing';
import { RECURRENT_ARCHITECTURE } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  VerificationReportSchema,
  type BabyRole,
  type LedgerEvent,
  type RunState,
  type TurnResult,
  type VerificationReport,
} from '@ald/types';

import { BABY_ROLES, type NurseryRuntimeImpl } from '../nursery-runtime.js';
import { QUALIFICATION_LABEL } from './e03-controls.js';

export { QUALIFICATION_LABEL };

/** Knobs forwarded to `createProductionRuntime`'s `learnerOptions` — see module doc. */
export interface E11LearnerOptions {
  readonly learningRate?: number;
  readonly temperature?: number;
  readonly messageLength?: number;
}

export interface E11ProgressEvent {
  readonly slot: number;
  readonly runId: string;
  readonly state: RunState;
  readonly evaluationSuccess: number;
}

export interface RunE11NamingGameOptions {
  readonly seeds: number;
  readonly trainingTurns?: number;
  readonly evaluationTurns?: number;
  readonly learnerOptions?: E11LearnerOptions;
  readonly symbolInventorySize?: number;
  readonly windowSize?: number;
  readonly runIdPrefix?: string;
  readonly seedLabel?: string;
  readonly softwareCommit: string;
  /** Scientific default is the recurrent GRU; tabular remains a named control. */
  readonly architecture?: 'tabular-reference' | typeof RECURRENT_ARCHITECTURE;
  readonly onProgress?: (event: E11ProgressEvent) => void;
}

export interface E11RunSummary {
  readonly runId: string;
  readonly slot: number;
  readonly summary: E11SummaryStats;
  /** `summary.trainingCurve`'s last window rate, `undefined` if there is none. */
  readonly lastWindowTrainingSuccess: number | undefined;
  readonly evaluationSuccess: number;
  readonly wilson: WilsonInterval;
  readonly chanceTest: BinomialTestResult;
  /** Distinct symbols emitted in the evaluation phase, over `symbolInventorySize`. */
  readonly vocabularyUtilization: number;
  /** Shannon entropy, in bits, of evaluation-phase emitted symbols. */
  readonly symbolEntropyBits: number;
  /** Each Baby's `policy.checkpointed` hash matches from evaluation start to seal. */
  readonly policyHashConstant: boolean;
  readonly ledgerEventCounts: Record<BabyRole, Record<string, number>>;
  readonly verifierExitCode: number;
  readonly replayDigest: string;
  readonly configurationHash: string;
  readonly finalCheckpointHash: string | undefined;
  readonly state: RunState;
  readonly dispositions: string[];
}

export interface E11Aggregate {
  readonly seeds: number;
  readonly meanEvaluationSuccess: number;
  /**
   * `null` when `seeds < 2` (the sample standard deviation is undefined
   * there) rather than `NaN`, so the aggregate stays representable in the
   * canonical-JSON report artifact.
   */
  readonly sdEvaluationSuccess: number | null;
}

export interface E11Params {
  readonly seeds: number;
  readonly trainingTurns: number;
  readonly evaluationTurns: number;
  readonly learnerOptions: Required<E11LearnerOptions>;
  readonly symbolInventorySize: number;
  readonly windowSize: number;
  readonly architecture: 'tabular-reference' | typeof RECURRENT_ARCHITECTURE;
}

export interface E11Result {
  readonly experimentId: 'E11';
  readonly params: E11Params;
  readonly runs: E11RunSummary[];
  readonly aggregate: E11Aggregate;
  readonly generatedAt: string;
  readonly softwareCommit: string;
  readonly claimBoundaryStatement: string;
  readonly qualificationLabel: string;
}

/** Shannon entropy in bits of a symbol multiset; `0` for an empty sample. */
function shannonEntropyBits(symbols: readonly string[]): number {
  if (symbols.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  const total = symbols.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** The sender-emitted `symbols` of one `intention.recorded` event, if present. */
function emittedSymbols(event: LedgerEvent): string[] | undefined {
  if (
    event.eventType !== 'intention.recorded' ||
    !event.subjectId.startsWith('symbol:')
  ) {
    return undefined;
  }
  const symbols = event.content['symbols'];
  return Array.isArray(symbols)
    ? symbols.filter((symbol): symbol is string => typeof symbol === 'string')
    : undefined;
}

/** `content.policyHash` of a `policy.checkpointed` event, if present. */
function policyHashOf(event: LedgerEvent): string | undefined {
  if (event.eventType !== 'policy.checkpointed') {
    return undefined;
  }
  const hash = event.content['policyHash'];
  return typeof hash === 'string' ? hash : undefined;
}

function ledgerEventCountsOf(events: readonly LedgerEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  }
  return counts;
}

/**
 * SPEC §7.2: `updatePolicy` is disabled once evaluation starts, so a Baby's
 * last `policy.checkpointed` event before evaluation (written at the
 * `begin-evaluation` transition) and its very last one (written during
 * `seal()`) should carry the same `policyHash`. Both harness-relevant events
 * are therefore the last two `policy.checkpointed` events in ledger order;
 * `false` if either is missing.
 */
function policyConstantFor(events: readonly LedgerEvent[]): boolean {
  const checkpoints = events
    .map(policyHashOf)
    .filter((hash): hash is string => hash !== undefined);
  if (checkpoints.length < 2) {
    return false;
  }
  return checkpoints.at(-2) === checkpoints.at(-1);
}

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

export async function runE11NamingGame(
  runtime: NurseryRuntimeImpl,
  options: RunE11NamingGameOptions,
): Promise<E11Result> {
  const trainingTurns = options.trainingTurns ?? 3000;
  const evaluationTurns = options.evaluationTurns ?? 200;
  const windowSize = options.windowSize ?? 100;
  const symbolInventorySize = options.symbolInventorySize ?? 32;
  const learnerOptions: Required<E11LearnerOptions> = {
    learningRate:
      options.learnerOptions?.learningRate ??
      (options.architecture === 'tabular-reference' ? 1 : 0.003),
    temperature:
      options.learnerOptions?.temperature ??
      (options.architecture === 'tabular-reference' ? 0.5 : 1),
    messageLength: options.learnerOptions?.messageLength ?? 1,
  };
  const runIdPrefix = options.runIdPrefix ?? 'e11';
  const seedLabel = options.seedLabel ?? 'ald-e11-v1';
  const architecture = options.architecture ?? RECURRENT_ARCHITECTURE;

  const runs: E11RunSummary[] = [];
  const evaluationMeans: number[] = [];

  for (let slot = 1; slot <= options.seeds; slot += 1) {
    const randomSeed = deriveSeedHex(seedLabel, String(slot));
    const runId = `${runIdPrefix}-s${String(slot)}`;

    const config = buildRunConfig({
      runId,
      experimentId: 'E11',
      randomSeed,
      deploymentMode: 'prototype',
      babyA: {
        track: 'scratch-rl',
        modelRef:
          architecture === 'tabular-reference'
            ? 'tabular-reinforce-v1'
            : RECURRENT_ARCHITECTURE,
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'scratch-rl',
        modelRef:
          architecture === 'tabular-reference'
            ? 'tabular-reinforce-v1'
            : RECURRENT_ARCHITECTURE,
        trainingIsolation: 'independent',
      },
      learningSignal: 'extrinsic-task',
      communicationCondition: 'normal',
      maxTurnsPerRun: trainingTurns,
      evaluationTurns,
      symbolInventorySize,
      maxSymbolsPerMessage: learnerOptions.messageLength,
      evaluationSeeds: options.seeds,
    });

    await runtime.createRun(config);

    const trainingSuccess: number[] = [];
    const evaluationSuccess: number[] = [];
    const evaluationTurnNumbers = new Set<number>();
    const summary = await runtime.runToCompletion(runId, {
      onTurn: (result: TurnResult) => {
        const success = result.outcome.success ? 1 : 0;
        if (result.phase === 'running') {
          trainingSuccess.push(success);
        } else {
          evaluationSuccess.push(success);
          evaluationTurnNumbers.add(result.turn);
        }
      },
    });

    const stats = e11Summary({
      trainingSuccess,
      evaluationSuccess,
      windowSize,
      chanceRate: E03_CHANCE_RATE,
    });

    const ledgers = runtime.ledgers(runId);
    const emitted: string[] = [];
    let policyHashConstant = true;
    for (const role of BABY_ROLES) {
      const events = role === 'baby-a' ? ledgers.babyA : ledgers.babyB;
      policyHashConstant &&= policyConstantFor(events);
      for (const event of events) {
        if (!evaluationTurnNumbers.has(event.turn)) {
          continue;
        }
        const symbols = emittedSymbols(event);
        if (symbols !== undefined) {
          emitted.push(...symbols);
        }
      }
    }
    const ledgerEventCounts: Record<BabyRole, Record<string, number>> = {
      'baby-a': ledgerEventCountsOf(ledgers.babyA),
      'baby-b': ledgerEventCountsOf(ledgers.babyB),
    };
    const distinctSymbols = new Set(emitted).size;

    const configurationHash = runtime.getRun(runId)?.configurationHash ?? '';
    const finalCheckpointHash = runtime
      .checkpoints(runId)
      .at(-1)?.checkpointHash;
    const report = await readOrRunVerification(runtime, runId);

    evaluationMeans.push(stats.evaluation.proportion);
    runs.push({
      runId,
      slot,
      summary: stats,
      lastWindowTrainingSuccess: stats.trainingCurve.at(-1)?.rate,
      evaluationSuccess: stats.evaluation.proportion,
      wilson: stats.evaluationWilson,
      chanceTest: stats.chanceComparison,
      vocabularyUtilization: distinctSymbols / symbolInventorySize,
      symbolEntropyBits: shannonEntropyBits(emitted),
      policyHashConstant,
      ledgerEventCounts,
      verifierExitCode: report.exitCode,
      replayDigest: runtime.replayDigest(runId),
      configurationHash,
      finalCheckpointHash,
      state: summary.state,
      dispositions: runtime
        .experimentRecords(runId)
        .map((record) => record.disposition),
    });

    options.onProgress?.({
      slot,
      runId,
      state: summary.state,
      evaluationSuccess: stats.evaluation.proportion,
    });
  }

  const meanEvaluationSuccess =
    evaluationMeans.reduce((total, value) => total + value, 0) /
    evaluationMeans.length;
  const sdEvaluationSuccess =
    evaluationMeans.length < 2
      ? null
      : Math.sqrt(
          evaluationMeans.reduce(
            (total, value) => total + (value - meanEvaluationSuccess) ** 2,
            0,
          ) /
            (evaluationMeans.length - 1),
        );

  return {
    experimentId: 'E11',
    params: {
      seeds: options.seeds,
      trainingTurns,
      evaluationTurns,
      learnerOptions,
      symbolInventorySize,
      windowSize,
      architecture,
    },
    runs,
    aggregate: {
      seeds: options.seeds,
      meanEvaluationSuccess,
      sdEvaluationSuccess,
    },
    generatedAt: new Date().toISOString(),
    softwareCommit: options.softwareCommit,
    claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS.prototype,
    qualificationLabel: QUALIFICATION_LABEL,
  };
}
