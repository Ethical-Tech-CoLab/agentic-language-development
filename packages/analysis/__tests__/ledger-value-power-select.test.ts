import { describe, expect, it } from 'vitest';
import { LV01_COMPONENT_IDS, reduceLv01Pilot, selectLv01Power } from '../src/index.js';
// Split from ledger-value-power.test.ts (R9-A): this single Monte Carlo
// selection case (~35s) runs in its own worker in parallel with the rest.
describe('LV01 power smallest-N selection', () => {
  it('selects the smallest qualifying N when power suffices', () => {
    const tight = reduceLv01Pilot(LV01_COMPONENT_IDS.map((component) => ({ component, values: Array.from({ length: 20 }, (_, index) => index < 10 ? -0.005 : 0.005) })), 0);
    expect(tight).toMatchObject({ status: 'eligible' });
    const selection = selectLv01Power(tight, 'lv01-power-probe/v1');
    expect(selection.status).toBe('selected');
    expect(selection.selectedDyads).toBe(75);
    expect(selection.reserveDyads).toBe(16);
    expect(selection.rows[0]?.eligible).toBe(true);
  });
});
