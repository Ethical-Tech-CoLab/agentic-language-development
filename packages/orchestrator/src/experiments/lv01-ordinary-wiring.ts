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
