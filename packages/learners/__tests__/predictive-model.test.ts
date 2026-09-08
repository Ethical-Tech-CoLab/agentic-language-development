import { HASH_DOMAINS } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { describe, expect, it } from 'vitest';

import {
  MAX_CODE_BITS,
  SeededSensoryEncoder,
  type FrozenFeatureExtractor,
} from '../src/encoder.js';
import { LearnerConfigurationError, LearnerStateError } from '../src/errors.js';
import { attributesFromTypeCode, typeCodeCount } from '../src/game.js';
import {
  PREDICTION_PROGRESS_REWARD_DEFINITION,
  PREDICTIVE_LOSS_DEFINITION,
  PREDICTIVE_PAIRING_RULE,
  PayloadMeanModel,
  PredictiveCountModel,
  lowestArgmax,
  mixWithUniform,
  normalizeLogs,
  parseExportedPredictiveModel,
} from '../src/predictive-model.js';

/** Attribute rows of the whole 2-attribute / 4-value object space. */
function attributeSpace(): number[][] {
  return Array.from({ length: typeCodeCount(2, 4) }, (_, typeCode) =>
    attributesFromTypeCode(typeCode, 2, 4),
  );
}

function uniformModel(
  overrides: Partial<{
    messageLength: number;
    featureCount: number;
    symbolCount: number;
    smoothing: number;
  }> = {},
): PredictiveCountModel {
  return new PredictiveCountModel({
    messageLength: overrides.messageLength ?? 1,
    featureCount: overrides.featureCount ?? 4,
    symbolCount: overrides.symbolCount ?? 3,
    smoothing: overrides.smoothing ?? 1,
    priorNoise: 0,
    countIncrement: 1,
  });
}

