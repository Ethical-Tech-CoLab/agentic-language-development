import { describe, expect, it } from 'vitest';

import {
  RECURRENT_ARCHITECTURE,
  RECURRENT_RL_OBJECTIVE,
  RECURRENT_SELF_SUPERVISED_OBJECTIVE,
  RecurrentCommunicationModel,
} from '../src/recurrent-model.js';

const options = {
  typeCount: 4,
  symbolCount: 3,
  messageLength: 1,
  hiddenSize: 5,
  learningRate: 0.01,
  ppoEpochs: 4,
};

function probability(
  model: RecurrentCommunicationModel,
  feature: number,
  symbol: number,
): number {
  return model.predictSymbols(feature)[0]?.[symbol] ?? 0;
}

describe('RecurrentCommunicationModel scientific backbone (ALD-045, ALD-046)', () => {
  it('locks the architecture, parameter count, memory budget, and independent initialization', () => {
    const first = new RecurrentCommunicationModel('baby-a-seed', options);
    const replay = new RecurrentCommunicationModel('baby-a-seed', options);
    const independent = new RecurrentCommunicationModel('baby-b-seed', options);

    expect(first.parameterCount).toBe(273);
    expect(first.memoryBytes()).toBe((273 * 3 + 5 * 4) * 8);
    expect(first.export()).toEqual(replay.export());
    expect(first.export().parameters).not.toEqual(independent.export().parameters);
    expect(first.export()).toMatchObject({
      architecture: RECURRENT_ARCHITECTURE,
      rlObjective: RECURRENT_RL_OBJECTIVE,
      selfSupervisedObjective: RECURRENT_SELF_SUPERVISED_OBJECTIVE,
      optimizer: { name: 'adam-v1', step: 0 },
    });

    const independentBefore = independent.export();
    first.updatePredictive([{ featureCode: 0, messageSymbolIndices: [0] }]);
    expect(independent.export()).toEqual(independentBefore);
    expect(first.export().optimizer.step).toBeGreaterThan(0);
    expect(independent.export().optimizer.step).toBe(0);
  });

  it('matches a central-difference gradient on the predictive objective', () => {
    const model = new RecurrentCommunicationModel('gradient-seed', options);
    const check = model.checkPredictiveGradient(2, [1]);

    expect(Math.abs(check.analytic)).toBeGreaterThan(1e-6);
    expect(check.relativeError).toBeLessThan(1e-6);
  });

  it('performs a clipped PPO-style reward-to-parameter update', () => {
    const model = new RecurrentCommunicationModel('rl-seed', options);
    const before = probability(model, 0, 0);
    let observedDelta = 0;
    let clippedEpochs = 0;

    for (let turn = 1; turn <= 40; turn += 1) {
      model.sender(turn, 0);
      model.recordActions(turn, [0]);
      model.recordReward(turn, 1);
      const result = model.updateReinforcement([turn]);
      expect(result.objective).toBe(RECURRENT_RL_OBJECTIVE);
      expect(result.gradientNorm).toBeLessThanOrEqual(1 + 1e-12);
      observedDelta += result.parameterDeltaL2;
      clippedEpochs += result.clippedEpochs;
    }

    expect(observedDelta).toBeGreaterThan(0);
    expect(clippedEpochs).toBeGreaterThanOrEqual(0);
    expect(probability(model, 0, 0)).toBeGreaterThan(before);
    expect(model.export().updateCount).toBe(40);
  });

  it('learns a toy reward-free feature-to-message mapping', () => {
    const model = new RecurrentCommunicationModel('predictive-seed', options);
    const before = (probability(model, 0, 0) + probability(model, 1, 1)) / 2;
    let changed = 0;

    for (let step = 0; step < 120; step += 1) {
      const result = model.updatePredictive([
        { featureCode: 0, messageSymbolIndices: [0] },
        { featureCode: 1, messageSymbolIndices: [1] },
      ]);
      expect(result.objective).toBe(RECURRENT_SELF_SUPERVISED_OBJECTIVE);
      changed += result.parameterDeltaL2;
    }

    model.resetLiveHiddenToCheckpoint();
    const after = (probability(model, 0, 0) + probability(model, 1, 1)) / 2;
    expect(changed).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before + 0.15);
    expect(after).toBeGreaterThan(0.48);
  });

  it('round-trips optimizer/checkpoint state and freezes exports during evaluation', () => {
    const original = new RecurrentCommunicationModel('restore-seed', options);
    original.updatePredictive([{ featureCode: 3, messageSymbolIndices: [2] }]);
    const checkpoint = original.export();
    const restored = new RecurrentCommunicationModel('different-seed', options);
    restored.restore(checkpoint);

    expect(restored.export()).toEqual(checkpoint);
    expect(restored.predictSymbols(3)).toEqual(original.predictSymbols(3));

    const frozen = JSON.stringify(restored.export());
    restored.sender(10, 2);
    restored.receiver(11, [1], [0, 1, 2, 3]);
    expect(JSON.stringify(restored.export())).toBe(frozen);
  });

  it('does not update without a recorded local action and reward', () => {
    const model = new RecurrentCommunicationModel('negative-control', options);
    const before = model.export();
    model.sender(1, 0);
    const result = model.updateReinforcement([1]);

    expect(result.trajectories).toBe(0);
    expect(result.parameterDeltaL2).toBe(0);
    expect(model.export()).toEqual(before);
  });
});
