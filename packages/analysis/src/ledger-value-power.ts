/** Outcome-blind LV01 pilot dispersion reduction and fixed power/reserve selection. */
import { SeededPrng } from '@ald/hashing';
import { summarize, wilsonInterval } from './descriptive.js';
import { AnalysisError } from './errors.js';
import { regularizedIncompleteBeta, studentTQuantile } from './special.js';
import { minimumConfirmatoryReserveSeeds } from './confirmatory-selection.js';
import { LV01_COMPONENT_IDS, type Lv01ComponentId } from './ledger-value.js';

export const LV01_POWER_VERSION = 'lv01-power-selection/v2' as const;
export const LV01_CANDIDATE_DYADS = [75, 100, 125, 150, 200, 300] as const;
export const LV01_MONTE_CARLO_REPETITIONS = 30_000;
export const LV01_MINIMUM_FAMILY_LOWER_POWER = 0.90;
/** sqrt(19 / chi2.ppf(0.05 / 7, 19)) for seven registered components; independently checked by the Python reference. */
export const LV01_PILOT_UPPER_SD_FACTOR = 1.6206392404280481 as const;
const boundaries: Record<Lv01ComponentId, number> = { incremental: 0.02, fidelity: -0.02, disabled: 0.05, constant: 0.05, random: 0.05, shuffled: 0.05, intervention: 0.05 };
const alternatives: Record<Lv01ComponentId, number> = { incremental: 0.04, fidelity: -0.01, disabled: 0.10, constant: 0.10, random: 0.10, shuffled: 0.10, intervention: 0.10 };

function fail(message: string): never { throw new AnalysisError('domain', message); }
class Normal { private spare: number | null = null; constructor(private readonly prng: SeededPrng) {} next(): number { if (this.spare !== null) { const value = this.spare; this.spare = null; return value; } let x = 0; let y = 0; let r = 0; do { x = 2 * this.prng.nextFloat() - 1; y = 2 * this.prng.nextFloat() - 1; r = x*x + y*y; } while (r === 0 || r >= 1); const scale = Math.sqrt(-2 * Math.log(r) / r); this.spare = y * scale; return x * scale; } }
function gamma(shape: number, prng: SeededPrng, normal: Normal): number { const d = shape - 1 / 3; const c = 1 / Math.sqrt(9 * d); for (;;) { const z = normal.next(); const f = 1 + c * z; if (f <= 0) continue; const cube = f*f*f; const u = prng.nextFloat(); if (u < 1 - .0331*z**4 || Math.log(u) < .5*z*z + d*(1-cube+Math.log(cube))) return d * cube; } }
function betaQuantile(probability: number, a: number, b: number): number { if (probability === 0) return 0; let low = 0; let high = 1; for (let i = 0; i < 100; i += 1) { const middle = (low + high) / 2; if (regularizedIncompleteBeta(middle, a, b) < probability) low = middle; else high = middle; } return (low + high) / 2; }
/** Simultaneous one-sided simulation-confidence level: seven components times six dyad candidates. */
function lowerPower(successes: number): number { return successes === 0 ? 0 : betaQuantile(0.05 / 42, successes, LV01_MONTE_CARLO_REPETITIONS - successes + 1); }

export interface Lv01PilotDispersion { readonly component: Lv01ComponentId; readonly values: readonly number[]; }
export interface Lv01PilotReduction { readonly status: 'eligible' | 'blocked'; readonly invalidProbabilityUpper95: number | null; readonly upperSdByComponent: Readonly<Record<Lv01ComponentId, number>> | null; readonly reason?: string; }
export interface Lv01PowerRow { readonly dyads: number; readonly successes: Readonly<Record<Lv01ComponentId, number>>; readonly lowerPower: Readonly<Record<Lv01ComponentId, number>>; readonly jointLowerPower: number; readonly reserveDyads: number; readonly reserveAdequacy: number; readonly eligible: boolean; }
export interface Lv01PowerSelection { readonly status: 'selected' | 'blocked'; readonly rows: readonly Lv01PowerRow[]; readonly selectedDyads: number | null; readonly reserveDyads: number | null; }

