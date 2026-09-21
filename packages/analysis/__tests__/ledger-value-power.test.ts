import { describe, expect, it } from 'vitest';
import { LV01_COMPONENT_IDS, reduceLv01Pilot, selectLv01Power } from '../src/index.js';
const pilot = (value = 0.1) => reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, (_, index) => value + index * .001) })), 0);
describe('LV01 power and reserve selection', () => {
  it('keeps pilot means hidden and rejects invalid or degenerate pilot inputs', () => { expect(pilot()).toMatchObject({ status: 'eligible' }); expect(reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, () => .1) })), 0)).toMatchObject({ status: 'blocked' }); expect(reduceLv01Pilot([], 1)).toMatchObject({ status: 'blocked' }); });
  it('uses every locked candidate and is deterministic', () => { const first = selectLv01Power(pilot(), 'lv01-power-fixture'); const second = selectLv01Power(pilot(), 'lv01-power-fixture'); expect(first).toEqual(second); expect(first.rows.map((row) => row.dyads)).toEqual([75, 100, 125, 150, 200, 300]); expect(first.rows.every((row) => Object.values(row.successes).every((count) => Number.isInteger(count) && count >= 0 && count <= 30000))).toBe(true); });
});
