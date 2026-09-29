#!/usr/bin/env node
// Pure headroom-verdict helper for the A0 admission path (Resource policy
// revision 5). Extracted from the preflight script so the occupancy-vs-growth
// boundary is unit-testable without admission-path seams; the script delegates
// to this function and records the returned reason verbatim.
//
// Accounting. MemAvailable already nets ALL current residents, so in the
// cap-free branch only the prospective job peak (with the 1.5x allowance)
// counts against the 2-GiB reserve floor; subtracting current occupancy again
// would double-count residents. With an aggregate cap M installed, the branch
// reserves the slice's unused headroom (M - charge) so the host keeps the
// floor even if research grows to M. Unknown readings refuse (fail closed).
export const HEADROOM_FLOOR_BYTES = 2 * 1024 ** 3;
export const HEADROOM_PEAK_ALLOWANCE = 1.5;

export function headroomVerdict({ memWorst, charge, uncappedRss, researchCap, researchCapUnbounded, declaredPeak }) {
  if (memWorst === null || memWorst === undefined || !Number.isFinite(memWorst)) {
    return { admitted: false, reason: 'memory: MemAvailable unreadable' };
  }
  if (charge === null || charge === undefined || !Number.isFinite(charge)) {
    return { admitted: false, reason: 'memory: aggregate research charge unreadable (accounting group unreadable)' };
  }
  if (uncappedRss === null || uncappedRss === undefined || !Number.isFinite(uncappedRss)) {
    return { admitted: false, reason: 'memory: aggregate research charge unreadable (accounting group unreadable)' };
  }
  const peak = Number(declaredPeak);
  if (!Number.isFinite(peak) || peak < 0) {
    return { admitted: false, reason: 'memory: declared peak unreadable' };
  }
  // Explicit unbounded ("max") takes the cap-free branch. A null cap WITHOUT
  // the explicit flag is missing/malformed — never silently uncapped.
  if (researchCapUnbounded === true) {
    if (memWorst - HEADROOM_PEAK_ALLOWANCE * peak < HEADROOM_FLOOR_BYTES) {
      return {
        admitted: false,
        reason: `memory: headroom check fails (availWorst=${memWorst}, peak=${peak}, 1.5x allowance, no aggregate cap)`,
      };
    }
    return { admitted: true, reason: null };
  }
  if (researchCap === null || researchCap === undefined || !Number.isFinite(researchCap)) {
    return { admitted: false, reason: 'memory: aggregate research cap unreadable (malformed or missing)' };
  }
  const totalCharge = charge + uncappedRss;
  if (memWorst - Math.max(0, researchCap - totalCharge) < HEADROOM_FLOOR_BYTES) {
    return {
      admitted: false,
      reason: `memory: headroom check fails (availWorst=${memWorst}, sliceCharge=${charge}, uncappedRss=${uncappedRss}, cap=${researchCap})`,
    };
  }
  return { admitted: true, reason: null };
}

// Fit-below-high-watermark verdict. The caller skips this call when high is
// explicitly unbounded ("max"); a missing or malformed high reaching this
// function refuses — it must never silently pass as uncapped.
export function highWatermarkVerdict({ high, charge, uncappedRss, declaredPeak }) {
  if (high === null || high === undefined || !Number.isFinite(high)) {
    return { admitted: false, reason: 'memory: high watermark unreadable (malformed or missing)' };
  }
  const peak = Number(declaredPeak);
  if (charge + uncappedRss + HEADROOM_PEAK_ALLOWANCE * peak > high) {
    return {
      admitted: false,
      reason: `memory: declared workload (peak=${peak}, 1.5x allowance, charge=${charge}, uncapped=${uncappedRss}) does not fit below high watermark ${high}`,
    };
  }
  return { admitted: true, reason: null };
}
