import { describe, expect, it } from 'vitest';

import { nextE03FullCollectorBatch } from '../e03-full-collector-state.mjs';

const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];
const registered = Array.from({ length: 28 }, (_, index) => index + 1).flatMap((slot) =>
  conditions.map((condition) => ({ slot, condition,
    use: slot <= 25 ? 'primary' : 'reserve',
    config: { runId: `e03-full-${condition}-s${String(slot).padStart(3, '0')}` } })));
const attempt = (run: (typeof registered)[number], valid = true) => ({
  runId: run.config.runId, slot: run.slot, condition: run.condition, use: run.use, valid,
});
const primaries = () => registered.filter((run) => run.use === 'primary').map((run) => attempt(run));
const reserve = (slot: number, valid = true) => registered.filter((run) => run.slot === slot)
  .map((run) => attempt(run, valid));

describe('E03 full collector scheduling', () => {
  it('collects every primary in packet order before considering reserves', () => {
    expect(nextE03FullCollectorBatch(registered, []).runs[0]?.config.runId)
      .toBe('e03-full-disabled-s001');
    expect(nextE03FullCollectorBatch(registered, primaries().slice(0, 149)).state)
      .toBe('collect-primary');
  });

  it('finishes without touching reserves when all primary pairs are valid', () => {
    expect(nextE03FullCollectorBatch(registered, primaries())).toMatchObject({
      state: 'done', invalidPrimarySlots: [], validReserveSlots: 0, reserveExhausted: false,
    });
  });

  it('requests one entire ordered reserve slot for an invalid primary pair', () => {
    const rows = primaries();
    rows[0] = { ...rows[0]!, valid: false };
    const next = nextE03FullCollectorBatch(registered, rows);
    expect(next.state).toBe('collect-reserve');
    expect(next.runs).toHaveLength(6);
    expect(new Set(next.runs.map((run: any) => run.slot))).toEqual(new Set([26]));
  });

  it('continues after an invalid reserve and stops after an ordered valid replacement', () => {
    const rows = primaries();
    rows[0] = { ...rows[0]!, valid: false };
    expect(nextE03FullCollectorBatch(registered, [...rows, ...reserve(26, false)]).runs[0]?.slot)
      .toBe(27);
    expect(nextE03FullCollectorBatch(registered,
      [...rows, ...reserve(26, false), ...reserve(27)])).toMatchObject({
      state: 'done', validReserveSlots: 1, reserveExhausted: false,
    });
  });

  it('reports exhaustion instead of a negative scientific result', () => {
    const rows = primaries();
    for (const slot of [1, 2, 3, 4]) {
      const index = rows.findIndex((row) => row.slot === slot);
      rows[index] = { ...rows[index]!, valid: false };
    }
    expect(nextE03FullCollectorBatch(registered,
      [...rows, ...reserve(26), ...reserve(27), ...reserve(28)])).toMatchObject({
      state: 'done', validReserveSlots: 3, reserveExhausted: true,
    });
  });

  it('rejects early, partial, duplicate, and out-of-order reserve attempts', () => {
    expect(() => nextE03FullCollectorBatch(registered, reserve(26))).toThrow(/before every primary/u);
    const rows = primaries();
    rows[0] = { ...rows[0]!, valid: false };
    expect(() => nextE03FullCollectorBatch(registered, [...rows, reserve(26)[0]!]))
      .toThrow(/partially/u);
    expect(() => nextE03FullCollectorBatch(registered, [...rows, ...reserve(27)]))
      .toThrow(/order/u);
    expect(() => nextE03FullCollectorBatch(registered, [...rows, rows[0]!]))
      .toThrow(/duplicate/u);
  });
});
