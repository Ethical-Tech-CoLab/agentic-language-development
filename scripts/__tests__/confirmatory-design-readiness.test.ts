/* eslint-disable @typescript-eslint/no-explicit-any -- malformed boundary fixtures are intentional */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateConfirmatoryDesignReadiness } from '../lib/confirmatory-design-readiness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = () => JSON.parse(readFileSync(
  `${root}/protocols/confirmatory-design-readiness.v1.json`, 'utf8')) as any;

describe('confirmatory design-readiness gate', () => {
  it('accepts the explicit incomplete state without promoting it to a result', () => {
    const result = validateConfirmatoryDesignReadiness(source());
    expect(result).toEqual({
      memberIds: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6a', 'H6b', 'H7', 'H8'],
      operationalized: 7,
      frozen: 1,
    });
  });

  it('rejects a missing or reordered family member', () => {
    const missing = source();
    missing.members.splice(2, 1);
    expect(() => validateConfirmatoryDesignReadiness(missing)).toThrow(/exactly nine/u);

    const reordered = source();
    [reordered.members[0], reordered.members[1]] = [reordered.members[1], reordered.members[0]];
    expect(() => validateConfirmatoryDesignReadiness(reordered)).toThrow(/reordered/u);
  });

  it('rejects fixture values relabeled as frozen margins', () => {
    const readiness = source();
    readiness.members[1].marginStatus = 'frozen';
    readiness.members[1].practicalMargin = readiness.members[1].softwareFixtureCandidate;
    expect(() => validateConfirmatoryDesignReadiness(readiness)).toThrow(/fixture values/u);
  });

  it('rejects fabricated pilot, simulation, and sample-size state', () => {
    for (const mutate of [
      (value: any) => { value.members[0].pilot.validSlots = 20; },
      (value: any) => { value.members[0].simulation.repetitions = 30_000; },
      (value: any) => { value.summary.selectedPrimarySeeds = 100; },
    ]) {
      const readiness = source();
      mutate(readiness);
      expect(() => validateConfirmatoryDesignReadiness(readiness)).toThrow();
    }
  });

  it('rejects weakening the frozen H6b leakage bound', () => {
    const readiness = source();
    readiness.members[6].practicalMargin = 0.03;
    expect(() => validateConfirmatoryDesignReadiness(readiness)).toThrow(/H6b/u);
  });
});
