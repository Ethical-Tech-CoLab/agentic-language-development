/** Outcome-safe ordinary-record predictors and LV01 analysis primitives. */
import { AnalysisError } from './errors.js';
import { holmBonferroni, oneSampleTTest } from './hypothesis.js';
import { studentTQuantile } from './special.js';

export const LV01_ANALYSIS_VERSION = 'lv01-analysis/v2' as const;
export const LV01_ORDINARY_PREDICTOR_IDS = [
  'uniform', 'validation-majority', 'transcript-only', 'task-history',
  'ordinary-record-softmax',
] as const;
export type Lv01OrdinaryPredictorId = (typeof LV01_ORDINARY_PREDICTOR_IDS)[number];

export interface Lv01OrdinaryRecord {
  readonly caseId: string;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly deliveredToken: string | null;
  readonly candidateTypeCodes: readonly number[];
  /** The observed receiver action position; not the researcher-only task target. */
  readonly actualSelectedCandidateIndex: number;
}
/** Serializable fitted state so a pre-action commitment can persist the ordinary vector's fit. */
export interface Lv01CountFit {
  readonly kind: 'count';
  readonly marginal: readonly number[];
  readonly byToken: Readonly<Record<string, readonly number[]>>;
  readonly byTokenType: Readonly<Record<string, readonly number[]>>;
}
export interface Lv01SoftmaxFit {
  readonly kind: 'softmax';
  readonly weights: readonly number[];
}
export interface Lv01UniformFit {
  readonly kind: 'uniform';
}
export type Lv01OrdinaryFit = Lv01CountFit | Lv01SoftmaxFit | Lv01UniformFit;
export interface Lv01OrdinaryPredictor {
  readonly id: Lv01OrdinaryPredictorId;
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly fit: Lv01OrdinaryFit;
  readonly probabilitiesFor: (record: Omit<Lv01OrdinaryRecord, 'actualSelectedCandidateIndex'>) => number[];
}
export interface Lv01OrdinarySelection {
  readonly selectedPredictorId: Lv01OrdinaryPredictorId;
  readonly validationBrierByPredictor: Readonly<Record<Lv01OrdinaryPredictorId, number>>;
  readonly candidatePredictors: readonly Lv01OrdinaryPredictor[];
  readonly refitPredictor: Lv01OrdinaryPredictor;
}

const CANDIDATES = 4;
const TYPES = 16;
const TOKENS = 32;
const COEFFICIENTS = 565;
const EPS = 1e-12;

