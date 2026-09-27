import { describe, expect, it } from 'vitest';
import {
  LV01_CALIBRATION_DYADS,
  LV01_PEAK_MEMORY_MULTIPLIER,
  LV01_PILOT_PRIMARY_SLOTS,
  LV01_SLOT_RESERVE_MULTIPLIER,
  computeLv01CalibrationReserves,
  scaleLv01ReserveForSlots,
  type Lv01SlotResources,
} from '../../src/experiments/ledger-value.js';

const dyad = (overrides: Partial<Lv01SlotResources> = {}): Lv01SlotResources => ({
  cpuMicroseconds: 3_600_000_000,
  wallMilliseconds: 60_000,
  peakBytes: 2 * 1024 ** 3,
  evidenceBytes: 100 * 1024 ** 2,
  verificationMilliseconds: 1_000,
  unresolved: [],
  ...overrides,
});

describe('LV01 H07 calibration reserves', () => {
  it('reserves twice the largest measured CPU/storage/wall cost and 1.5 times peak memory', () => {
    const measurements = [dyad(), dyad(), dyad(), dyad(), dyad({
      cpuMicroseconds: 7_200_000_000,
      wallMilliseconds: 120_000,
      peakBytes: 4 * 1024 ** 3,
      evidenceBytes: 300 * 1024 ** 2,
    })];
    expect(computeLv01CalibrationReserves(measurements)).toEqual({
      measuredDyads: 5,
      perSlotCpuMicroseconds: 7_200_000_000 * LV01_SLOT_RESERVE_MULTIPLIER,
      perSlotEvidenceBytes: 300 * 1024 ** 2 * LV01_SLOT_RESERVE_MULTIPLIER,
      perSlotWallMilliseconds: 120_000 * LV01_SLOT_RESERVE_MULTIPLIER,
      peakBytesBound: 4 * 1024 ** 3 * LV01_PEAK_MEMORY_MULTIPLIER,
    });
    expect(LV01_CALIBRATION_DYADS).toBe(5);
    expect(LV01_SLOT_RESERVE_MULTIPLIER).toBe(2);
    expect(LV01_PEAK_MEMORY_MULTIPLIER).toBe(1.5);
  });

  it('refuses fewer than five dyads instead of inventing measurements', () => {
    expect(() => computeLv01CalibrationReserves([dyad(), dyad(), dyad(), dyad()]))
      .toThrow(/at least 5 complete full-workload dyads/u);
    expect(() => computeLv01CalibrationReserves([])).toThrow(/at least 5 complete full-workload dyads/u);
  });

  it('refuses an incomplete slot cost instead of treating it as zero', () => {
    for (const incomplete of [
      { cpuMicroseconds: 0 },
      { wallMilliseconds: 0 },
      { peakBytes: 0 },
      { evidenceBytes: 0 },
      { cpuMicroseconds: Number.NaN },
    ]) {
      const measurements = [dyad(), dyad(), dyad(), dyad(), dyad(incomplete)];
      expect(() => computeLv01CalibrationReserves(measurements)).toThrow(/complete measured slot costs/u);
    }
  });

  it('scales the per-slot reserve over the twenty-slot pilot', () => {
    const reserve = computeLv01CalibrationReserves([dyad(), dyad(), dyad(), dyad(), dyad()]);
    expect(LV01_PILOT_PRIMARY_SLOTS).toBe(20);
    expect(scaleLv01ReserveForSlots(reserve, LV01_PILOT_PRIMARY_SLOTS)).toEqual({
      slots: 20,
      cpuMicroseconds: reserve.perSlotCpuMicroseconds * 20,
      evidenceBytes: reserve.perSlotEvidenceBytes * 20,
      wallMilliseconds: reserve.perSlotWallMilliseconds * 20,
    });
    expect(() => scaleLv01ReserveForSlots(reserve, 0)).toThrow(/positive integer/u);
  });

  it('takes maxima over calibration and pilot measurements with the same multipliers', () => {
    const calibration = [dyad(), dyad(), dyad(), dyad(), dyad()];
    const pilotSpike = dyad({ cpuMicroseconds: 10_800_000_000 });
    const combined = [...calibration, ...Array(19).fill(dyad()), pilotSpike];
    const reserve = computeLv01CalibrationReserves(combined);
    expect(reserve.measuredDyads).toBe(25);
    expect(reserve.perSlotCpuMicroseconds).toBe(10_800_000_000 * LV01_SLOT_RESERVE_MULTIPLIER);
    expect(reserve.perSlotEvidenceBytes).toBe(100 * 1024 ** 2 * LV01_SLOT_RESERVE_MULTIPLIER);
  });

  it('rejects measurements with unresolved counters', () => {
    const partial = dyad({ peakBytes: 0, unresolved: ['peakBytes'] });
    expect(() => computeLv01CalibrationReserves([dyad(), dyad(), dyad(), dyad(), partial])).toThrow(/unresolved/u);
  });
});
