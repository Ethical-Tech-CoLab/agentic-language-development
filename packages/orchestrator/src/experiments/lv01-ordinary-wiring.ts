/**
 * LV01 collection-time ordinary-record wiring (G3 slice).
 *
 * The collector takes its ordinary provider as an explicit input and invents
 * none of it. This module builds that input from a real validation-window
 * selection plus a receipt binding the folds, so a fitted (non-uniform)
 * provider flows end to end. Records still arrive as inputs: deriving them
 * from raw parent evidence is the queued loader remainder.
 */
import {
  selectLv01OrdinaryPredictor,
  type Lv01OrdinaryPredictorId,
  type Lv01OrdinaryRecord,
} from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';

import type { Lv01PairedPredictionProvider } from './lv01-paired-predictions.js';
import type { Lv01Schedule } from './lv01-schedule.js';

export const LV01_ORDINARY_WIRING_FOLDS_DOMAIN = 'lv01-ordinary-wiring-folds/v1' as const;

export interface Lv01OrdinaryWiringReceipt {
  readonly selectedPredictorId: Lv01OrdinaryPredictorId;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly validationBrierByPredictor: Readonly<Record<Lv01OrdinaryPredictorId, number>>;
  readonly foldsDigest: string;
  readonly trainingCases: number;
  readonly validationFitCases: number;
  readonly validationSelectionCases: number;
}

/**
 * Assign caller-supplied ordinary rows to training/validation folds by
 * schedule case membership. Within-support test cases are rejected outright:
 * test rows never enter ordinary folds. Row EXTRACTION from raw evidence
 * (delivered token, candidates, action per case) is a separate
 * methods-defined mapping and stays out of this pure partitioner.
 */
export function partitionLv01OrdinaryRowsBySchedule(
  rows: readonly Lv01OrdinaryRecord[],
  schedule: Lv01Schedule,
): {
  readonly training: readonly Lv01OrdinaryRecord[];
  readonly validationFit: readonly Lv01OrdinaryRecord[];
  readonly validationSelection: readonly Lv01OrdinaryRecord[];
} {
  const home = new Map<string, 'training' | 'validationFit' | 'validationSelection'>();
  const claim = (
    entries: readonly { readonly caseId: string }[],
    fold: 'training' | 'validationFit' | 'validationSelection',
  ): void => {
    for (const entry of entries) {
      if (home.has(entry.caseId)) {
        throw new Error(`LV01 ordinary folds: schedule lists case ${entry.caseId} twice`);
      }
      home.set(entry.caseId, fold);
    }
  };
  claim(schedule.cases.training, 'training');
  claim(schedule.cases['validation-fit'], 'validationFit');
  claim(schedule.cases['validation-selection'], 'validationSelection');
  const folds: {
    training: Lv01OrdinaryRecord[];
    validationFit: Lv01OrdinaryRecord[];
    validationSelection: Lv01OrdinaryRecord[];
  } = { training: [], validationFit: [], validationSelection: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.caseId)) {
      throw new Error(`LV01 ordinary folds: rows list case ${row.caseId} twice`);
    }
    seen.add(row.caseId);
    const fold = home.get(row.caseId);
    if (fold === undefined) {
      throw new Error(`LV01 ordinary folds: row case ${row.caseId} is outside the training/validation schedule`);
    }
    folds[fold].push(row);
  }
  return folds;
}

export function wireLv01CollectionOrdinary(input: {
  readonly inventory: readonly string[];
  readonly training: readonly Lv01OrdinaryRecord[];
  readonly validationFit: readonly Lv01OrdinaryRecord[];
  readonly validationSelection: readonly Lv01OrdinaryRecord[];
}): { readonly provider: Lv01PairedPredictionProvider; readonly receipt: Lv01OrdinaryWiringReceipt } {
  const selection = selectLv01OrdinaryPredictor({
    inventory: input.inventory,
    training: input.training,
    validationFit: input.validationFit,
    validationSelection: input.validationSelection,
  });
  const ids = (rows: readonly Lv01OrdinaryRecord[]): readonly string[] => rows.map((row) => row.caseId).sort();
  return {
    provider: { ordinaryId: selection.selectedPredictorId, ordinaryFit: selection.refitPredictor.fit },
    receipt: {
      selectedPredictorId: selection.selectedPredictorId,
      receiverRole: selection.refitPredictor.receiverRole,
      validationBrierByPredictor: selection.validationBrierByPredictor,
      foldsDigest: hashCanonical(LV01_ORDINARY_WIRING_FOLDS_DOMAIN, {
        training: ids(input.training),
        validationFit: ids(input.validationFit),
        validationSelection: ids(input.validationSelection),
      }),
      trainingCases: input.training.length,
      validationFitCases: input.validationFit.length,
      validationSelectionCases: input.validationSelection.length,
    },
  };
}