function fail(message: string): never { throw new AnalysisError('domain', message); }
function softmax(logits: readonly number[]): number[] {
  const max = Math.max(...logits);
  const exp = logits.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0);
  return exp.map((value) => value / total);
}
function brier(probabilities: readonly number[], action: number): number {
  return probabilities.reduce((sum, value, index) => sum + (value - (index === action ? 1 : 0)) ** 2, 0);
}
function tokenIndex(token: string | null, inventory: readonly string[]): number | null {
  if (token === null) return null;
  const index = inventory.indexOf(token);
  if (index < 0) fail('ordinary record uses a token outside the frozen inventory');
  return index;
}
function assertInventory(inventory: readonly string[]): void {
  if (inventory.length !== TOKENS || new Set(inventory).size !== TOKENS) fail('LV01 requires 32 distinct inventory tokens');
}
function assertRecord(value: Lv01OrdinaryRecord, inventory: readonly string[]): void {
  if (typeof value !== 'object' || value === null) fail('ordinary record must be an object');
  const keys = Object.keys(value).sort();
  const expected = ['actualSelectedCandidateIndex', 'candidateTypeCodes', 'caseId', 'deliveredToken', 'receiverRole'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail('ordinary record has forbidden or missing fields');
  if (value.caseId.length === 0 || (value.receiverRole !== 'baby-a' && value.receiverRole !== 'baby-b')) fail('ordinary record identity is invalid');
  if (value.candidateTypeCodes.length !== CANDIDATES || new Set(value.candidateTypeCodes).size !== CANDIDATES || value.candidateTypeCodes.some((type) => !Number.isInteger(type) || type < 0 || type >= TYPES)) fail('ordinary record candidate types are invalid');
  if (!Number.isInteger(value.actualSelectedCandidateIndex) || value.actualSelectedCandidateIndex < 0 || value.actualSelectedCandidateIndex >= CANDIDATES) fail('ordinary record action position is invalid');
  tokenIndex(value.deliveredToken, inventory);
}
function assertRows(rows: readonly Lv01OrdinaryRecord[], inventory: readonly string[], role?: 'baby-a' | 'baby-b'): 'baby-a' | 'baby-b' {
  if (rows.length === 0) fail('ordinary record rows must not be empty');
  const ids = new Set<string>(); const receiverRole = role ?? rows[0]!.receiverRole;
  for (const row of rows) { assertRecord(row, inventory); if (row.receiverRole !== receiverRole) fail('ordinary predictors must be fit per receiver role'); if (ids.has(row.caseId)) fail('ordinary record caseIds must be unique'); ids.add(row.caseId); }
  return receiverRole;
}
function meanBrier(predictor: Lv01OrdinaryPredictor, rows: readonly Lv01OrdinaryRecord[]): number {
  return rows.reduce((sum, row) => sum + brier(predictor.probabilitiesFor(row), row.actualSelectedCandidateIndex), 0) / rows.length;
}
function countModel(id: Lv01OrdinaryPredictorId, role: 'baby-a' | 'baby-b', rows: readonly Lv01OrdinaryRecord[], inventory: readonly string[]): Lv01OrdinaryPredictor {
  const marginal = Array.from({ length: CANDIDATES }, () => 1);
  const byToken = new Map<string, number[]>(); const byTokenType = new Map<string, number[]>();
  for (const row of rows) {
    marginal[row.actualSelectedCandidateIndex]! += 1;
    const key = row.deliveredToken ?? '<disabled>';
    const tokenCounts = byToken.get(key) ?? Array.from({ length: CANDIDATES }, () => 1);
    tokenCounts[row.actualSelectedCandidateIndex]! += 1; byToken.set(key, tokenCounts);
    const selectedType = row.candidateTypeCodes[row.actualSelectedCandidateIndex]!;
    const typeCounts = byTokenType.get(key) ?? Array.from({ length: TYPES }, () => 1);
    typeCounts[selectedType]! += 1; byTokenType.set(key, typeCounts);
  }
  const fit: Lv01OrdinaryFit = id === 'uniform'
    ? { kind: 'uniform' }
    : { kind: 'count', marginal: [...marginal], byToken: Object.fromEntries(byToken), byTokenType: Object.fromEntries(byTokenType) };
  return { id, receiverRole: role, fit, probabilitiesFor: (record) => scoreLv01OrdinaryFit(id, fit, record, inventory) };
}
/**
 * Unsigned-log sanity: the committed ordinary vectors must equal a fresh
 * recomputation from the unsigned transcript records plus the committed fit.
 * This is a pipeline-integrity check, not the treatment test.
 */
export function verifyLv01OrdinaryTranscriptMatch(input: {
  readonly id: Lv01OrdinaryPredictorId;
  readonly fit: Lv01OrdinaryFit;
  readonly inventory: readonly string[];
  readonly records: readonly (Omit<Lv01OrdinaryRecord, 'actualSelectedCandidateIndex'> & { readonly committedDistribution: readonly number[] })[];
}): void {
  if (input.records.length === 0) fail('unsigned-log sanity requires at least one record');
  for (const record of input.records) {
    const { committedDistribution, ...unsigned } = record;
    const recomputed = scoreLv01OrdinaryFit(input.id, input.fit, unsigned, input.inventory);
    if (recomputed.length !== committedDistribution.length || recomputed.some((value, index) => value !== committedDistribution[index])) {
      fail(`ordinary transcript mismatch on case ${record.caseId}`);
    }
  }
}
/** Pure scorer shared by fitted predictors and the pre-action commitment auditor. */
export function scoreLv01OrdinaryFit(id: Lv01OrdinaryPredictorId, fit: Lv01OrdinaryFit, record: Omit<Lv01OrdinaryRecord, 'actualSelectedCandidateIndex'>, inventory: readonly string[]): number[] {
  assertRecord({ ...record, actualSelectedCandidateIndex: 0 }, inventory);
  const normalize = (counts: readonly number[]) => { const total = counts.reduce((a, b) => a + b, 0); return counts.map((x) => x / total); };
  if (id === 'uniform' || fit.kind === 'uniform') {
    if (fit.kind !== 'uniform') fail('uniform ordinary fit is inconsistent');
    return Array.from({ length: CANDIDATES }, () => 1 / CANDIDATES);
  }
  if (fit.kind === 'softmax') {
    if (fit.weights.length !== COEFFICIENTS) fail('softmax ordinary fit has invalid weights');
    return softmax(Array.from({ length: CANDIDATES }, (_, position) => featureIndices(record, position, inventory).reduce((sum, index) => sum + (fit.weights[index] as number), 0)));
  }
  if (fit.marginal.length !== CANDIDATES) fail('count ordinary fit is inconsistent');
  if (id === 'validation-majority') return normalize(fit.marginal);
  const key = record.deliveredToken ?? '<disabled>';
  if (id === 'transcript-only') return normalize(fit.byToken[key] ?? Array.from({ length: CANDIDATES }, () => 1));
  const counts = fit.byTokenType[key] ?? Array.from({ length: TYPES }, () => 1);
  return normalize(record.candidateTypeCodes.map((type) => counts[type]!));
}
function featureIndices(record: Omit<Lv01OrdinaryRecord, 'actualSelectedCandidateIndex'>, position: number, inventory: readonly string[]): number[] {
  const type = record.candidateTypeCodes[position]!; const token = tokenIndex(record.deliveredToken, inventory);
  return [0, 33 + type, 49 + position, ...(token === null ? [] : [1 + token, 53 + token * TYPES + type])];
}
function softmaxModel(role: 'baby-a' | 'baby-b', rows: readonly Lv01OrdinaryRecord[], inventory: readonly string[]): Lv01OrdinaryPredictor {
  const weights = Array.from({ length: COEFFICIENTS }, () => 0);
  for (let step = 0; step < 2000; step += 1) {
    const gradient = Array.from({ length: COEFFICIENTS }, () => 0);
    for (const row of rows) {
      const probabilities = softmax(Array.from({ length: CANDIDATES }, (_, position) => featureIndices(row, position, inventory).reduce((sum, index) => sum + weights[index]!, 0)));
      for (let position = 0; position < CANDIDATES; position += 1) for (const index of featureIndices(row, position, inventory)) gradient[index]! += probabilities[position]! - (position === row.actualSelectedCandidateIndex ? 1 : 0);
    }
    for (let index = 0; index < weights.length; index += 1) weights[index]! -= 0.05 * (gradient[index]! / rows.length + (index === 0 ? 0 : 0.01 * weights[index]!));
  }
  const fit: Lv01OrdinaryFit = { kind: 'softmax', weights: [...weights] };
  return { id: 'ordinary-record-softmax', receiverRole: role, fit, probabilitiesFor: (record) => scoreLv01OrdinaryFit('ordinary-record-softmax', fit, record, inventory) };
}

/** Fit/choose ordinary predictors only on the allowed validation windows. */
export function selectLv01OrdinaryPredictor(input: {
  readonly inventory: readonly string[]; readonly training: readonly Lv01OrdinaryRecord[];
  readonly validationFit: readonly Lv01OrdinaryRecord[]; readonly validationSelection: readonly Lv01OrdinaryRecord[];
}): Lv01OrdinarySelection {
  assertInventory(input.inventory); const combined = [...input.training, ...input.validationFit];
  const role = assertRows(combined, input.inventory); assertRows(input.validationSelection, input.inventory, role);
  const ids = new Set([...combined, ...input.validationSelection].map((row) => row.caseId));
  if (ids.size !== combined.length + input.validationSelection.length) fail('ordinary predictor folds must be disjoint');
  const candidates: Lv01OrdinaryPredictor[] = [
    countModel('uniform', role, [], input.inventory), countModel('validation-majority', role, input.validationFit, input.inventory),
    countModel('transcript-only', role, combined, input.inventory), countModel('task-history', role, combined, input.inventory), softmaxModel(role, combined, input.inventory),
  ];
  const scores = Object.fromEntries(candidates.map((model) => [model.id, meanBrier(model, input.validationSelection)])) as Record<Lv01OrdinaryPredictorId, number>;
  const selectedPredictorId = candidates.reduce((best, model) => scores[model.id] < scores[best.id] - EPS ? model : best).id;
  const refitRows = [...combined, ...input.validationSelection];
  const refit = selectedPredictorId === 'uniform' ? countModel('uniform', role, [], input.inventory) : selectedPredictorId === 'validation-majority' ? countModel(selectedPredictorId, role, refitRows, input.inventory) : selectedPredictorId === 'ordinary-record-softmax' ? softmaxModel(role, refitRows, input.inventory) : countModel(selectedPredictorId, role, refitRows, input.inventory);
  return { selectedPredictorId, validationBrierByPredictor: scores, candidatePredictors: candidates, refitPredictor: refit };
}

/** Labels stay explicit: predictions score actual actions; causal LV-L reads only target probability. */
export interface Lv01PredictionLabel {
  readonly actualSelectedCandidateIndex: number;
  readonly taskTargetCandidateIndex: number;
}
export interface Lv01PredictionComparison {
  readonly candidateTypeCodes: readonly number[];
  readonly nativeDistribution: readonly number[];
  readonly replayDistribution: readonly number[];
  readonly label: Lv01PredictionLabel;
}
export interface Lv01PredictionScores {
  readonly nativeBrier: number; readonly replayBrier: number;
  readonly expectedExcessReplayBrier: number;
  readonly replayTargetActionProbability: number;
}
function assertDistribution(values: readonly number[], label: string): void {
  if (values.length !== CANDIDATES || values.some((x) => !Number.isFinite(x) || x < 0) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-10) fail(`${label} must be a four-candidate probability distribution`);
}
/** Score one pre-outcome prediction once its separate action/target labels are available. */
export function scoreLv01Prediction(input: Lv01PredictionComparison): Lv01PredictionScores {
  if (input.candidateTypeCodes.length !== CANDIDATES || new Set(input.candidateTypeCodes).size !== CANDIDATES) fail('prediction candidate order is invalid');
  assertDistribution(input.nativeDistribution, 'native distribution'); assertDistribution(input.replayDistribution, 'replay distribution');
  const { actualSelectedCandidateIndex: action, taskTargetCandidateIndex: target } = input.label;
  if (!Number.isInteger(action) || action < 0 || action >= CANDIDATES || !Number.isInteger(target) || target < 0 || target >= CANDIDATES) fail('prediction labels are invalid');
  return { nativeBrier: brier(input.nativeDistribution, action), replayBrier: brier(input.replayDistribution, action), expectedExcessReplayBrier: input.nativeDistribution.reduce((sum, value, index) => sum + (value - input.replayDistribution[index]!) ** 2, 0), replayTargetActionProbability: input.replayDistribution[target]! };
}

export const LV01_COMPONENT_IDS = ['incremental', 'fidelity', 'disabled', 'constant', 'random', 'shuffled', 'intervention'] as const;
export type Lv01ComponentId = (typeof LV01_COMPONENT_IDS)[number];
export type Lv01FamilyMemberId = 'LV-U' | 'LV-P' | 'LV-C' | 'LV-L';
const BOUNDARY: Record<Lv01ComponentId, number> = { incremental: 0.02, fidelity: -0.02, disabled: 0.05, constant: 0.05, random: 0.05, shuffled: 0.05, intervention: 0.05 };
export interface Lv01SeedComponentValues { readonly seedId: string; readonly byRole: Readonly<Record<'baby-a' | 'baby-b', Readonly<Partial<Record<Lv01ComponentId, readonly number[]>>>>>; }
export interface Lv01ComponentInterval { readonly marginal95: { readonly lower: number; readonly upper: number }; readonly simultaneousLowerBound: number; readonly degenerate: boolean; }
export interface Lv01FamilyResult { readonly memberPValues: Readonly<Record<Lv01FamilyMemberId, number>>; readonly adjustedPValues: Readonly<Record<Lv01FamilyMemberId, number>>; readonly dispositions: Readonly<Record<Lv01FamilyMemberId, 'supported' | 'not-supported' | 'inconclusive'>>; readonly seedStatistics: Readonly<Record<string, Readonly<Record<Lv01ComponentId, number>>>>; readonly componentIntervals: Readonly<Record<Lv01ComponentId, Lv01ComponentInterval>>; }
/** Equal-role seed reduction plus LV01's fixed component/member/Holm procedure. */
export function analyzeLv01Family(rows: readonly Lv01SeedComponentValues[]): Lv01FamilyResult {
  if (rows.length < 2 || new Set(rows.map((row) => row.seedId)).size !== rows.length) fail('LV01 analysis requires at least two unique seeds');
  const statistics: Record<string, Record<Lv01ComponentId, number>> = {};
  for (const row of rows) {
    const reduced = {} as Record<Lv01ComponentId, number>;
    for (const component of LV01_COMPONENT_IDS) {
      const left = row.byRole['baby-a'][component]; const right = row.byRole['baby-b'][component];
      if (left === undefined || right === undefined || left.length === 0 || right.length === 0 || left.some((x) => !Number.isFinite(x)) || right.some((x) => !Number.isFinite(x))) fail(`LV01 ${component} requires finite values for both roles`);
      reduced[component] = (left.reduce((a, b) => a + b, 0) / left.length + right.reduce((a, b) => a + b, 0) / right.length) / 2;
    }
    statistics[row.seedId] = reduced;
  }
  const tests = Object.fromEntries(LV01_COMPONENT_IDS.map((component) => [component, oneSampleTTest(rows.map((row) => statistics[row.seedId]![component]), BOUNDARY[component], 'greater')])) as Record<Lv01ComponentId, ReturnType<typeof oneSampleTTest>>;
  // Zero-variance components carry no sampling evidence: p = 1 with a flagged
  // interval, and only the member they determine turns inconclusive.
  const componentP = (component: Lv01ComponentId): number => tests[component].degenerate ? 1 : tests[component].p;
  const controlIds: readonly Lv01ComponentId[] = ['disabled', 'constant', 'random', 'shuffled'];
  const controlArgmax = controlIds.reduce((best, id) => componentP(id) > componentP(best) ? id : best);
  const raw: Record<Lv01FamilyMemberId, number> = { 'LV-U': componentP('incremental'), 'LV-P': componentP('fidelity'), 'LV-C': componentP(controlArgmax), 'LV-L': componentP('intervention') };
  const members: readonly Lv01FamilyMemberId[] = ['LV-U', 'LV-P', 'LV-C', 'LV-L'];
  const holm = holmBonferroni(members.map((id) => raw[id]), 0.05);
  const inconclusive: Record<Lv01FamilyMemberId, boolean> = { 'LV-U': tests.incremental.degenerate, 'LV-P': tests.fidelity.degenerate, 'LV-C': tests[controlArgmax].degenerate, 'LV-L': tests.intervention.degenerate };
  const intervals = Object.fromEntries(LV01_COMPONENT_IDS.map((component) => {
    const test = tests[component];
    const marginal = studentTQuantile(0.975, test.df) * test.se;
    const simultaneous = studentTQuantile(1 - 0.05 / LV01_COMPONENT_IDS.length, test.df) * test.se;
    return [component, { marginal95: { lower: test.mean - marginal, upper: test.mean + marginal }, simultaneousLowerBound: test.mean - simultaneous, degenerate: test.degenerate }];
  })) as Record<Lv01ComponentId, Lv01ComponentInterval>;
  return {
    memberPValues: Object.fromEntries(members.map((id) => [id, raw[id]])) as Lv01FamilyResult['memberPValues'],
    adjustedPValues: Object.fromEntries(members.map((id, index) => [id, holm.adjusted[index]!])) as Lv01FamilyResult['adjustedPValues'],
    dispositions: Object.fromEntries(members.map((id, index) => [id, inconclusive[id] ? 'inconclusive' : holm.adjusted[index]! < 0.05 ? 'supported' : 'not-supported'])) as Lv01FamilyResult['dispositions'],
    seedStatistics: statistics,
    componentIntervals: intervals,
  };
}
