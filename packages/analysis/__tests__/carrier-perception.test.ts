import { describe, expect, it } from 'vitest';

import {
  carrierPerceptualDistance,
  evaluatePerceptualGeneralization,
  type BitmapMark,
  type CanvasMark,
  type ToneMark,
} from '../src/index.js';

const bitmap = (ones: readonly number[]): BitmapMark => ({
  carrier: 'generative-bitmap',
  bits: Array.from({ length: 256 }, (_, index) => ones.includes(index) ? 1 : 0),
});
const canvas = (vertical: boolean, offset = 0): CanvasMark => ({
  carrier: 'generative-canvas',
  strokes: [vertical
    ? { startX: 3 + offset, startY: 1, endX: 3 + offset, endY: 14, width: 1 }
    : { startX: 1, startY: 3 + offset, endX: 14, endY: 3 + offset, width: 1 }],
});
const tones = (base: number): ToneMark => ({
  carrier: 'generative-tone',
  tones: [{ pitchBin: base, durationBin: 1 }, { pitchBin: base + 1, durationBin: 2 }],
});

describe('carrier perceptual diagnostics', () => {
  it('uses normalized bitmap Hamming distance', () => {
    expect(carrierPerceptualDistance(bitmap([]), bitmap([]))).toBe(0);
    expect(carrierPerceptualDistance(bitmap([]), bitmap([0]))).toBe(1 / 256);
    expect(carrierPerceptualDistance(bitmap([]), bitmap(Array.from({ length: 256 }, (_, index) => index)))).toBe(1);
  });

  it('rasterizes canvas geometry before comparison', () => {
    expect(carrierPerceptualDistance(canvas(true), canvas(true))).toBe(0);
    expect(carrierPerceptualDistance(canvas(true), canvas(true, 1))).toBeLessThan(
      carrierPerceptualDistance(canvas(true), canvas(false)),
    );
  });

  it('uses graded pitch/duration sequence edit distance for tones', () => {
    expect(carrierPerceptualDistance(tones(1), tones(1))).toBe(0);
    expect(carrierPerceptualDistance(tones(1), tones(2))).toBeGreaterThan(0);
    expect(carrierPerceptualDistance(tones(1), tones(2))).toBeLessThan(1);
  });

  it.each([
    {
      carrier: 'bitmap',
      prototypes: [
        { id: 'a0', family: 'a', mark: bitmap([0, 1, 16, 17]) },
        { id: 'b0', family: 'b', mark: bitmap([238, 239, 254, 255]) },
      ],
      queries: [
        { id: 'a1', family: 'a', mark: bitmap([0, 1, 16]) },
        { id: 'b1', family: 'b', mark: bitmap([239, 254, 255]) },
      ],
    },
    {
      carrier: 'canvas',
      prototypes: [
        { id: 'a0', family: 'a', mark: canvas(true) },
        { id: 'b0', family: 'b', mark: canvas(false) },
      ],
      queries: [
        { id: 'a1', family: 'a', mark: canvas(true, 1) },
        { id: 'b1', family: 'b', mark: canvas(false, 1) },
      ],
    },
    {
      carrier: 'tone',
      prototypes: [
        { id: 'a0', family: 'a', mark: tones(0) },
        { id: 'b0', family: 'b', mark: tones(6) },
      ],
      queries: [
        { id: 'a1', family: 'a', mark: tones(1) },
        { id: 'b1', family: 'b', mark: tones(5) },
      ],
    },
  ])('recognizes novel transformed $carrier family members', ({ prototypes, queries }) => {
    const result = evaluatePerceptualGeneralization({ prototypes, queries });
    expect(result.accuracy).toBe(1);
    expect(result.exactNovelQueries).toBe(2);
    expect(result.claimBoundary).toBe('handcrafted-distance-diagnostic-only');
  });

  it('rejects cross-carrier and malformed comparisons', () => {
    expect(() => carrierPerceptualDistance(bitmap([]), canvas(true))).toThrow(/cross-carrier/u);
    expect(() => carrierPerceptualDistance(bitmap([]), { carrier: 'generative-bitmap', bits: [0] })).toThrow(/256/u);
    expect(() => carrierPerceptualDistance(tones(1), {
      carrier: 'generative-tone',
      tones: [{ pitchBin: 99, durationBin: 1 }],
    })).toThrow(/grammar/u);
  });

  it('uses a deterministic family then ID tie-break', () => {
    const result = evaluatePerceptualGeneralization({
      prototypes: [
        { id: 'z', family: 'z-family', mark: bitmap([0]) },
        { id: 'a', family: 'a-family', mark: bitmap([1]) },
      ],
      queries: [{ id: 'query', family: 'a-family', mark: bitmap([]) }],
    });
    expect(result.predictions[0]?.predictedFamily).toBe('a-family');
  });

  it('rejects duplicate identifiers across prototype and query sets', () => {
    expect(() => evaluatePerceptualGeneralization({
      prototypes: [
        { id: 'duplicate', family: 'a', mark: bitmap([0]) },
        { id: 'b', family: 'b', mark: bitmap([255]) },
      ],
      queries: [{ id: 'duplicate', family: 'a', mark: bitmap([1]) }],
    })).toThrow(/unique/u);
  });
});
