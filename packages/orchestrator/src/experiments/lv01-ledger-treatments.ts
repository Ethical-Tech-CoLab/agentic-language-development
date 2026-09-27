/**
 * LV01 ledger-intervention batches (R04 item 2).
 *
 * The collector prepares one batch per role across all final-test cases
 * *before* test receiver actions: the native predictor's target-maximizing
 * token per case (ledger-consistent delivery), plus a fixed seeded
 * derangement of those selections within the role (ledger-shuffled
 * delivery). The gateway substitutes only committed batch tokens; identical
 * selected tokens delivered through a deranged index are preserved
 * coincidences, never re-drawn.
 */
import { hashCanonical, SeededPrng } from '@ald/hashing';
import {
  selectLedgerConsistentToken,
  type Lv01NativeLedgerIndex,
} from '@ald/learners';

import type { Lv01Branch } from './ledger-value.js';

export const LV01_LEDGER_TREATMENT_BATCH_DOMAIN =
  'lv01-ledger-treatment-batch/v1' as const;

function fail(message: string): never {
  throw new Error(`LV01 ledger treatment: ${message}`);
}

export interface Lv01TreatmentCase {
  readonly caseId: string;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly targetTypeCode: number;
  readonly candidateTypeCodes: readonly number[];
}

export interface Lv01TreatedCase {
  readonly caseId: string;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly targetTypeCode: number;
  readonly candidateTypeCodes: readonly number[];
  readonly selectedToken: string;
  readonly shuffledSourceCaseId: string;
  readonly shuffledDeliveredToken: string;
  /** True when the deranged source selected the same token: preserved, not re-drawn. */
  readonly identicalTokenCoincidence: boolean;
}

export interface Lv01LedgerTreatmentBatch {
  readonly version: 1;
  readonly derangementSeed: string;
  readonly cases: readonly Lv01TreatedCase[];
  readonly batchCommitment: string;
}

const isDerangement = (permutation: readonly number[]): boolean =>
  permutation.every((value, index) => value !== index);

function shuffle<T>(items: readonly T[], prng: SeededPrng): T[] {
  const array = [...items];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swap = prng.nextInt(index + 1);
    const held = array[index] as T;
    array[index] = array[swap] as T;
    array[swap] = held;
  }
  return array;
}

/**
 * Fixed seeded derangement of role-batch indices. Retries on derived seeds
 * until no case keeps its own selection; fails closed when no derangement
 * exists (fewer than two cases) or the attempt budget exhausts.
 */
export function ledgerShuffledDerangement(
  batchSize: number,
  seed: string,
): readonly number[] {
  if (!Number.isInteger(batchSize) || batchSize < 2) {
    fail('ledger-shuffled requires at least two cases per role');
  }
  const order = Array.from({ length: batchSize }, (_, index) => index);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const permutation = shuffle(
      order,
      new SeededPrng(seed).derive('lv01-ledger-shuffled/v1').derive(String(attempt)),
    );
    if (isDerangement(permutation)) return permutation;
  }
  fail('ledger-shuffled derangement search exhausted its attempt budget');
}

