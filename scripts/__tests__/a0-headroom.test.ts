import { describe, expect, it } from 'vitest';

import { HEADROOM_FLOOR_BYTES, HEADROOM_PEAK_ALLOWANCE, headroomVerdict, highWatermarkVerdict } from '../a0-headroom.mjs';

const GiB = 1024 ** 3;

describe('A0 headroom verdict', () => {
  it('pins the reserve floor and peak allowance (never silently weakened)', () => {
    expect(HEADROOM_FLOOR_BYTES).toBe(2 * GiB);
    expect(HEADROOM_PEAK_ALLOWANCE).toBe(1.5);
  });

  it('does not double-count current occupancy against available (cap-free)', () => {
    // 3 GiB available with 1.5 GiB resident + 100 MiB prospective peak: the old
    // formula refused (3 - 1.5 - 0.15 < 2); MemAvailable already nets residents.
    expect(
      headroomVerdict({ memWorst: 3 * GiB, charge: 1.5 * GiB, uncappedRss: 0, researchCap: null, researchCapUnbounded: true, declaredPeak: 100 * 1024 ** 2 }).admitted,
    ).toBe(true);
  });

  it('refuses prospective growth that breaches the floor (cap-free)', () => {
    expect(
      headroomVerdict({ memWorst: 3 * GiB, charge: 0.5 * GiB, uncappedRss: 0, researchCap: null, researchCapUnbounded: true, declaredPeak: 1 * GiB }),
    ).toEqual({ admitted: false, reason: expect.stringContaining('headroom') });
  });

  it('admits exactly at the floor boundary and refuses one byte below', () => {
    const peak = 1 * GiB;
    const atFloor = HEADROOM_FLOOR_BYTES + HEADROOM_PEAK_ALLOWANCE * peak;
    expect(
      headroomVerdict({ memWorst: atFloor, charge: 0, uncappedRss: 0, researchCap: null, researchCapUnbounded: true, declaredPeak: peak }).admitted,
    ).toBe(true);
    expect(
      headroomVerdict({ memWorst: atFloor - 1, charge: 0, uncappedRss: 0, researchCap: null, researchCapUnbounded: true, declaredPeak: peak }).admitted,
    ).toBe(false);
  });

  it('preserves the capped branch: reserves unused cap headroom', () => {
    const cap = 4 * GiB;
    expect(
      headroomVerdict({ memWorst: 3 * GiB, charge: 1 * GiB, uncappedRss: 0, researchCap: cap, researchCapUnbounded: false, declaredPeak: 100 * 1024 ** 2 }).admitted,
    ).toBe(false);
    expect(
      headroomVerdict({ memWorst: 3 * GiB, charge: 3.5 * GiB, uncappedRss: 0, researchCap: cap, researchCapUnbounded: false, declaredPeak: 100 * 1024 ** 2 }).admitted,
    ).toBe(true);
  });

  it('refuses unknown readings (fail closed)', () => {
    const base = { memWorst: 3 * GiB, charge: 1 * GiB, uncappedRss: 0, researchCap: null, researchCapUnbounded: true, declaredPeak: 100 * 1024 ** 2 };
    expect(headroomVerdict({ ...base, memWorst: null }).admitted).toBe(false);
    expect(headroomVerdict({ ...base, charge: null }).admitted).toBe(false);
    expect(headroomVerdict({ ...base, declaredPeak: Number.NaN }).admitted).toBe(false);
  });

  it('refuses a missing or malformed cap (never silently uncapped)', () => {
    const base = { memWorst: 3 * GiB, charge: 1 * GiB, uncappedRss: 0, researchCapUnbounded: false, declaredPeak: 100 * 1024 ** 2 };
    expect(headroomVerdict({ ...base, researchCap: null })).toEqual(
      { admitted: false, reason: expect.stringContaining('malformed or missing') },
    );
    expect(headroomVerdict({ ...base, researchCap: Number.NaN })).toEqual(
      { admitted: false, reason: expect.stringContaining('malformed or missing') },
    );
  });
});

describe('A0 high-watermark verdict', () => {
  it('admits a workload that fits below high', () => {
    // Explicit-max skip lives in the caller (no call = no check); the module
    // contract pins valid-input evaluation plus malformed refusal below.
    expect(highWatermarkVerdict({ high: 8 * GiB, charge: 1 * GiB, uncappedRss: 0, declaredPeak: 1 * GiB }).admitted).toBe(true);
  });

  it('refuses a missing or malformed high (never silently uncapped)', () => {
    for (const high of [null, undefined, Number.NaN]) {
      expect(highWatermarkVerdict({ high, charge: 1 * GiB, uncappedRss: 0, declaredPeak: 1 * GiB })).toEqual(
        { admitted: false, reason: expect.stringContaining('malformed or missing') },
      );
    }
  });

  it('refuses a workload that does not fit below high', () => {
    expect(highWatermarkVerdict({ high: 2 * GiB, charge: 1 * GiB, uncappedRss: 0, declaredPeak: 1 * GiB })).toEqual(
      { admitted: false, reason: expect.stringContaining('does not fit below high watermark') },
    );
  });
});
