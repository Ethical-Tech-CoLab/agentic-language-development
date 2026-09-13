import { describe, expect, it } from 'vitest';
import { ReferentialScenarioEngine, hashObservation } from '@ald/scenario';
// @ts-expect-error The qualification helper is executable ESM.
import { E02_LABELS, auditE02Rows, e02Features, e02Split } from '../../deploy/mode-r/e02-observation-analysis.mjs';

// Synthetic unit-test fixtures only; these are not delivered run observations.
const engine = new ReferentialScenarioEngine({ version: 1,
  symbolInventory: Array.from({ length: 32 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`) }, 'e02-unit-fixture');
const instances: Record<string, ReturnType<typeof engine.generate>> = {};
const records: any[] = [];
const rows = Array.from({ length: 816 }, (_, turn) => {
  const roles = turn % 2 === 0
    ? { sender: 'baby-a' as const, receiver: 'baby-b' as const }
    : { sender: 'baby-b' as const, receiver: 'baby-a' as const };
  const instance = engine.generate(turn, 'train', roles);
  instances[instance.scenarioRef] = instance;
  const observation = engine.observationFor(instance, 'e02-unit', turn, 'baby-a');
  const truth = instance.groundTruth as any;
  records.push({ runId: 'e02-unit', turn, phase: 'running', roles, scenarioRef: instance.scenarioRef,
    scenarioStateHash: instance.stateHash, observationHashes: { babyA: hashObservation(observation) } });
  return { observation, delivered: true, stage: 'before-restore', observeDurationMs: 0.2,
    budget: { turn, role: roles.sender === 'baby-a' ? 'sender' : 'receiver', responseBudgetMs: 1000,
      availableActions: roles.sender === 'baby-a' ? ['emit_symbols'] : ['select_object'],
      ...(roles.receiver === 'baby-a' ? { candidateRefs: instance.candidateRefs } : {}) },
    label: E02_LABELS[truth.attributeCodes[String(truth.targetTypeCode)][0]] };
});

describe('E02 actual-observation analysis contracts', () => {
  it('reconciles exact rows to their turn and scenario commitments', () => {
    expect(() => auditE02Rows(rows, 'baby-a', 'before-restore', records, instances)).not.toThrow();
  });
  it('keeps sensory values out of identifier and timing features', () => {
    const changed = structuredClone(rows[0])!;
    changed.observation.payload = (changed.observation.payload as number[][]).map((line) => line.map(() => 3));
    expect(e02Features(changed, 'identifier')).toEqual(e02Features(rows[0], 'identifier'));
    expect(e02Features(changed, 'timing')).toEqual(e02Features(rows[0], 'timing'));
  });
  it('keeps labels out of every feature vector', () => {
    const changed = { ...rows[0], label: 'planted-offline-label' };
    for (const probe of ['metadata', 'identifier', 'timing']) {
      expect(e02Features(changed, probe)).toEqual(e02Features(rows[0], probe));
    }
  });
  it('rejects a changed target mapping even if the offline label is changed to agree', () => {
    const altered = structuredClone(instances);
    const changed = structuredClone(rows);
    const truth = altered[changed[0]!.observation.scenarioRef]!.groundTruth as any;
    const attributes = truth.attributeCodes[String(truth.targetTypeCode)];
    attributes[0] = (attributes[0] + 1) % 4;
    changed[0]!.label = E02_LABELS[attributes[0]];
    expect(() => auditE02Rows(changed, 'baby-a', 'before-restore', records, altered)).toThrow();
  });
  it('rejects an invented scenario digest even if the supplied turn record agrees', () => {
    const altered = structuredClone(instances);
    const changedRecords = structuredClone(records);
    const ref = rows[0]!.observation.scenarioRef;
    altered[ref]!.stateHash = `sha256:${'0'.repeat(64)}`;
    changedRecords[0].scenarioStateHash = altered[ref]!.stateHash;
    expect(() => auditE02Rows(rows, 'baby-a', 'before-restore', changedRecords, altered)).toThrow();
  });
  it('retains a disjoint deterministic split with at least 200 test rows', () => {
    const split = e02Split(rows, 'e02-unit-analysis');
    expect(split).toEqual(e02Split(rows, 'e02-unit-analysis'));
    expect(split.test.length).toBeGreaterThanOrEqual(200);
    expect(new Set([...split.train, ...split.test]).size).toBe(816);
  });
  it('supports the worst four-class rounding at 816 rows but rejects an underpowered 800-row split', () => {
    const labels = (counts: number[]) => counts.flatMap((count, i) => Array.from({ length: count }, () => ({ label: E02_LABELS[i] })));
    expect(e02Split(labels([203, 203, 203, 207]), 'rounding').test.length).toBe(201);
    expect(() => e02Split(labels([199, 199, 199, 203]), 'rounding')).toThrow();
  });
  const mutations = [
    ['missing row', (r: any[]) => { r.pop(); }],
    ['duplicate row', (r: any[]) => { r[1] = r[0]; }],
    ['false delivery', (r: any[]) => { r[0].delivered = false; }],
    ['string delivery', (r: any[]) => { r[0].delivered = 'true'; }],
    ['wrong role', (r: any[]) => { r[0].observation.recipient = 'baby-b'; }],
    ['wrong stage', (r: any[]) => { r[0].stage = 'after-restore'; }],
    ['changed observation', (r: any[]) => { r[0].observation.payload[0][0] += 1; }],
    ['changed target label', (r: any[]) => { r[0].label = 'wrong'; }],
    ['negative duration', (r: any[]) => { r[0].observeDurationMs = -1; }],
    ['missing duration', (r: any[]) => { r[0].observeDurationMs = null; }],
    ['unknown budget field', (r: any[]) => { r[0].budget.target = 1; }],
    ['undeclared action', (r: any[]) => { r[0].budget.availableActions = ['tool']; }],
    ['wrong turn budget', (r: any[]) => { r[0].budget.turn += 1; }],
    ['shortened deadline', (r: any[]) => { r[0].budget.responseBudgetMs = 100; }],
    ['semantic object ID', (r: any[]) => { r[1].budget.candidateRefs[0] = 'red'; }],
    ['duplicate candidate', (r: any[]) => { r[1].budget.candidateRefs[1] = r[1].budget.candidateRefs[0]; }],
  ] as const;
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const changed = structuredClone(rows);
    mutate(changed);
    expect(() => auditE02Rows(changed, 'baby-a', 'before-restore', records, instances)).toThrow();
  });
});
