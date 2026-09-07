import { describe, expect, it } from 'vitest';

import {
  attributesFromTypeCode,
  typeCodeCount,
  typeCodeFromAttributes,
} from '../src/game.js';
import {
  argmaxIndex,
  parseObservationPayload,
  resolveGameShape,
  roundTo,
  softmax,
} from '../src/game.js';
import { LearnerConfigurationError, LearnerStateError } from '../src/errors.js';

describe('type-code arithmetic', () => {
  it('encodes attribute vectors positionally', () => {
    expect(typeCodeFromAttributes([0, 0], 4)).toBe(0);
    expect(typeCodeFromAttributes([0, 3], 4)).toBe(3);
    expect(typeCodeFromAttributes([2, 1], 4)).toBe(9);
    expect(typeCodeFromAttributes([3, 3], 4)).toBe(15);
  });

  it('round-trips every type code for several attribute spaces', () => {
    for (const attributeCount of [1, 2, 3]) {
      for (const valuesPerAttribute of [2, 3, 4, 5]) {
        const total = typeCodeCount(attributeCount, valuesPerAttribute);
        for (let code = 0; code < total; code += 1) {
          const attributes = attributesFromTypeCode(
            code,
            attributeCount,
            valuesPerAttribute,
          );
          expect(attributes).toHaveLength(attributeCount);
          expect(typeCodeFromAttributes(attributes, valuesPerAttribute)).toBe(code);
        }
      }
    }
  });

  it('rejects attribute codes outside the value range', () => {
    expect(() => typeCodeFromAttributes([4, 0], 4)).toThrow(LearnerStateError);
    expect(() => attributesFromTypeCode(16, 2, 4)).toThrow(
      LearnerConfigurationError,
    );
  });
});

describe('observation parsing', () => {
  it('reads a sender view from the trailing target column', () => {
    const parsed = parseObservationPayload(
      [
        [0, 1, 0],
        [2, 3, 1],
        [1, 1, 0],
      ],
      2,
      4,
    );
    expect(parsed.view).toBe('sender');
    expect(parsed.targetIndex).toBe(1);
    expect(parsed.typeCodes).toEqual([1, 11, 5]);
  });

  it('reads a receiver view with no target column', () => {
    const parsed = parseObservationPayload(
      [
        [0, 1],
        [2, 3],
      ],
      2,
      4,
    );
    expect(parsed.view).toBe('receiver');
    expect(parsed.targetIndex).toBeNull();
    expect(parsed.typeCodes).toEqual([1, 11]);
  });

  it('rejects an unexpected row width, ragged rows, and two targets', () => {
    expect(() => parseObservationPayload([[0, 1, 2, 3]], 2, 4)).toThrow(
      LearnerStateError,
    );
    expect(() =>
      parseObservationPayload(
        [
          [0, 1],
          [0],
        ],
        2,
        4,
      ),
    ).toThrow(LearnerStateError);
    expect(() =>
      parseObservationPayload(
        [
          [0, 1, 1],
          [2, 3, 1],
        ],
        2,
        4,
      ),
    ).toThrow(LearnerStateError);
    expect(() => parseObservationPayload([], 2, 4)).toThrow(LearnerStateError);
  });
});

describe('numeric helpers', () => {
  it('softmax sums to one and is monotone in the logit', () => {
    const probs = softmax([0, 1, 2], 1);
    expect(probs.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(probs[0]).toBeLessThan(probs[1] as number);
    expect(probs[1]).toBeLessThan(probs[2] as number);
  });

  it('softmax of equal logits is uniform at any temperature', () => {
    for (const temperature of [0.25, 0.5, 1, 4]) {
      expect(softmax([0, 0, 0, 0], temperature)).toEqual([0.25, 0.25, 0.25, 0.25]);
    }
  });

  it('softmax is numerically stable for extreme logits', () => {
    const probs = softmax([1000, 0, -1000], 1);
    expect(probs[0]).toBeCloseTo(1, 12);
    expect(Number.isNaN(probs[2] as number)).toBe(false);
  });

  it('softmax rejects a non-positive temperature', () => {
    expect(() => softmax([0, 1], 0)).toThrow(LearnerConfigurationError);
  });

  it('argmax returns the lowest index on a tie', () => {
    expect(argmaxIndex([1, 3, 3, 2])).toBe(1);
    expect(argmaxIndex([])).toBe(-1);
  });

  it('rounds negative zero to zero so canonical JSON is stable', () => {
    expect(Object.is(roundTo(-1e-15, 12), 0)).toBe(true);
  });
});

describe('game shape resolution', () => {
  it('defaults to the E11 naming stage', () => {
    expect(resolveGameShape({}, undefined)).toEqual({
      valuesPerAttribute: 4,
      attributeCount: 2,
      messageLength: 1,
      typeCount: 16,
    });
  });

  it('rejects a message longer than the protocol limit', () => {
    expect(() => resolveGameShape({ messageLength: 3 }, 2)).toThrow(
      LearnerConfigurationError,
    );
  });

  it('rejects non-integer shapes', () => {
    expect(() => resolveGameShape({ attributeCount: 0 }, undefined)).toThrow(
      LearnerConfigurationError,
    );
  });
});
