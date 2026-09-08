/**
 * ALD-058 — the run-metric half of SPECIFICATION.md §14.1: "turns/minute,
 * rejection rate, affect-window utilization, checkpoint latency, and
 * anchor-confirmation latency".
 *
 * These are computed on demand from the evidence store rather than accumulated
 * in the telemetry log, for three reasons:
 *
 * - the evidence store is authoritative and append-only (SPEC §13, LEDGER §3),
 *   so a metric derived from it is reproducible by anyone holding the bundle;
 * - a purged bundle (SPEC §14.6, ALD-062) leaves the SQLite rows intact, so
 *   metrics survive retention;
 * - nothing has to be written on the request path, which is what keeps
 *   ALD-058 criterion 2 (telemetry never blocks a request) cheap to honour.
 *
 * Every metric is `null` rather than `0` when the evidence cannot support it
 * (fewer than two turns, no channel events, an affect schedule this module
 * does not know how to count). A research-integrity rule, not a style choice:
 * a fabricated `0` would read as a measured value.
 */
import { parseCanonicalJson } from '@ald/hashing';
import {
  ChannelEventSchema,
  RunConfigSchema,
  TurnRecordSchema,
  type EvidenceReader,
  type RunConfig,
} from '@ald/types';

/** The read-only slice of the Evidence Writer these metrics need. */
export type RunMetricsReader = Pick<
  EvidenceReader,
  'readRunMetadata' | 'readEvents' | 'readCheckpoints' | 'readAnchorReceipts'
>;

/** Distribution summary of a latency series, in milliseconds. */
export interface LatencySummary {
  count: number;
  minMs: number;
  meanMs: number;
  medianMs: number;
  maxMs: number;
}

export interface RunMetrics {
  version: 1;
  runId: string;
  /** Turn records committed so far. */
  turns: number;
  /** `null` when fewer than two turns exist or they share one timestamp. */
  turnsPerMinute: number | null;
  /** Rejected / total channel events; `null` when the channel is empty. */
  rejectionRate: number | null;
  rejectedChannelEvents: number;
  channelEvents: number;
  /**
   * Affect events / windows the configured schedule opened. `null` when the
   * run has no affect channel (`affectMode: 'none'` / `'emergent'`) or the
   * schedule string is not one {@link windowsOpenedFor} understands.
   */
  affectWindowUtilization: number | null;
  affectEvents: number;
  /** Windows the schedule is expected to have opened; `null` when unknown. */
  affectWindowsOpened: number | null;
  /**
   * Per checkpoint: `createdAt` minus the `recordedAt` of the newest event the
   * checkpoint committed on the three mandatory trees (LEDGER §7). `null`
   * when no checkpoint covers a datable event.
   */
  checkpointLatencyMs: LatencySummary | null;
  /**
   * Per confirmed anchor receipt: `recordedAt` minus the `createdAt` of the
   * checkpoint it anchors (SPEC §13.4). `null` when nothing is confirmed.
   */
  anchorConfirmationLatencyMs: LatencySummary | null;
}

function summarize(values: readonly number[]): LatencySummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  const median =
    sorted.length % 2 === 1
      ? (upper ?? 0)
      : ((lower ?? 0) + (upper ?? 0)) / 2;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    meanMs: sum / sorted.length,
    medianMs: median,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * How many affect windows the configured schedule opens over `turns` turns.
 *
 * SPEC §9.3 rule 2 fixes window frequency before the run in
 * `RunConfig.affectWindowSchedule` and opens a window "immediately after a
 * Gateway-defined action/outcome event", so `post-outcome` is one window per
 * turn. `post-outcome-every-<n>-turns` is the only other spelling this module
 * recognizes; anything else returns `undefined` and the utilization metric is
 * reported as `null` rather than guessed.
 */
export function windowsOpenedFor(
  schedule: string,
  turns: number,
): number | undefined {
  if (schedule === 'post-outcome') {
    return turns;
  }
  const every = /^post-outcome-every-(\d+)-turns$/u.exec(schedule);
  const period = every?.[1];
  if (period !== undefined) {
    const size = Number(period);
    if (Number.isSafeInteger(size) && size > 0) {
      return Math.floor(turns / size);
    }
  }
  return undefined;
}

export interface ComputeRunMetricsOptions {
  evidence: RunMetricsReader;
  runId: string;
  /**
   * The run configuration. Read from `run_metadata` when omitted; pass it when
   * the caller already holds a validated config to avoid a second parse.
   */
  config?: RunConfig;
}

/**
 * Computes the five §14.1 run metrics from the evidence store. Read-only:
 * nothing here writes, and a run with no events yields a fully-`null` report
 * rather than an error.
 */
