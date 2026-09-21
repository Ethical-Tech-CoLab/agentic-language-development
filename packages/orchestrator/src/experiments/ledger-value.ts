/** LV01 fail-closed paired-case collection and immutable slot accounting. */
import { hashCanonical } from '@ald/hashing';

export const LV01_BRANCHES = ['normal', 'disabled', 'constant', 'random', 'shuffled', 'ledger-consistent', 'ledger-shuffled'] as const;
export type Lv01Branch = (typeof LV01_BRANCHES)[number];
export type Lv01Stage = 'development' | 'qualification' | 'pilot' | 'confirmatory' | 'replication';
export type Lv01SlotStatus = 'unattempted' | 'running' | 'valid' | 'invalid' | 'aborted';
export interface Lv01Slot { readonly index: number; readonly kind: 'primary' | 'reserve'; readonly status: Lv01SlotStatus; readonly reason?: string; }
export interface Lv01StageJournal { readonly stage: Lv01Stage; readonly version: number; readonly attemptId: string; readonly slots: readonly Lv01Slot[]; readonly terminal: 'open' | 'completed' | 'failed' | 'aborted'; }
export interface Lv01AdmissionInput { readonly designVerified: boolean; readonly numericalQualificationVerified: boolean; readonly topologyQualificationVerified: boolean; readonly sourceClean: boolean; readonly registrationBound: boolean; readonly resourcesSufficient: boolean; readonly stage: Lv01Stage; }
export interface Lv01Admission { readonly status: 'ready' | 'blocked' | 'unresolved'; readonly reasons: readonly string[]; }
export interface Lv01PairedBranchEvidence { readonly branch: Lv01Branch; readonly scenarioHash: string; readonly receiverDrawCommitment: string; readonly preStateCommitment: string; readonly predictionCommitment: string; readonly actionRecordedAfterPrediction: boolean; readonly restoredBeforeAction: boolean; }

function fail(message: string): never { throw new Error(`LV01 collector: ${message}`); }
export function createLv01StageJournal(stage: Lv01Stage, version: number, primarySlots: number, reserveSlots = 0): Lv01StageJournal {
  if (!Number.isInteger(version) || version < 1 || !Number.isInteger(primarySlots) || primarySlots < 1 || !Number.isInteger(reserveSlots) || reserveSlots < 0) fail('stage journal dimensions are invalid');
  const slots: Lv01Slot[] = [
    ...[...Array(primarySlots)].map((_, index) => ({ index: index + 1, kind: 'primary' as const, status: 'unattempted' as const })),
    ...[...Array(reserveSlots)].map((_, index) => ({ index: primarySlots + index + 1, kind: 'reserve' as const, status: 'unattempted' as const })),
  ];
  return { stage, version, attemptId: `lv01-${stage}-v${version}`, slots, terminal: 'open' };
}
export function transitionLv01Slot(journal: Lv01StageJournal, index: number, status: Exclude<Lv01SlotStatus, 'unattempted'>, reason?: string): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('terminal journal cannot change');
  const slot = journal.slots.find((entry) => entry.index === index); if (!slot) fail('unknown slot');
  if (status === 'running') { if (slot.status !== 'unattempted') fail('a slot cannot be started twice'); }
  else if (slot.status !== 'running') fail('only a running slot can become terminal');
  if ((status === 'invalid' || status === 'aborted') && (!reason || reason.length === 0)) fail('invalid or aborted slot requires a reason');
  return { ...journal, slots: journal.slots.map((entry) => entry.index === index ? { ...entry, status, ...(reason ? { reason } : {}) } : entry) };
}
export function finalizeLv01Stage(journal: Lv01StageJournal): Lv01StageJournal {
  if (journal.terminal !== 'open') fail('stage journal is already terminal');
  if (journal.slots.some((slot) => slot.status === 'running')) fail('running slots prevent terminal accounting');
  const primary = journal.slots.filter((slot) => slot.kind === 'primary');
  const terminal = primary.every((slot) => slot.status === 'valid') ? 'completed' : primary.some((slot) => slot.status === 'aborted') ? 'aborted' : 'failed';
  return { ...journal, terminal };
}
export function assessLv01Admission(input: Lv01AdmissionInput): Lv01Admission {
  const reasons: string[] = [];
  if (!input.designVerified) reasons.push('design-not-verified');
  if (!input.numericalQualificationVerified) reasons.push('numerical-qualification-missing');
  if (!input.topologyQualificationVerified) reasons.push('topology-qualification-missing');
  if (!input.sourceClean) reasons.push('source-not-clean');
  if (!input.registrationBound && input.stage !== 'development' && input.stage !== 'qualification') reasons.push('registration-binding-missing');
  if (!input.resourcesSufficient) reasons.push('resource-allocation-missing');
  return { status: reasons.length === 0 ? 'ready' : 'blocked', reasons };
}
/** Verify the complete pre-action paired case before it can enter analysis. */
export function verifyLv01PairedCase(evidence: readonly Lv01PairedBranchEvidence[]): { caseCommitment: string } {
  if (evidence.length !== LV01_BRANCHES.length || evidence.some((entry, index) => entry.branch !== LV01_BRANCHES[index])) fail('all seven ordered branches are required');
  const first = evidence[0]; if (!first) fail('paired evidence is empty');
  for (const entry of evidence) {
    if (entry.scenarioHash !== first.scenarioHash || entry.receiverDrawCommitment !== first.receiverDrawCommitment || entry.preStateCommitment !== first.preStateCommitment) fail('paired branches do not share scenario, receiver draw, and pre-state');
    if (!entry.actionRecordedAfterPrediction || !entry.restoredBeforeAction || entry.predictionCommitment.length === 0) fail('branch violates prediction chronology or restore requirement');
  }
  return { caseCommitment: hashCanonical('lv01-paired-case/v1', evidence) };
}
