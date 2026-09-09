import {
  CLAIM_BOUNDARY_STATEMENTS,
  MODE_R_ONLY_CLAIM_LABELS,
  ClaimBoundaryError,
  assertClaimLabelsAllowed,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('SPEC §5.4 claim-boundary enforcement (ALD-054)', () => {
  it.each(['prototype', 'research-grade'] as const)(
    'defines the exact non-empty %s claim statement',
    (mode) => {
      expect(CLAIM_BOUNDARY_STATEMENTS[mode].length).toBeGreaterThan(100);
      expect(CLAIM_BOUNDARY_STATEMENTS[mode]).toContain(
        mode === 'prototype' ? 'Prototype Mode' : 'Research-Grade Mode',
      );
    },
  );

  it.each(MODE_R_ONLY_CLAIM_LABELS)(
    'blocks %s in Mode P and permits it in Mode R',
    (label) => {
      expect(() => assertClaimLabelsAllowed('prototype', [label])).toThrow(
        ClaimBoundaryError,
      );
      expect(() =>
        assertClaimLabelsAllowed('research-grade', [label]),
      ).not.toThrow();
    },
  );
});