/** Reduce exactly twenty valid blinded pilot values per component without exposing their means. */
export function reduceLv01Pilot(dispersions: readonly Lv01PilotDispersion[], invalidSlots: number): Lv01PilotReduction {
  if (!Number.isInteger(invalidSlots) || invalidSlots < 0 || invalidSlots > 20) fail('LV01 pilot invalid slot count is invalid');
  if (invalidSlots !== 0) return { status: 'blocked', invalidProbabilityUpper95: null, upperSdByComponent: null, reason: 'all twenty pilot dyads must be valid' };
  if (dispersions.length !== LV01_COMPONENT_IDS.length || dispersions.some((item, index) => item.component !== LV01_COMPONENT_IDS[index])) fail('LV01 pilot requires all seven ordered components');
  const upper = {} as Record<Lv01ComponentId, number>;
  for (const item of dispersions) { if (item.values.length !== 20 || item.values.some((value) => !Number.isFinite(value))) fail(`LV01 pilot ${item.component} requires twenty finite values`); const sd = summarize(item.values).sd; if (!(sd > 0)) return { status: 'blocked', invalidProbabilityUpper95: null, upperSdByComponent: null, reason: `LV01 pilot ${item.component} has zero dispersion` }; upper[item.component] = sd * LV01_PILOT_UPPER_SD_FACTOR; }
  return { status: 'eligible', invalidProbabilityUpper95: wilsonInterval(0, 20, .90).upper, upperSdByComponent: upper };
}

export function selectLv01Power(reduction: Lv01PilotReduction, seed: string): Lv01PowerSelection {
  if (reduction.status !== 'eligible' || reduction.upperSdByComponent === null || reduction.invalidProbabilityUpper95 === null) return { status: 'blocked', rows: [], selectedDyads: null, reserveDyads: null };
  if (seed.length === 0) fail('LV01 power seed must be non-empty'); const root = new SeededPrng(seed); const invalidProbabilityUpper95 = reduction.invalidProbabilityUpper95;
  const rows = LV01_CANDIDATE_DYADS.map((dyads) => {
    const successes = {} as Record<Lv01ComponentId, number>; const lower = {} as Record<Lv01ComponentId, number>;
    for (const component of LV01_COMPONENT_IDS) { const sd = reduction.upperSdByComponent![component]; const normal = new Normal(root.derive(`${dyads}/${component}`)); const df = dyads - 1; const critical = studentTQuantile(1 - .05 / 4, df); let passed = 0; /* screening alpha 0.05 over four members: LV-U, LV-P, LV-C, LV-L */ for (let repetition = 0; repetition < LV01_MONTE_CARLO_REPETITIONS; repetition += 1) { const mean = alternatives[component] + sd * normal.next() / Math.sqrt(dyads); const sampleSd = sd * Math.sqrt((2 * gamma(df / 2, root.derive(`${dyads}/${component}/g/${repetition}`), normal)) / df); if ((mean - boundaries[component]) / (sampleSd / Math.sqrt(dyads)) > critical) passed += 1; } successes[component] = passed; lower[component] = lowerPower(passed); }
    const jointLowerPower = Math.max(0, 1 - LV01_COMPONENT_IDS.reduce((sum, component) => sum + 1 - lower[component]!, 0)); const reserve = minimumConfirmatoryReserveSeeds(dyads, invalidProbabilityUpper95); return { dyads, successes, lowerPower: lower, jointLowerPower, reserveDyads: reserve.reserveSeeds, reserveAdequacy: reserve.adequacyProbability, eligible: jointLowerPower >= LV01_MINIMUM_FAMILY_LOWER_POWER };
  });
  const selected = rows.find((row) => row.eligible) ?? null; return { status: selected === null ? 'blocked' : 'selected', rows, selectedDyads: selected?.dyads ?? null, reserveDyads: selected?.reserveDyads ?? null };
}
