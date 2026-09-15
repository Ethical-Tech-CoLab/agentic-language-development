import { describe, expect, it } from 'vitest';

import { E03_COMMUNICATION_CONDITIONS } from '../src/e03-design.js';
import { reconcileE03FullPairedRuns, type E03FullAttemptedRun } from '../src/e03-full.js';
import type { E03RegisteredRun } from '../src/e03-registration.js';

const hashes = (slot: number) => Array.from({ length: 200 }, (_, episode) =>
  `sha256:${(slot * 200 + episode).toString(16).padStart(64, '0')}`);

const registered: E03RegisteredRun[] = Array.from({ length: 28 }, (_, index) => index + 1)
  .flatMap((slot) => E03_COMMUNICATION_CONDITIONS.map((condition) => ({
    slot, condition, use: slot <= 25 ? 'primary' : 'reserve',
    config: { runId: `e03-full-${condition}-s${String(slot).padStart(3, '0')}`,
      randomSeed: `full-scenario-${slot}` },
  } as E03RegisteredRun)));

const attempt = (run: E03RegisteredRun): E03FullAttemptedRun => ({
  runId: run.config.runId, slot: run.slot, use: run.use, condition: run.condition,
  valid: true, bundleVerified: true, agreements: 50,
  scenarioStateHashes: hashes(run.slot),
});
const primary = () => registered.filter((run) => run.use === 'primary').map(attempt);
const reserve = (slot: number) => registered.filter((run) => run.slot === slot).map(attempt);
const invalidate = (rows: E03FullAttemptedRun[], slot: number) => {
  const index = rows.findIndex((run) => run.slot === slot && run.condition === 'random');
  rows[index] = { ...rows[index]!, valid: false, invalidReason: 'verifier-failure',
    bundleVerified: false, agreements: undefined, scenarioStateHashes: undefined };
};

describe('E03 full paired-reserve reconciliation', () => {
  it('includes all 25 complete primary scenario pairs without using reserves', () => {
    const result = reconcileE03FullPairedRuns(registered, primary());
    expect(result.status).toBe('complete');
    expect(result.attemptedRuns).toBe(150);
    expect(result.includedPairs).toHaveLength(25);
    expect(result.unattemptedReserveRunIds).toHaveLength(18);
    expect(result.replacements).toEqual([]);
  });

  it('excludes every companion and replaces an invalid pair with the first entire reserve', () => {
    const rows = primary();
    invalidate(rows, 7);
    const result = reconcileE03FullPairedRuns(registered, [...rows, ...reserve(26)]);
    expect(result.status).toBe('complete');
    expect(result.replacements).toEqual([{ primarySlot: 7, reserveSlot: 26 }]);
    expect(result.includedPairs[6]).toMatchObject({ primarySlot: 7, sourceSlot: 26,
      use: 'reserve' });
    expect(result.validButExcludedRunIds).toHaveLength(5);
    expect(result.unattemptedReserveRunIds).toHaveLength(12);
  });

  it('counts an invalid reserve and uses the next ordered complete reserve', () => {
    const rows = primary();
    invalidate(rows, 1);
    const first = reserve(26);
    invalidate(first, 26);
    const result = reconcileE03FullPairedRuns(registered,
      [...rows, ...first, ...reserve(27)]);
    expect(result.status).toBe('complete');
    expect(result.invalidReserveSlots).toEqual([26]);
    expect(result.replacements).toEqual([{ primarySlot: 1, reserveSlot: 27 }]);
    expect(result.validButExcludedRunIds).toHaveLength(10);
  });

  it('is incomplete rather than a negative finding when four primary pairs are invalid', () => {
    const rows = primary();
    for (const slot of [1, 2, 3, 4]) invalidate(rows, slot);
    const result = reconcileE03FullPairedRuns(registered,
      [...rows, ...reserve(26), ...reserve(27), ...reserve(28)]);
    expect(result.status).toBe('incomplete');
    expect(result.includedPairs).toHaveLength(24);
  });

  it('rejects missing primary runs and condition-specific or out-of-order reserves', () => {
    expect(() => reconcileE03FullPairedRuns(registered, primary().slice(1))).toThrow();
    const rows = primary();
    invalidate(rows, 1);
    expect(() => reconcileE03FullPairedRuns(registered,
      [...rows, reserve(26)[0]!])).toThrow();
    expect(() => reconcileE03FullPairedRuns(registered,
      [...rows, ...reserve(27)])).toThrow();
  });

  it('rejects unneeded reserves, reused IDs, and diverging paired scenarios', () => {
    expect(() => reconcileE03FullPairedRuns(registered,
      [...primary(), ...reserve(26)])).toThrow();
    const rows = primary();
    expect(() => reconcileE03FullPairedRuns(registered,
      [...rows, rows[0]!])).toThrow();
    const changed = [...rows];
    changed[1] = { ...changed[1]!, scenarioStateHashes: hashes(27) };
    expect(() => reconcileE03FullPairedRuns(registered, changed)).toThrow();
  });

  it('rejects further reserve collection after a pair has already been replaced', () => {
    const rows = primary();
    invalidate(rows, 1);
    expect(() => reconcileE03FullPairedRuns(registered,
      [...rows, ...reserve(26), ...reserve(27)])).toThrow();
  });

  it('does not admit unverified or contradictory runs as original outcome data', () => {
    const rows = primary();
    expect(() => reconcileE03FullPairedRuns(registered,
      [{ ...rows[0]!, bundleVerified: false }, ...rows.slice(1)])).toThrow();
    expect(() => reconcileE03FullPairedRuns(registered,
      [{ ...rows[0]!, invalidReason: 'verifier-failure' }, ...rows.slice(1)])).toThrow();
    expect(() => reconcileE03FullPairedRuns(registered,
      [{ ...rows[0]!, scenarioStateHashes: ['malformed', ...hashes(1).slice(1)] },
        ...rows.slice(1)])).toThrow();
  });
});