describe('PredictiveCountModel (ALD-046 predictive loss)', () => {
  it('names the pre-registered loss and pairing rule in every export', () => {
    const exported = uniformModel().export();
    expect(exported.lossDefinition).toBe(
      'predictive-cross-entropy:message|candidate-features:v1',
    );
    expect(exported.lossDefinition).toBe(PREDICTIVE_LOSS_DEFINITION);
    expect(exported.pairingRule).toBe(PREDICTIVE_PAIRING_RULE);
    expect(PREDICTION_PROGRESS_REWARD_DEFINITION).toBe(
      'prediction-progress:partner-message-log-likelihood:v1',
    );
  });

  it('starts exactly uniform when priorNoise is zero', () => {
    const model = uniformModel();
    expect(model.symbolProbabilities(0, 2)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(model.candidatePosterior([0, 1, 2, 3], [1])).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
    expect(model.pairs).toBe(0);
  });

  it('starts from a seeded random initialization when priorNoise is positive', () => {
    const left = new PredictiveCountModel({
      messageLength: 1,
      featureCount: 4,
      symbolCount: 3,
      smoothing: 1,
      priorNoise: 0.25,
      countIncrement: 1,
      seed: 'seed-a',
    });
    const right = new PredictiveCountModel({
      messageLength: 1,
      featureCount: 4,
      symbolCount: 3,
      smoothing: 1,
      priorNoise: 0.25,
      countIncrement: 1,
      seed: 'seed-b',
    });
    const again = new PredictiveCountModel({
      messageLength: 1,
      featureCount: 4,
      symbolCount: 3,
      smoothing: 1,
      priorNoise: 0.25,
      countIncrement: 1,
      seed: 'seed-a',
    });
    expect(left.hash()).not.toBe(right.hash());
    expect(left.hash()).toBe(again.hash());
    expect(left.symbolProbabilities(0, 0)).not.toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('refuses a positive priorNoise with no seed to draw it from', () => {
    expect(
      () =>
        new PredictiveCountModel({
          messageLength: 1,
          featureCount: 2,
          symbolCount: 2,
          smoothing: 1,
          priorNoise: 0.5,
          countIncrement: 1,
        }),
    ).toThrow(LearnerConfigurationError);
  });

  it('raises the probability of the pair it folded and nothing else', () => {
    const model = uniformModel();
    const before = model.symbolProbabilities(0, 1);
    model.observe(1, [2]);
    const after = model.symbolProbabilities(0, 1);
    expect(after[2] as number).toBeGreaterThan(before[2] as number);
    expect(after[0] as number).toBeLessThan(before[0] as number);
    expect(model.symbolProbabilities(0, 0)).toEqual(before);
    expect(model.pairs).toBe(1);
  });

  it('scores the candidate whose features predict the message highest', () => {
    const model = uniformModel();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      model.observe(2, [0]);
      model.observe(3, [1]);
    }
    const posterior = model.candidatePosterior([0, 1, 2, 3], [0]);
    expect(lowestArgmax(posterior)).toBe(2);
    expect(lowestArgmax(model.candidatePosterior([0, 1, 2, 3], [1]))).toBe(3);
  });

  it('treats an empty message as no evidence (SPEC §9.6 disabled)', () => {
    const model = uniformModel();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      model.observe(2, [0]);
    }
    expect(model.messageLogProbability(2, [])).toBe(0);
    expect(model.candidatePosterior([0, 1, 2, 3], [])).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
    model.observe(1, []);
    expect(model.pairs).toBe(20);
  });

  it('marginalizes a symbol over the positions it occupied', () => {
    const model = uniformModel({ messageLength: 2, symbolCount: 3 });
    for (let repeat = 0; repeat < 20; repeat += 1) {
      model.observe(1, [0, 2]);
    }
    expect(lowestArgmax(model.featurePosteriorForSymbol(0, [0]))).toBe(1);
    expect(lowestArgmax(model.featurePosteriorForSymbol(2, [1]))).toBe(1);
    // Position 1 saw symbol 2 for feature 1, never symbol 0, so symbol 0 is
    // *less* probable under feature 1 there than under any unvisited feature.
    const atPosition1 = model.featurePosteriorForSymbol(0, [1]);
    expect(lowestArgmax(atPosition1)).not.toBe(1);
    expect(atPosition1[1] as number).toBeLessThan(atPosition1[0] as number);
  });

  it('applies the curriculum learningRate as the count increment', () => {
    const model = uniformModel();
    model.setCountIncrement(4);
    expect(model.countIncrement).toBe(4);
    model.observe(0, [0]);
    expect(model.export().weights[0]?.[0]?.[0]).toBe(4);
    expect(() => model.setCountIncrement(0)).toThrow(LearnerConfigurationError);
  });

  it('rejects a feature code or symbol index outside its tables', () => {
    const model = uniformModel();
    expect(() => model.observe(4, [0])).toThrow(LearnerStateError);
    expect(() => model.observe(0, [3])).toThrow(LearnerStateError);
    expect(() => model.candidatePosterior([], [0])).toThrow(LearnerStateError);
  });

  it('round-trips through export and restore bit-for-bit', () => {
    const model = new PredictiveCountModel({
      messageLength: 2,
      featureCount: 4,
      symbolCount: 3,
      smoothing: 1,
      priorNoise: 0.25,
      countIncrement: 1,
      seed: 'round-trip',
    });
    model.observe(1, [0, 2]);
    model.observe(3, [2, 1]);
    const exported = model.export();

    const restored = new PredictiveCountModel({
      messageLength: 2,
      featureCount: 4,
      symbolCount: 3,
      smoothing: 1,
      priorNoise: 0,
      countIncrement: 1,
    });
    restored.restore(exported);
    expect(restored.hash()).not.toBe(model.hash()); // options differ
    expect(restored.export().weights).toEqual(exported.weights);
    expect(restored.pairs).toBe(2);
    expect(restored.symbolProbabilities(0, 1)).toEqual(
      model.symbolProbabilities(0, 1),
    );
  });

  it('refuses a checkpoint whose shape does not match the run', () => {
    const wide = uniformModel({ symbolCount: 5 }).export();
    expect(() => uniformModel().restore(wide)).toThrow(
      LearnerConfigurationError,
    );
  });

  it('rejects a ragged or negative exported model', () => {
    const exported = uniformModel().export();
    const ragged = {
      ...exported,
      weights: [[[0, 0, 0], [0, 0]]],
    };
    expect(() => parseExportedPredictiveModel(ragged)).toThrow(
      LearnerConfigurationError,
    );
    const negative = structuredClone(exported);
    (negative.weights[0] as number[][])[0] = [-1, 0, 0];
    expect(() => parseExportedPredictiveModel(negative)).toThrow(
      LearnerConfigurationError,
    );
  });

  it('hashes identically across two independently built models', () => {
    expect(uniformModel().hash()).toBe(uniformModel().hash());
    expect(uniformModel().hash()).toBe(
      hashCanonical(HASH_DOMAINS.policyCheckpoint, uniformModel().export()),
    );
  });

  it('never exports a success, reward, or outcome key (ALD-046 cb 3)', () => {
    const model = uniformModel();
    model.observe(1, [0]);
    expect(JSON.stringify(model.export())).not.toMatch(
      /success|reward|outcome/iu,
    );
  });
});

describe('PayloadMeanModel (hybrid world-model payload head)', () => {
  it('predicts the global mean for an unseen key and moves toward observations', () => {
    const model = new PayloadMeanModel(1, 0.5);
    expect(model.predict('k')).toEqual([0]);
    const error = model.update('k', [1]);
    expect(error).toBe(1);
    expect(model.predict('k')).toEqual([0.5]);
    expect(model.predict('unseen')).toEqual([0.5]);
  });

  it('pads and truncates a payload to its declared dimension', () => {
    const model = new PayloadMeanModel(2, 1);
    model.update('k', [1]);
    expect(model.predict('k')).toEqual([1, 0]);
    model.update('j', [1, 1, 9]);
    expect(model.predict('j')).toEqual([1, 1]);
  });

  it('round-trips through export and restore', () => {
    const model = new PayloadMeanModel(1, 0.25);
    model.update('a', [1]);
    model.update('b', [0]);
    const exported = model.export();
    expect(exported.entries.map((entry) => entry.key)).toEqual(['a', 'b']);

    const restored = new PayloadMeanModel(1, 0.25);
    restored.restore(exported);
    expect(restored.export()).toEqual(exported);
    expect(restored.hash()).toBe(model.hash());
  });

  it('refuses a dimension mismatch and an invalid rate', () => {
    const model = new PayloadMeanModel(1, 0.25);
    expect(() => model.restore(new PayloadMeanModel(2, 0.25).export())).toThrow(
      LearnerConfigurationError,
    );
    expect(() => new PayloadMeanModel(1, 2)).toThrow(LearnerConfigurationError);
    expect(() => new PayloadMeanModel(0, 0.5)).toThrow(
      LearnerConfigurationError,
    );
  });
});

describe('distribution helpers', () => {
  it('normalizes log-weights without underflowing on a long message', () => {
    expect(normalizeLogs([])).toEqual([]);
    expect(normalizeLogs([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25]);
    const shifted = normalizeLogs([-5_000, -5_000]);
    expect(shifted).toEqual([0.5, 0.5]);
  });

  it('mixes a distribution with the uniform at the exploration rate', () => {
    expect(mixWithUniform([1, 0], 0)).toEqual([1, 0]);
    expect(mixWithUniform([1, 0], 1)).toEqual([0.5, 0.5]);
    expect(mixWithUniform([1, 0], 0.5)).toEqual([0.75, 0.25]);
    expect(mixWithUniform([], 0.5)).toEqual([]);
    expect(() => mixWithUniform([1, 0], 1.5)).toThrow(
      LearnerConfigurationError,
    );
  });

  it('breaks argmax ties on the lowest index', () => {
    expect(lowestArgmax([])).toBe(-1);
    expect(lowestArgmax([1, 1, 1])).toBe(0);
    expect(lowestArgmax([0, 3, 3])).toBe(1);
  });
});

describe('SeededSensoryEncoder (ALD-047 from-scratch sensory encoder)', () => {
  const options = { seed: 'encoder-seed', rowDimension: 2, inputScale: 4 };

  it('is deterministic for one seed and differs across seeds', () => {
    const left = new SeededSensoryEncoder(options);
    const again = new SeededSensoryEncoder(options);
    const other = new SeededSensoryEncoder({ ...options, seed: 'other-seed' });

    const rows = attributeSpace();
    const leftCodes = rows.map((row) => left.encode(row));
    expect(rows.map((row) => again.encode(row))).toEqual(leftCodes);
    expect(left.hash()).toBe(again.hash());
    expect(other.hash()).not.toBe(left.hash());
    expect(rows.map((row) => other.encode(row))).not.toEqual(leftCodes);
  });

  it('keeps every code inside [0, codeCount) in both modes', () => {
    for (const mode of ['random-projection', 'seeded-hash'] as const) {
      const encoder = new SeededSensoryEncoder({ ...options, mode, codeBits: 4 });
      expect(encoder.codeCount).toBe(16);
      for (const row of attributeSpace()) {
        const code = encoder.encode(row);
        expect(Number.isInteger(code)).toBe(true);
        expect(code).toBeGreaterThanOrEqual(0);
        expect(code).toBeLessThan(encoder.codeCount);
      }
    }
  });

  it('separates most of the object space at the default 5 bits (measurement, not a claim)', () => {
    const rows = attributeSpace();
    const distinct = [1, 2, 3, 4, 5].map((seed) => {
      const encoder = new SeededSensoryEncoder({
        ...options,
        seed: `separation-${String(seed)}`,
      });
      return new Set(rows.map((row) => encoder.encode(row))).size;
    });
    // Recorded as a measurement of the encoder's collision behaviour on the
    // 16-type space: no threshold is pre-registered, so this only pins that the
    // encoder is not degenerate (it does not collapse the space to one code).
    for (const count of distinct) {
      expect(count).toBeGreaterThan(1);
      expect(count).toBeLessThanOrEqual(rows.length);
    }
  });

  it('rejects a row of the wrong width or with a non-finite value', () => {
    const encoder = new SeededSensoryEncoder(options);
    expect(() => encoder.encode([1])).toThrow(LearnerStateError);
    expect(() => encoder.encode([1, Number.NaN])).toThrow(LearnerStateError);
  });

  it('validates codeBits and rowDimension', () => {
    expect(() => new SeededSensoryEncoder({ ...options, codeBits: 0 })).toThrow(
      LearnerConfigurationError,
    );
    expect(
      () =>
        new SeededSensoryEncoder({ ...options, codeBits: MAX_CODE_BITS + 1 }),
    ).toThrow(LearnerConfigurationError);
    expect(
      () => new SeededSensoryEncoder({ ...options, rowDimension: 0 }),
    ).toThrow(LearnerConfigurationError);
  });

  it('puts an injected frozen feature bank in the sensory path and records it', () => {
    const calls: number[][] = [];
    const frozen: FrozenFeatureExtractor = {
      name: 'test-double-visual-features',
      hash: `sha256:${'ab'.repeat(32)}`,
      textAligned: true,
      dimension: 3,
      outputScale: 2,
      project(row) {
        calls.push([...row]);
        return [row[0] ?? 0, row[1] ?? 0, ((row[0] ?? 0) + (row[1] ?? 0)) % 2];
      },
    };
    const encoder = new SeededSensoryEncoder({
      ...options,
      frozenFeatures: frozen,
    });
    expect(encoder.inputDimension).toBe(3);
    expect(encoder.inputScale).toBe(2);
    encoder.encode([1, 2]);
    expect(calls).toEqual([[1, 2]]);
    expect(encoder.frozenFeatures).toEqual({
      name: 'test-double-visual-features',
      hash: `sha256:${'ab'.repeat(32)}`,
      textAligned: true,
      dimension: 3,
      outputScale: 2,
    });
    expect(encoder.export().frozenFeatures?.textAligned).toBe(true);
  });

  it('refuses a frozen bank whose projection has the wrong width', () => {
    const encoder = new SeededSensoryEncoder({
      ...options,
      frozenFeatures: {
        name: 'short-double',
        hash: `sha256:${'cd'.repeat(32)}`,
        textAligned: false,
        dimension: 3,
        outputScale: 2,
        project: () => [1, 2],
      },
    });
    expect(() => encoder.encode([1, 2])).toThrow(LearnerStateError);
  });

  it('refuses a frozen descriptor that is not a sha256 hash', () => {
    expect(
      () =>
        new SeededSensoryEncoder({
          ...options,
          frozenFeatures: {
            name: 'bad-hash',
            hash: 'not-a-hash',
            textAligned: false,
            dimension: 2,
            outputScale: 4,
            project: (row) => [...row],
          },
        }),
    ).toThrow();
  });

  it('round-trips through export and load, in both modes', () => {
    for (const mode of ['random-projection', 'seeded-hash'] as const) {
      const encoder = new SeededSensoryEncoder({ ...options, mode });
      const restored = SeededSensoryEncoder.load(encoder.export());
      expect(restored.hash()).toBe(encoder.hash());
      for (const row of attributeSpace()) {
        expect(restored.encode(row)).toBe(encoder.encode(row));
      }
    }
  });

  it('refuses to load across a frozen-feature mismatch', () => {
    const frozen: FrozenFeatureExtractor = {
      name: 'test-double-visual-features',
      hash: `sha256:${'ab'.repeat(32)}`,
      textAligned: false,
      dimension: 2,
      outputScale: 4,
      project: (row) => [...row],
    };
    const plain = new SeededSensoryEncoder(options).export();
    const withFrozen = new SeededSensoryEncoder({
      ...options,
      frozenFeatures: frozen,
    }).export();

    expect(() => SeededSensoryEncoder.load(plain, frozen)).toThrow(
      LearnerConfigurationError,
    );
    expect(() => SeededSensoryEncoder.load(withFrozen)).toThrow(
      LearnerConfigurationError,
    );
    expect(() =>
      SeededSensoryEncoder.load(withFrozen, { ...frozen, textAligned: true }),
    ).toThrow(LearnerConfigurationError);
  });

  it('never exports the private seed', () => {
    const encoder = new SeededSensoryEncoder(options);
    expect(JSON.stringify(encoder.export())).not.toContain(options.seed);
    expect(encoder.export().seedHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
