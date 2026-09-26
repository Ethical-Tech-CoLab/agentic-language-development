/**
 * LV01 H07 uncertain-write diagnostic (bounded commit-without-confirmation case).
 *
 * LV01-application-fault v3 covers two service-death cases and nothing else;
 * this is the minimal next H07 step at LV01 scope: one in-process run through
 * the mode-r uncertain-write v6 single path (commit, lost reply, live
 * quarantine, restarted recovery refusal, no retry). No Docker, no network,
 * no anchor: the evidence store and the durable Gateway write-intent journal
 * are real, everything else is the ordinary `NurseryRuntime` contract.
 *
 * Nothing here is a research finding and nothing here closes H07 — see
 * `LV01_UNCERTAIN_WRITE_DIAGNOSTIC_CLAIM`.
 */
import type { NurseryRuntimeImpl } from '../nursery-runtime.js';

/**
 * Bounded claim for this diagnostic: one LV01-scope commit-without-
 * confirmation case. Software qualification only — not a behavioral result,
 * pilot, detector result, or H07 closure.
 */
export const LV01_UNCERTAIN_WRITE_DIAGNOSTIC_CLAIM =
  'One LV01-scope commit-without-confirmation case: a committed write with ' +
  'no confirmation quarantines the live run without retry, and a restarted ' +
  'runtime refuses recovery without adding evidence. Software qualification ' +
  'only, not a behavioral result, pilot, detector result, or H07 closure.';

/** Evidence counts that must freeze once the write outcome is uncertain. */
export interface Lv01UncertainWriteCounts {
  readonly turns: number;
  readonly channel: number;
  readonly babyALedger: number;
  readonly babyBLedger: number;
}

/** What the inject half of the diagnostic observed. */
export interface Lv01UncertainWriteInjectObservation {
  readonly runId: string;
  readonly liveErrorName: string;
  readonly liveQuarantine: string | undefined;
  /** Durable writer commits: exactly one — the run must never retry. */
  readonly writerCommitCalls: number;
  readonly before: Lv01UncertainWriteCounts;
  readonly afterFirst: Lv01UncertainWriteCounts;
  readonly afterSecond: Lv01UncertainWriteCounts;
}

/** What the restarted runtime observed. */
export interface Lv01UncertainWriteRecoveryObservation {
  readonly runId: string;
  readonly recoveryErrorName: string;
  readonly stepErrorName: string;
  readonly recoveryQuarantine: string | undefined;
  readonly turnRecords: number;
  readonly afterRecovery: Lv01UncertainWriteCounts;
  readonly afterStep: Lv01UncertainWriteCounts;
}

export interface Lv01UncertainWriteDiagnosticObservation {
  readonly inject: Lv01UncertainWriteInjectObservation;
  readonly recovery: Lv01UncertainWriteRecoveryObservation;
}

function fail(message: string): never {
  throw new Error(`LV01 uncertain-write diagnostic: ${message}`);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonErrorThrow';
}

/** Read-only evidence counts for one loaded run. */
export function lv01UncertainWriteCounts(
  runtime: NurseryRuntimeImpl,
  runId: string,
): Lv01UncertainWriteCounts {
  const writer = runtime.writerFor(runId);
  return {
    turns: runtime.turnRecords(runId).length,
    channel: writer.readEvents(runId, 'channel').length,
    babyALedger: writer.readEvents(runId, 'baby-a-ledger').length,
    babyBLedger: writer.readEvents(runId, 'baby-b-ledger').length,
  };
}

/**
 * Inject half: one step whose evidence write commits durably but whose reply
 * is lost. The writer wrapper commits exactly once through the real writer
 * and then reports the reply lost; any second commit attempt is refused
 * without writing, so a runtime retry would surface as `writerCommitCalls`.
 */
export async function injectLv01UncertainWrite(
  runtime: NurseryRuntimeImpl,
  runId: string,
): Promise<Lv01UncertainWriteInjectObservation> {
  const writer = runtime.writerFor(runId);
  const committed = writer.commitTurn.bind(writer);
  let writerCommitCalls = 0;
  const replyLost = async (
    request: Parameters<typeof writer.commitTurn>[0],
  ): Promise<never> => {
    writerCommitCalls += 1;
    if (writerCommitCalls > 1) fail('runtime retried a write of uncertain outcome');
    await committed(request);
    throw new Error('reply lost after commit');
  };
  const previous = writer.commitTurn;
  writer.commitTurn = replyLost as typeof writer.commitTurn;
  try {
    const before = lv01UncertainWriteCounts(runtime, runId);
    let liveErrorName = 'unexpected-success';
    try {
      await runtime.step(runId);
    } catch (error) {
      liveErrorName = errorName(error);
    }
    const afterFirst = lv01UncertainWriteCounts(runtime, runId);
    let secondErrorName = 'unexpected-success';
    try {
      await runtime.step(runId);
    } catch (error) {
      secondErrorName = errorName(error);
    }
    const afterSecond = lv01UncertainWriteCounts(runtime, runId);
    if (secondErrorName !== liveErrorName) {
      fail(`second attempt diverged: ${liveErrorName} then ${secondErrorName}`);
    }
    return {
      runId,
      liveErrorName,
      liveQuarantine: runtime.getRun(runId)?.operationalQuarantine,
      writerCommitCalls,
      before,
      afterFirst,
      afterSecond,
    };
  } finally {
    writer.commitTurn = previous;
  }
}