export function buildLedgerTreatmentBatch(input: {
  readonly cases: readonly Lv01TreatmentCase[];
  readonly nativeIndex: Lv01NativeLedgerIndex;
  readonly symbolInventory: readonly string[];
  readonly derangementSeed: string;
}): Lv01LedgerTreatmentBatch {
  if (input.cases.length === 0) fail('treatment batch requires at least one case');
  const caseIds = input.cases.map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) fail('treatment case identities collide');
  const treated: Array<{
    caseId: string;
    receiverRole: 'baby-a' | 'baby-b';
    targetTypeCode: number;
    candidateTypeCodes: number[];
    selectedToken: string;
    shuffledSourceCaseId: string;
    shuffledDeliveredToken: string;
    identicalTokenCoincidence: boolean;
  }> = input.cases.map((entry) => ({
    caseId: entry.caseId,
    receiverRole: entry.receiverRole,
    targetTypeCode: entry.targetTypeCode,
    candidateTypeCodes: [...entry.candidateTypeCodes],
    selectedToken: selectLedgerConsistentToken(
      input.nativeIndex,
      entry.targetTypeCode,
      entry.candidateTypeCodes,
      input.symbolInventory,
    ),
    shuffledSourceCaseId: entry.caseId,
    shuffledDeliveredToken: '',
    identicalTokenCoincidence: false,
  }));
  for (const role of ['baby-a', 'baby-b'] as const) {
    const roleCases = treated.filter((entry) => entry.receiverRole === role);
    if (roleCases.length === 0) continue;
    const permutation = ledgerShuffledDerangement(
      roleCases.length,
      `${input.derangementSeed}${role}`,
    );
    roleCases.forEach((entry, position) => {
      const source = roleCases[permutation[position] as number] as Lv01TreatedCase;
      entry.shuffledSourceCaseId = source.caseId;
      entry.shuffledDeliveredToken = source.selectedToken;
      entry.identicalTokenCoincidence = source.selectedToken === entry.selectedToken;
    });
  }
  const batch: Lv01LedgerTreatmentBatch = {
    version: 1,
    derangementSeed: input.derangementSeed,
    cases: treated,
    batchCommitment: hashCanonical(LV01_LEDGER_TREATMENT_BATCH_DOMAIN, {
      derangementSeed: input.derangementSeed,
      cases: treated,
    }),
  };
  return batch;
}

export interface Lv01TreatmentSlice {
  readonly selectedToken: string;
  readonly deliveredToken: string;
  readonly batchCommitment: string;
  readonly sourceCaseId: string;
}

/** The committed per-run slice: consistent delivers the selection, shuffled the deranged source. */
export function sliceLedgerTreatment(
  batch: Lv01LedgerTreatmentBatch,
  caseId: string,
  branch: Lv01Branch,
): Lv01TreatmentSlice {
  const treated = batch.cases.find((entry) => entry.caseId === caseId);
  if (treated === undefined) fail(`treatment batch has no case ${caseId}`);
  if (branch === 'ledger-consistent') {
    return {
      selectedToken: treated.selectedToken,
      deliveredToken: treated.selectedToken,
      batchCommitment: batch.batchCommitment,
      sourceCaseId: treated.caseId,
    };
  }
  if (branch === 'ledger-shuffled') {
    return {
      selectedToken: treated.selectedToken,
      deliveredToken: treated.shuffledDeliveredToken,
      batchCommitment: batch.batchCommitment,
      sourceCaseId: treated.shuffledSourceCaseId,
    };
  }
  fail(`branch ${branch} carries no ledger treatment`);
}

/** Re-derive the slice from the sealed batch; rejects any substituted token. */
export function verifyLedgerTreatmentSlice(
  batch: Lv01LedgerTreatmentBatch,
  caseId: string,
  branch: Lv01Branch,
  slice: Lv01TreatmentSlice,
): void {
  const expected = sliceLedgerTreatment(batch, caseId, branch);
  if (
    expected.selectedToken !== slice.selectedToken ||
    expected.deliveredToken !== slice.deliveredToken ||
    expected.batchCommitment !== slice.batchCommitment ||
    expected.sourceCaseId !== slice.sourceCaseId
  ) {
    fail('ledger treatment slice does not match the sealed batch');
  }
  const recomputed = hashCanonical(LV01_LEDGER_TREATMENT_BATCH_DOMAIN, {
    derangementSeed: batch.derangementSeed,
    cases: batch.cases,
  });
  if (recomputed !== batch.batchCommitment) {
    fail('ledger treatment batch commitment does not match its cases');
  }
}

/**
 * Batch targets must equal the served case targets: a treatment batch built
 * for other targets delivers consistently-selected but wrong-case tokens.
 */
export function verifyLv01TreatmentTargets(
  batch: Lv01LedgerTreatmentBatch,
  served: readonly { readonly caseId: string; readonly targetTypeCode: number }[],
): void {
  for (const entry of batch.cases) {
    const observed = served.find((item) => item.caseId === entry.caseId)?.targetTypeCode;
    if (observed === undefined) fail(`treatment batch case ${entry.caseId} was never served`);
    if (observed !== entry.targetTypeCode) fail(`treatment batch case ${entry.caseId} targets the wrong case`);
  }
}
