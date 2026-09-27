import { fixedTokenInventory } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  LV01_PARAMETER_COUNT,
  indexLv01TrainingLedger,
  predictLv01NativeLedger,
  replayLv01RecurrentReceiver,
  selectLedgerConsistentToken,
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

function association(
  sequence: number,
  token: string,
  weights: readonly number[],
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    receiverRole: 'baby-a' as const,
    eventType: 'hypothesis.created' as const,
    sequence,
    turn: sequence * 10,
    eventHash: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
    policyContextHash: `sha256:${String(sequence + 1).repeat(64).slice(0, 64)}`,
    authenticated: true,
    token,
    associationOverTypeCodes: weights,
    ...overrides,
  };
}

describe('LV01 training-ledger native predictions', () => {
  const low = Array.from({ length: 16 }, () => 0);
  const early = [...low];
  early[1] = 1;
  const latest = [...low];
  latest[9] = 4;

  it('uses the latest verified pre-cutoff association in sequence order', () => {
    const index = indexLv01TrainingLedger(
      [
        association(5, 'S03', latest),
        association(2, 'S03', early),
        association(4, 'S03', low),
        association(6, 'S03', Array.from({ length: 16 }, () => 1)),
      ],
      'baby-a',
      { sequence: 5, turn: 50 },
    );
    const prediction = predictLv01NativeLedger(index, 'S03', candidates);

    expect(prediction.source).toBe('training-ledger');
    expect(prediction.selectedAssociation).toMatchObject({ sequence: 5, turn: 50 });
    expect(prediction.selectedAssociation?.associationAgeTurns).toBe(0);
    expect(prediction.distribution).toHaveLength(4);
    expect(prediction.distribution[2]).toBeGreaterThan(prediction.distribution[0] as number);
    expect(prediction.distribution.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it('keeps a post-cutoff association inaccessible and supplies recorded uniform priors', () => {
    const before = indexLv01TrainingLedger(
      [association(2, 'S04', early)],
      'baby-a',
      { sequence: 2, turn: 20 },
    );
    const after = indexLv01TrainingLedger(
      [association(2, 'S04', early), association(3, 'S04', latest)],
      'baby-a',
      { sequence: 2, turn: 20 },
    );
    expect(predictLv01NativeLedger(after, 'S04', candidates)).toEqual(
      predictLv01NativeLedger(before, 'S04', candidates),
    );
    expect(predictLv01NativeLedger(before, 'S99', candidates)).toMatchObject({
      source: 'uniform-missing-token', distribution: [0.25, 0.25, 0.25, 0.25],
    });
    expect(predictLv01NativeLedger(before, null, candidates)).toMatchObject({
      source: 'uniform-disabled', distribution: [0.25, 0.25, 0.25, 0.25],
    });
  });

  it('rejects unauthenticated, malformed, and duplicate pre-cutoff associations', () => {
    expect(() => indexLv01TrainingLedger(
      [association(1, 'S01', early, { authenticated: false })],
      'baby-a', { sequence: 1, turn: 10 },
    )).toThrow(/unauthenticated/u);
    expect(() => indexLv01TrainingLedger(
      [association(1, 'S01', [...early.slice(0, 15), Number.NaN])],
      'baby-a', { sequence: 1, turn: 10 },
    )).toThrow(/invalid weights/u);
    expect(() => indexLv01TrainingLedger(
      [association(1, 'S01', early), association(1, 'S02', latest)],
      'baby-a', { sequence: 1, turn: 10 },
    )).toThrow(/duplicate sequence/u);
  });
});

describe('LV01 ledger-consistent token selection', () => {
  const low = Array.from({ length: 16 }, () => 0);
  const weak = [...low];
  weak[1] = 1;
  weak[4] = 8;
  const strong = [...low];
  strong[1] = 9;

  it('selects the inventory token maximizing the native target probability', () => {
    const first = inventory[5] as string;
    const second = inventory[9] as string;
    const index = indexLv01TrainingLedger(
      [association(1, first, weak), association(2, second, strong)],
      'baby-a',
      { sequence: 2, turn: 20 },
    );
    expect(selectLedgerConsistentToken(index, 1, candidates, inventory)).toBe(second);
  });

  it('breaks ties by lowest inventory index', () => {
    const first = inventory[5] as string;
    const second = inventory[9] as string;
    const index = indexLv01TrainingLedger(
      [association(1, first, strong), association(2, second, strong)],
      'baby-a',
      { sequence: 2, turn: 20 },
    );
    expect(selectLedgerConsistentToken(index, 1, candidates, inventory)).toBe(first);
  });

  it('rejects targets outside the candidates', () => {
    const index = indexLv01TrainingLedger(
      [association(1, inventory[0] as string, strong)],
      'baby-a',
      { sequence: 1, turn: 10 },
    );
    expect(() => selectLedgerConsistentToken(index, 2, candidates, inventory))
      .toThrow(/among the candidates/u);
  });
});
