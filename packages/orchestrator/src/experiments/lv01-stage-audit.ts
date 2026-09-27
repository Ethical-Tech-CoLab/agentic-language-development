/**
 * LV01 stage-collection audit engine (R05.2b).
 *
 * Pure: a verified journal plus per-case audit results in, an immutable
 * receipt out. Every valid slot needs exactly one audited case and vice
 * versa; every invalid or aborted slot carries its invalidity reason;
 * consumed reserves form an ordered prefix of the registered reserve pool
 * (the registered invalidity rule allows no other replacement); an open
 * journal audits as blocked, never verified. Evidence contradictions throw
 * and produce no receipt.
 */
import {
  Lv01AuditReceiptSchema,
  type Lv01AuditReceipt,
  type Lv01StagePacket,
} from '@ald/types';

import {
  type Lv01StageJournal,
  type Lv01Stage,
} from './ledger-value.js';
import { verifyLv01JournalEvents } from './ledger-value-journal.js';

function fail(message: string): never {
  throw new Error(`LV01 stage audit: ${message}`);
}

export interface Lv01StageCaseAudit {
  readonly slot: number;
  readonly caseCommitment: string;
}

export function auditLv01StageCollection(input: {
  readonly packet: Lv01StagePacket;
  readonly journalEvents: readonly unknown[];
  readonly cases: readonly Lv01StageCaseAudit[];
}): Lv01AuditReceipt {
  const events = verifyLv01JournalEvents(input.journalEvents);
  const journal: Lv01StageJournal = events.at(-1)!.journal;
  if (journal.stage !== input.packet.stage || journal.version !== input.packet.version) {
    fail('journal does not belong to the registered stage');
  }
  const slotByIndex = new Map(journal.slots.map((slot) => [slot.index, slot]));
  if (slotByIndex.size !== journal.slots.length) fail('journal slot indices collide');
  for (const result of input.cases) {
    const slot = slotByIndex.get(result.slot);
    if (slot === undefined) fail(`audited case for unknown slot ${result.slot}`);
    if (slot.status !== 'valid') fail(`audited case for non-valid slot ${result.slot}`);
  }
  const cased = new Set(input.cases.map((result) => result.slot));
  if (cased.size !== input.cases.length) fail('audited cases collide on a slot');
  const reasons: string[] = [];
  for (const slot of journal.slots) {
    if (slot.status === 'running') fail(`slot ${slot.index} is still running`);
    if ((slot.status === 'invalid' || slot.status === 'aborted') && (slot.reason ?? '').length === 0) {
      fail(`slot ${slot.index} has no invalidity reason`);
    }
    if (slot.status === 'valid' && !cased.has(slot.index)) fail(`valid slot ${slot.index} has no audited case`);
  }
  const reserves = journal.slots.filter((slot) => slot.kind === 'reserve');
  const consumed = reserves.filter((slot) => slot.status !== 'unattempted');
  for (let order = 0; order < consumed.length; order += 1) {
    if (consumed[order]!.index !== reserves[order]!.index) fail('consumed reserves skip the registered order');
  }
  if (journal.terminal === 'open') reasons.push('stage journal is not terminal');
  const receipt = {
    schemaVersion: 1 as const,
    studyId: 'LV01' as const,
    stage: journal.stage as Lv01Stage,
    version: journal.version,
    packetCommitment: input.packet.packetCommitment,
    journalHash: events.at(-1)!.journalHash,
    auditedCases: [...input.cases]
      .sort((left, right) => left.slot - right.slot)
      .map((result) => ({ slot: result.slot, kind: slotByIndex.get(result.slot)!.kind, caseCommitment: result.caseCommitment })),
    unusedReserves: reserves.filter((slot) => slot.status === 'unattempted').map((slot) => slot.index),
    status: (reasons.length === 0 ? 'verified' : 'blocked') as 'verified' | 'blocked',
    reasons,
    researchFinding: false as const,
    scientificDisposition: 'not-tested' as const,
    claimBoundary: 'Collection audit over journal, cases, and reserves. No scientific result is implied.',
  };
  const parsed = Lv01AuditReceiptSchema.safeParse(receipt);
  if (!parsed.success) fail(`audit receipt is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data;
}
