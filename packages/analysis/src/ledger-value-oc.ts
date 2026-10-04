/** Dyad-vector entry to the frozen LV01 family decision (R08 OC harness preparation). */
import { AnalysisError } from './errors.js';
import {
  analyzeLv01Family,
  LV01_COMPONENT_IDS,
  type Lv01ComponentId,
  type Lv01FamilyResult,
  type Lv01SeedComponentValues,
} from './ledger-value.js';

export interface Lv01DyadVector {
  readonly seedId: string;
  readonly values: Readonly<Record<Lv01ComponentId, number>>;
}

function fail(message: string): never {
  throw new AnalysisError('domain', message);
}

/**
 * Run the frozen LV01 member/Holm/disposition chain on dyad-level component
 * values. Each value is presented identically to both roles, so the
 * equal-role reduction returns it exactly: (v + v) / 2 === v in IEEE
 * arithmetic for finite v, and component statistics are bounded (|v| <= 2).
 * One-sample tests, LV-C argmax order, Holm rule and degenerate handling
 * are inherited verbatim from analyzeLv01Family, not reimplemented
 * (the argmax tie order is behaviorally unobservable through the result,
 * so it is documented here rather than pinned by a test).
 * OC distribution drivers stay out of this module until the DGP freeze.
 */
export function analyzeLv01DyadVectors(
  dyads: readonly Lv01DyadVector[],
): Lv01FamilyResult {
  if (!Array.isArray(dyads) || dyads.length < 2) {
    fail('LV01 dyad vectors require at least two dyads');
  }
  const seen = new Set<string>();
  const rows: Lv01SeedComponentValues[] = dyads.map((dyad) => {
    if (typeof dyad !== 'object' || dyad === null) {
      fail('LV01 dyad vector must be an object');
    }
    if (typeof dyad.seedId !== 'string' || dyad.seedId.length === 0) {
      fail('LV01 dyad seedId must be a non-empty string');
    }
    if (seen.has(dyad.seedId)) {
      fail(`LV01 dyad seedId ${dyad.seedId} is duplicated`);
    }
    seen.add(dyad.seedId);
    if (typeof dyad.values !== 'object' || dyad.values === null) {
      fail(`LV01 dyad ${dyad.seedId} values must be an object`);
    }
    const perRole = {} as Record<Lv01ComponentId, readonly number[]>;
    for (const component of LV01_COMPONENT_IDS) {
      const value: unknown = dyad.values[component];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`LV01 dyad ${dyad.seedId} ${component} must be a finite number`);
      }
      perRole[component] = [value];
    }
    return { seedId: dyad.seedId, byRole: { 'baby-a': perRole, 'baby-b': perRole } };
  });
  return analyzeLv01Family(rows);
}