export function computeRunMetrics(
  options: ComputeRunMetricsOptions,
): RunMetrics {
  const { evidence, runId } = options;
  const metadata = evidence.readRunMetadata(runId);
  const config =
    options.config ??
    (metadata === undefined
      ? undefined
      : RunConfigSchema.parse(JSON.parse(metadata.configurationJson)));

  const turnEvents = evidence.readEvents(runId, 'turns');
  const turns = turnEvents.length;
  const firstTurnAt = turnEvents[0]?.recordedAt;
  const lastTurnAt = turnEvents[turns - 1]?.recordedAt;
  let turnsPerMinute: number | null = null;
  if (turns >= 2 && firstTurnAt !== undefined && lastTurnAt !== undefined) {
    const spanMs = Date.parse(lastTurnAt) - Date.parse(firstTurnAt);
    turnsPerMinute = spanMs > 0 ? (turns / spanMs) * 60_000 : null;
  }

  const channelEvents = evidence.readEvents(runId, 'channel').map((event) =>
    ChannelEventSchema.parse(parseCanonicalJson(event.canonicalJson)),
  );
  const rejectedChannelEvents = channelEvents.filter(
    (event) => event.gatewayValidationResult === 'rejected',
  ).length;

  const affectEvents = evidence.readEvents(runId, 'affect').length;
  const schedule = config?.affectWindowSchedule;
  const affectDisabled =
    config === undefined ||
    config.affectMode === 'none' ||
    config.affectMode === 'emergent';
  const affectWindowsOpened =
    affectDisabled || schedule === undefined
      ? null
      : (windowsOpenedFor(schedule, turns) ?? null);
  const affectWindowUtilization =
    affectWindowsOpened === null || affectWindowsOpened === 0
      ? null
      : affectEvents / affectWindowsOpened;

  return {
    version: 1,
    runId,
    turns,
    turnsPerMinute,
    rejectionRate:
      channelEvents.length === 0
        ? null
        : rejectedChannelEvents / channelEvents.length,
    rejectedChannelEvents,
    channelEvents: channelEvents.length,
    affectWindowUtilization,
    affectEvents,
    affectWindowsOpened,
    checkpointLatencyMs: summarize(checkpointLatencies(evidence, runId)),
    anchorConfirmationLatencyMs: summarize(
      anchorConfirmationLatencies(evidence, runId),
    ),
  };
}

/**
 * LEDGER §7/§8: a checkpoint's mandatory `TreeReference.treeSize` is the
 * number of events of that stream committed at checkpoint time, so the event
 * at `sequence === treeSize` is the newest one the checkpoint covers. Latency
 * is `createdAt` minus the newest such `recordedAt` across the three
 * mandatory trees — how long the newest committed event waited to be
 * checkpointed.
 */
function checkpointLatencies(
  evidence: RunMetricsReader,
  runId: string,
): number[] {
  const streams = [
    ['baby-a-ledger', 'babyA'],
    ['baby-b-ledger', 'babyB'],
    ['channel', 'channel'],
  ] as const;
  const latencies: number[] = [];
  for (const manifest of evidence.readCheckpoints(runId)) {
    const createdAt = Date.parse(manifest.createdAt);
    if (Number.isNaN(createdAt)) {
      continue;
    }
    let newest: number | undefined;
    for (const [stream, tree] of streams) {
      const size = manifest[tree].treeSize;
      if (size <= 0) {
        continue;
      }
      const [event] = evidence.readEvents(runId, stream, {
        fromSequence: size,
        toSequence: size,
      });
      if (event === undefined) {
        continue;
      }
      const at = Date.parse(event.recordedAt);
      if (!Number.isNaN(at) && (newest === undefined || at > newest)) {
        newest = at;
      }
    }
    if (newest !== undefined && createdAt >= newest) {
      latencies.push(createdAt - newest);
    }
  }
  return latencies;
}

/** SPEC §13.4: how long a confirmed anchor took from its checkpoint. */
function anchorConfirmationLatencies(
  evidence: RunMetricsReader,
  runId: string,
): number[] {
  const createdAtByHash = new Map(
    evidence
      .readCheckpoints(runId)
      .map((manifest) => [manifest.checkpointHash, manifest.createdAt]),
  );
  const latencies: number[] = [];
  for (const receipt of evidence.readAnchorReceipts(runId)) {
    if (receipt.status !== 'confirmed') {
      continue;
    }
    const createdAt = createdAtByHash.get(receipt.checkpointHash);
    if (createdAt === undefined) {
      continue;
    }
    const elapsed = Date.parse(receipt.recordedAt) - Date.parse(createdAt);
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      latencies.push(elapsed);
    }
  }
  return latencies;
}

/**
 * Phase counts of a run's turn records, used by the snapshot writer so a
 * restored runtime resumes with the same training/evaluation budgets the
 * snapshot recorded (SPEC §14.4, §18).
 */
export function turnPhaseCounts(
  evidence: Pick<EvidenceReader, 'readEvents'>,
  runId: string,
): { turns: number; trainingCount: number; evaluationCount: number } {
  const records = evidence
    .readEvents(runId, 'turns')
    .map((event) => TurnRecordSchema.parse(parseCanonicalJson(event.canonicalJson)));
  return {
    turns: records.length,
    trainingCount: records.filter((record) => record.phase === 'running').length,
    evaluationCount: records.filter((record) => record.phase === 'evaluating')
      .length,
  };
}
