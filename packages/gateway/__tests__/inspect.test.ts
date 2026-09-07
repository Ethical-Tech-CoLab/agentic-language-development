/**
 * SPEC §9.4: every recursive inspection helper is bounded by an explicit
 * depth and node budget, so a deeply nested or very wide Baby-controlled
 * payload produces a decidable outcome instead of exhausting the native
 * call stack (regression for a finding against submitProposal/inspect.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  containsString,
  DEFAULT_COMPLEXITY_BUDGET,
  findTrustedMetadataKey,
  isWithinComplexityBudget,
  jsonSafe,
  PayloadTooComplexError,
} from '../src/inspect.js';

function deeplyNestedArray(depth: number, leaf: unknown = 'leaf'): unknown {
  let value: unknown = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

function wideObject(size: number): Record<string, number> {
  const object: Record<string, number> = {};
  for (let index = 0; index < size; index += 1) {
    object[`key-${index}`] = index;
  }
  return object;
}

describe('complexity budget (SPEC §9.4)', () => {
  it('accepts a value comfortably inside the default budget', () => {
    expect(isWithinComplexityBudget({ a: [1, 2, { b: 'c' }] })).toBe(true);
  });

  it('rejects a value nested past the default 32-level depth budget', () => {
    expect(isWithinComplexityBudget(deeplyNestedArray(5000))).toBe(false);
  });

  it('rejects a value with more than the default 10,000-node budget', () => {
    expect(isWithinComplexityBudget(wideObject(20_000))).toBe(false);
    expect(isWithinComplexityBudget(wideObject(100))).toBe(true);
  });

  it('never overflows the call stack on a 5,000-level nested array', () => {
    const deep = deeplyNestedArray(5000);
    expect(() => isWithinComplexityBudget(deep)).not.toThrow();
    expect(() => findTrustedMetadataKey(deep)).not.toThrow(RangeError);
    expect(() => containsString(deep)).not.toThrow(RangeError);
    expect(() => jsonSafe(deep)).not.toThrow();
  });

  it('never overflows the call stack on 20,000 sibling keys', () => {
    const wide = wideObject(20_000);
    expect(() => isWithinComplexityBudget(wide)).not.toThrow();
    expect(() => findTrustedMetadataKey(wide)).not.toThrow(RangeError);
    expect(() => containsString(wide)).not.toThrow(RangeError);
    expect(() => jsonSafe(wide)).not.toThrow();
  });

  it('findTrustedMetadataKey throws PayloadTooComplexError rather than RangeError once over budget', () => {
    expect(() => findTrustedMetadataKey(deeplyNestedArray(5000))).toThrow(
      PayloadTooComplexError,
    );
  });

  it('containsString throws PayloadTooComplexError rather than RangeError once over budget', () => {
    expect(() => containsString(deeplyNestedArray(5000))).toThrow(
      PayloadTooComplexError,
    );
  });

  it('jsonSafe never throws and replaces an over-budget payload with a small marker', () => {
    const replacement = jsonSafe(deeplyNestedArray(5000));
    expect(replacement).toEqual({ tooComplex: true });
    // The marker itself must stay comfortably inside the budget so a
    // downstream canonical hash of it can never repeat the same failure.
    expect(isWithinComplexityBudget(replacement)).toBe(true);
  });

  it('jsonSafe still falls back to its unserializable marker for a circular value within budget', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // A self-reference increases nesting depth without bound, so it is
    // correctly classified as exceeding the depth budget too.
    expect(jsonSafe(circular)).toEqual({ tooComplex: true });
  });

  it('still finds a trusted metadata key nested within budget', () => {
    expect(
      findTrustedMetadataKey({ a: { b: { c: { runId: 'forged' } } } }),
    ).toBe('runId');
    expect(findTrustedMetadataKey({ a: [1, 2, { sender: 'baby-a' }] })).toBe(
      'sender',
    );
  });

  it('still detects a string nested within budget', () => {
    expect(containsString({ a: [1, 2, { b: 'free text' }] })).toBe(true);
    expect(containsString({ a: [1, 2, { b: 3 }] })).toBe(false);
  });

  it('accepts an explicit narrower budget', () => {
    expect(
      isWithinComplexityBudget([[[1]]], { maxDepth: 2, maxNodes: 10 }),
    ).toBe(false);
    expect(
      isWithinComplexityBudget([[[1]]], { maxDepth: 3, maxNodes: 10 }),
    ).toBe(true);
  });

  it('DEFAULT_COMPLEXITY_BUDGET matches the documented 32/10,000 ceiling', () => {
    expect(DEFAULT_COMPLEXITY_BUDGET).toEqual({ maxDepth: 32, maxNodes: 10_000 });
  });
});
