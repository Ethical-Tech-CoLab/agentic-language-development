import { describe, expect, it } from 'vitest';
import { LV01_COMPONENT_IDS, reduceLv01Pilot, selectLv01Power } from '../src/index.js';
const pilot = (value = 0.1) => reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, (_, index) => value + index * .001) })), 0);
describe('LV01 power and reserve selection', () => {
  it('keeps pilot means hidden and rejects invalid or degenerate pilot inputs', () => { expect(pilot()).toMatchObject({ status: 'eligible' }); expect(reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, () => .1) })), 0)).toMatchObject({ status: 'blocked' }); expect(reduceLv01Pilot([], 1)).toMatchObject({ status: 'blocked' }); });
  it('uses every locked candidate and is deterministic', () => { const first = selectLv01Power(pilot(), 'lv01-power-fixture'); const second = selectLv01Power(pilot(), 'lv01-power-fixture'); expect(first).toEqual(second); expect(first.rows.map((row) => row.dyads)).toEqual([75, 100, 125, 150, 200, 300]); expect(first.rows.every((row) => Object.values(row.successes).every((count) => Number.isInteger(count) && count >= 0 && count <= 30000))).toBe(true); });
  it('blocks without selection when no candidate reaches family power, keeping reserves adequate', () => {
    const dispersed = reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, (_, index) => index < 10 ? -0.1 : 0.1) })), 0);
    expect(dispersed).toMatchObject({ status: 'eligible' });
    const selection = selectLv01Power(dispersed, 'lv01-power-probe/v1');
    expect(selection.status).toBe('blocked');
    expect(selection.selectedDyads).toBeNull();
    expect(selection.reserveDyads).toBeNull();
    expect(selection.rows.every((row) => row.jointLowerPower < 0.90)).toBe(true);
    expect(selection.rows.map((row) => row.reserveDyads)).toEqual([16, 20, 24, 29, 37, 52]);
    expect(selection.rows.every((row) => row.reserveAdequacy >= 0.95)).toBe(true);
  });
  // NOTE (R9-A): 'selects the smallest qualifying N when power suffices'
  // moved to ./ledger-value-power-select.test.ts so the slowest Monte Carlo
  // case runs in its own worker in parallel with the rest.
  it('rejects malformed pilot and selection inputs fail-closed', () => {
    expect(() => reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, () => Number.NaN) })), 0)).toThrow();
    expect(() => reduceLv01Pilot([], 0)).toThrow();
    expect(() => reduceLv01Pilot([...LV01_COMPONENT_IDS].reverse().map((component) => ({ component, values: Array.from({ length: 20 }, (_, index) => index * 0.001) })), 0)).toThrow();
    expect(() => selectLv01Power(pilot(), '')).toThrow();
    expect(selectLv01Power({ status: 'blocked', invalidProbabilityUpper95: null, upperSdByComponent: null }, 'lv01-power-probe/v1')).toMatchObject({ status: 'blocked', selectedDyads: null, reserveDyads: null });
  });
});
