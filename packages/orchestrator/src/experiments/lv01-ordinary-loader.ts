/**
 * LV01 ordinary-record loader (R04/R05 parent-evidence remainder).
 *
 * Pure: parent bundle documents plus the committed schedule and the frozen
 * token inventory in, ordinary records out. Implements HANDYM's
 * row-extraction mapping v1 (plans/drafts/lv01-row-extraction-mapping.v1.md,
 * Q1-Q5) plus the v1.1 C3a distinct test-episode rejection: one record per
 * executed scheduled case in the training/validation partitions,
 * delivery/action facts from the turn's intention record plus outcome
 * agreement, candidate codes from the joined scheduled case, counts bound
 * to schedule membership, per-role fits downstream.
 *
 * The evidence-to-schedule join rides the codebase's established key: the
 * turn's served scenarioStateHash against the scheduled case's unique
 * stateHash (collector served-case check precedent). Intention/outcome
 * agreement follows the audit-loader branch precedent, keyed per episode
 * turn so multi-episode parent bundles extract; single-turn bundles match
 * the turn-0 precedent exactly.
 */
import type { Lv01OrdinaryRecord } from '@ald/analysis';

import { typedLedger, typedTurns, type Lv01BundleDocs } from './lv01-audit-loader.js';
import type { Lv01Schedule, Lv01ScheduledCase } from './lv01-schedule.js';

function fail(message: string): never {
  throw new Error(`LV01 ordinary loader: ${message}`);
}

/** Training/validation partitions only; test rows are never ordinary (Q1). */
const ORDINARY_PARTITIONS = ['training', 'validation-fit', 'validation-selection'] as const;

/**
 * Extract ordinary records from parent evidence joined to the schedule.
 * Fail-closed throughout: unlisted/duplicate/test episodes, intention/outcome
 * disagreement, missing delivery facts, out-of-inventory tokens, and empty
 * bundles all throw — never reconcile, impute, or silently drop (Q1-Q4).
 */
export function extractLv01OrdinaryRecords(input: {
  readonly parentDocs: Lv01BundleDocs;
  readonly schedule: Lv01Schedule;
  readonly inventory: readonly string[];
}): readonly Lv01OrdinaryRecord[] {
  if (input.inventory.length !== 32 || new Set(input.inventory).size !== 32) {
    fail('LV01 requires 32 distinct inventory tokens');
  }
  const home = new Map<string, Lv01ScheduledCase>();
  for (const partition of ORDINARY_PARTITIONS) {
    for (const entry of input.schedule.cases[partition]) {
      if (home.has(entry.stateHash)) fail(`schedule lists scenario ${entry.stateHash} twice`);
      home.set(entry.stateHash, entry);
    }
  }
  // Mapping v1.1 C3a: test-partition episodes get their own rejection so a
  // test turn never hides inside the generic unlisted-episode error.
  const testHashes = new Set(input.schedule.cases['within-support-test'].map((entry) => entry.stateHash));
  const turns = typedTurns(input.parentDocs);
  if (turns.length === 0) fail('parent bundle carries no turn records');
  const ledgerA = typedLedger(input.parentDocs.ledgerA, 'baby-a-ledger.jsonl');
  const ledgerB = typedLedger(input.parentDocs.ledgerB, 'baby-b-ledger.jsonl');
  const records: Lv01OrdinaryRecord[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const scenarioStateHash = turn['scenarioStateHash'];
    if (typeof scenarioStateHash !== 'string') fail('turn record carries no scenario state hash');
    // Test membership is checked BEFORE the ordinary lookup: a malformed
    // supplied schedule sharing one hash between test and ordinary must
    // still reject the test turn, never classify it as fit (v1.1 C3a).
    if (testHashes.has(scenarioStateHash)) fail(`turn served within-support-test scenario ${scenarioStateHash}; test episodes are never ordinary`);
    const scheduled = home.get(scenarioStateHash);
    if (scheduled === undefined) {
      fail(`turn served scenario ${scenarioStateHash} outside the training/validation schedule`);
    }
    if (seen.has(scheduled.caseId)) fail(`parent bundle serves case ${scheduled.caseId} twice`);
    seen.add(scheduled.caseId);
    const turnNumber = turn['turn'];
    if (typeof turnNumber !== 'number') fail('turn record carries no turn number');
    const stream = scheduled.receiverRole === 'baby-a' ? ledgerA : ledgerB;
    const intentions = stream.filter((event) => event.eventType === 'intention.recorded' && event.turn === turnNumber);
    if (intentions.length !== 1) {
      fail(`case ${scheduled.caseId} has ${intentions.length} intention records, expected exactly one`);
    }
    const content = intentions[0]!.content as Record<string, unknown>;
    const symbols = content['symbols'];
    if (!Array.isArray(symbols)) fail(`case ${scheduled.caseId} intention record carries no symbol delivery`);
    const deliveredToken = (symbols[0] ?? null) as string | null;
    if (deliveredToken !== null && typeof deliveredToken !== 'string') {
      fail(`case ${scheduled.caseId} intention delivery is malformed`);
    }
    if (deliveredToken !== null && !input.inventory.includes(deliveredToken)) {
      fail(`case ${scheduled.caseId} uses a token outside the frozen inventory`);
    }
    const selection = content['selection'];
    if (typeof selection !== 'string' || selection.length === 0) {
      fail(`case ${scheduled.caseId} intention record carries no selection`);
    }
    const outcome = turn['outcome'] as Record<string, unknown> | undefined;
    const outcomeSelection = (outcome?.['details'] as Record<string, unknown> | undefined)?.['selectedRef'];
    if (outcomeSelection !== selection) fail(`case ${scheduled.caseId} turn outcome disagrees with the intention selection`);
    const codes = scheduled.candidateTypeCodes;
    if (codes.length !== 4 || new Set(codes).size !== 4 || codes.some((type) => !Number.isInteger(type) || type < 0 || type >= 16)) {
      fail(`case ${scheduled.caseId} scheduled candidate types are invalid`);
    }
    const actualSelectedCandidateIndex = scheduled.candidateRefs.indexOf(selection);
    if (actualSelectedCandidateIndex < 0) fail(`case ${scheduled.caseId} agreed selection is absent from the scheduled candidates`);
    records.push({
      caseId: scheduled.caseId,
      receiverRole: scheduled.receiverRole,
      deliveredToken,
      candidateTypeCodes: [...codes],
      actualSelectedCandidateIndex,
    });
  }
  return records;
}
