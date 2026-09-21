import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  LV01_PARAMETER_COUNT,
  replayLv01RecurrentReceiver,
} from '../src/ledger-value-prediction.js';
import { RecurrentCommunicationModel } from '../src/recurrent-model.js';

const inventory = fixedTokenInventory(32);
const candidates = [1, 4, 9, 14];

function lv01Model(): unknown {
  const model = new RecurrentCommunicationModel('lv01-replay-fixture', {
    typeCount: 16,
    symbolCount: 32,
    messageLength: 1,
    hiddenSize: 16,
  });
  model.updatePredictive([{ featureCode: 1, messageSymbolIndices: [2] }]);
  return model.export();
}

describe('LV01 exact recurrent replay', () => {
  it('restores and scores the real 4,049-parameter receiver without mutation', () => {
    const model = lv01Model();
    const before = JSON.stringify(model);
    const prediction = replayLv01RecurrentReceiver(
      model,
      inventory[2] as string,
      inventory,
      candidates,
    );

    expect(prediction.parameterCount).toBe(LV01_PARAMETER_COUNT);
    expect(prediction.candidateTypeCodes).toEqual(candidates);
    expect(prediction.distribution).toHaveLength(4);
    expect(prediction.distribution.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(prediction.selectedCandidateIndex).toBeGreaterThanOrEqual(0);
    expect(prediction.selectedCandidateIndex).toBeLessThan(4);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('is deterministic for the same frozen policy and does not use target labels', () => {
    const model = lv01Model();
    const first = replayLv01RecurrentReceiver(
      model,
      inventory[3] as string,
      inventory,
      candidates,
    );
    const second = replayLv01RecurrentReceiver(
      model,
      inventory[3] as string,
      inventory,
      candidates,
    );
    expect(second).toEqual(first);
  });

  it('rejects a different architecture, malformed inventory, and invalid candidate order', () => {
    const model = lv01Model() as { options: Record<string, unknown> };
    const wrongArchitecture = structuredClone(model);
    wrongArchitecture.options.hiddenSize = 15;
    expect(() =>
      replayLv01RecurrentReceiver(wrongArchitecture, inventory[0] as string, inventory, candidates),
    ).toThrow(/frozen LV01 architecture/u);
    expect(() =>
      replayLv01RecurrentReceiver(model, 'S99', inventory, candidates),
    ).toThrow(/absent/u);
    expect(() =>
      replayLv01RecurrentReceiver(model, inventory[0] as string, inventory, [1, 1, 4, 9]),
    ).toThrow(/distinct/u);
  });
});
