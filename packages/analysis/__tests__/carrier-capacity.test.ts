import { describe, expect, it } from 'vitest';

import { carrierCapacity } from '../src/carrier-capacity.js';

describe('E13 carrier capacity accounting', () => {
  it('separates the physical grammar from the fixed learner bank', () => {
    expect(
      carrierCapacity({
        carrier: 'fixed-token',
        formCount: 32,
        marksPerMessage: 4,
      }),
    ).toMatchObject({
      physicalGrammarForms: String(32 ** 4),
      physicalGrammarBits: 20,
      effectiveMessageBits: 20,
    });
    expect(
      carrierCapacity({
        carrier: 'generative-bitmap',
        formCount: 32,
        marksPerMessage: 1,
      }),
    ).toMatchObject({
      physicalGrammarForms: (2n ** 256n).toString(),
      physicalGrammarBits: 256,
      effectiveMessageBits: 5,
    });
  });

  it('counts every permitted variable-length tone and canvas artifact', () => {
    const tones = carrierCapacity({
      carrier: 'generative-tone',
      formCount: 32,
      marksPerMessage: 1,
    });
    expect(tones.physicalGrammarForms).toBe(
      Array.from({ length: 8 }, (_, index) => 32n ** BigInt(index + 1))
        .reduce((sum, value) => sum + value, 0n)
        .toString(),
    );
    expect(tones.physicalGrammarBits).toBeGreaterThan(40);
    expect(tones.physicalGrammarBits).toBeLessThan(40.1);

    const canvas = carrierCapacity({
      carrier: 'generative-canvas',
      formCount: 32,
      marksPerMessage: 1,
      maxStrokes: 64,
    });
    expect(Number.isFinite(canvas.physicalGrammarBits)).toBe(true);
    expect(canvas.physicalGrammarBits).toBeGreaterThan(1_124);
    expect(canvas.effectiveMessageBits).toBe(5);
  });

  it('rejects invalid declared capacities', () => {
    expect(() =>
      carrierCapacity({
        carrier: 'generative-canvas',
        formCount: 1,
        marksPerMessage: 1,
      }),
    ).toThrow(/formCount/u);
    expect(() =>
      carrierCapacity({
        carrier: 'generative-canvas',
        formCount: 32,
        marksPerMessage: 1,
        maxStrokes: 65,
      }),
    ).toThrow(/maxStrokes/u);
  });
});