/**
 * Recovery half: a restarted runtime over the same store must refuse both
 * `recover` and `step` without appending evidence. The restarted runtime
 * loads the run lazily, so counts are read after each refusal; the auditor
 * pins them against the inject half's frozen prefix.
 */
export async function recoverLv01UncertainWrite(
  runtime: NurseryRuntimeImpl,
  runId: string,
): Promise<Lv01UncertainWriteRecoveryObservation> {
  let recoveryErrorName = 'unexpected-success';
  try {
    await runtime.recover(runId);
  } catch (error) {
    recoveryErrorName = errorName(error);
  }
  const afterRecovery = lv01UncertainWriteCounts(runtime, runId);
  let stepErrorName = 'unexpected-success';
  try {
    await runtime.step(runId);
  } catch (error) {
    stepErrorName = errorName(error);
  }
  const afterStep = lv01UncertainWriteCounts(runtime, runId);
  return {
    runId,
    recoveryErrorName,
    stepErrorName,
    recoveryQuarantine: runtime.getRun(runId)?.operationalQuarantine,
    turnRecords: runtime.turnRecords(runId).length,
    afterRecovery,
    afterStep,
  };
}

function equalCounts(left: Lv01UncertainWriteCounts, right: Lv01UncertainWriteCounts): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Auditor for the v6 single path at LV01 scope: the commit is durable
 * (channel and sender ledger advance, no turn record), the live run
 * quarantines without retry, and the restarted runtime refuses recovery
 * without adding evidence. The reconstructed runtime inherits the live
 * process's epistemic uncertainty label (`EvidenceWriteUncertainError`,
 * `evidence-write-uncertain`) because the durable write-intent journal
 * survives the restart; that is the in-process contract pinned here.
 */
export function auditLv01UncertainWriteDiagnostic(
  observation: Lv01UncertainWriteDiagnosticObservation,
): void {
  const { inject, recovery } = observation;
  if (inject.liveErrorName !== 'EvidenceWriteUncertainError') {
    fail(`live step must report an uncertain write, saw ${inject.liveErrorName}`);
  }
  if (inject.liveQuarantine !== 'evidence-write-uncertain') {
    fail(`live run must quarantine as evidence-write-uncertain, saw ${String(inject.liveQuarantine)}`);
  }
  if (inject.writerCommitCalls !== 1) {
    fail(`exactly one durable write is permitted, saw ${String(inject.writerCommitCalls)}`);
  }
  if (inject.afterFirst.channel - inject.before.channel !== 1) {
    fail('the unconfirmed write must leave one committed channel event');
  }
  // The turn-0 sender role is configuration-dependent, so the ledger pin is
  // role-agnostic: exactly one Baby ledger gains the committed intention pair
  // (private-ledger intention plus the turn commit's sender event), matching
  // the v6 development acceptance sender delta of 2.
  const ledgerDeltas = [
    inject.afterFirst.babyALedger - inject.before.babyALedger,
    inject.afterFirst.babyBLedger - inject.before.babyBLedger,
  ].sort((left, right) => left - right);
  if (ledgerDeltas[0] !== 0 || ledgerDeltas[1] !== 2) {
    fail('the unconfirmed write must leave the committed sender ledger pair');
  }
  if (inject.afterFirst.turns - inject.before.turns !== 0) {
    fail('the unconfirmed write must complete no turn record');
  }
  if (!equalCounts(inject.afterFirst, inject.afterSecond)) {
    fail('the second attempt must not add evidence');
  }
  if (recovery.recoveryErrorName !== 'EvidenceWriteUncertainError') {
    fail(`restarted recovery must refuse the uncertain write, saw ${recovery.recoveryErrorName}`);
  }
  if (recovery.stepErrorName !== 'EvidenceWriteUncertainError') {
    fail(`restarted step must refuse the uncertain write, saw ${recovery.stepErrorName}`);
  }
  if (recovery.recoveryQuarantine !== 'evidence-write-uncertain') {
    fail(`restarted run must quarantine as evidence-write-uncertain, saw ${String(recovery.recoveryQuarantine)}`);
  }
  if (!equalCounts(inject.afterSecond, recovery.afterRecovery)) {
    fail('restart and recovery must not add evidence');
  }
  if (!equalCounts(recovery.afterRecovery, recovery.afterStep)) {
    fail('post-recovery step must not add evidence');
  }
  if (!equalCounts(inject.afterSecond, recovery.afterStep)) {
    fail('the committed prefix must be identical before and after restart');
  }
  if (recovery.turnRecords !== 0) {
    fail(`no turn record may complete, saw ${String(recovery.turnRecords)}`);
  }
}
