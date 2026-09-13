import assert from 'node:assert/strict';
import { SeededPrng, canonicalJson, hashCanonical } from '@ald/hashing';
import { evaluateSemanticLeakage } from '@ald/leakage';
import { assertObservationHygiene, hashObservation } from '@ald/scenario';
import { HASH_DOMAINS } from '@ald/types';

export const E02_ROWS_PER_STAGE = 816;
export const E02_REGISTERED_ROWS_PER_STAGE = 2016;
export const E02_ANALYSIS_VERSION = 'e02-observation-qualification-v1';
export const E02_REGISTERED_ANALYSIS_VERSION = 'e02-observation-qualification-v2';
export const E02_PROBES = ['metadata', 'identifier', 'timing'];
export const E02_LABELS = ['red', 'green', 'blue', 'yellow'];

// Offline labels never enter the learner observation or configuration.
// Sensory values, target flags, type codes and outcome success are NOT features.
function checkSampleCount(sampleCount) {
  assert.ok([E02_ROWS_PER_STAGE, E02_REGISTERED_ROWS_PER_STAGE].includes(sampleCount));
}

export function e02Features(row, probe, sampleCount = E02_ROWS_PER_STAGE) {
  checkSampleCount(sampleCount);
  const { observation, budget } = row;
  assertObservationHygiene(observation);
  assert.deepEqual(Object.keys(observation).sort(), ['encoding', 'payload', 'recipient', 'runId', 'scenarioRef', 'turn']);
  assert.equal(observation.encoding, 'opaque-numeric');
  assert.deepEqual(Object.keys(budget).sort(), budget.role === 'receiver'
    ? ['availableActions', 'candidateRefs', 'responseBudgetMs', 'role', 'turn']
    : ['availableActions', 'responseBudgetMs', 'role', 'turn']);
  assert.equal(budget.turn, observation.turn);
  assert.ok(['sender', 'receiver'].includes(budget.role));
  assert.equal(budget.responseBudgetMs, 1000);
  assert.deepEqual(budget.availableActions, budget.role === 'receiver' ? ['select_object'] : ['emit_symbols']);
  const refs = budget.candidateRefs ?? [];
  assert.equal(refs.length, budget.role === 'receiver' ? 4 : 0);
  assert.equal(new Set(refs).size, refs.length);
  const hex = (value, prefix, length) => {
    assert.equal(typeof value, 'string');
    assert.match(value, new RegExp(`^${prefix}[a-f0-9]{${length}}$`, 'u'));
    return [...value.slice(prefix.length)].map((nibble) => parseInt(nibble, 16) / 15);
  };
  const identifiers = [...hex(observation.scenarioRef, 'scn:', 16),
    ...Array.from({ length: 4 }, (_, index) => refs[index] === undefined
      ? Array(12).fill(0) : hex(refs[index], 'o:', 12)).flat()];
  assert.ok(Number.isFinite(row.observeDurationMs) && row.observeDurationMs >= 0);
  if (probe === 'identifier') return identifiers;
  if (probe === 'timing') return [Math.log1p(row.observeDurationMs)];
  assert.equal(probe, 'metadata');
  const payload = observation.payload;
  assert.equal(payload.length, 4);
  assert.ok(payload.every((entry) => Array.isArray(entry) && entry.every(Number.isFinite)));
  return [observation.turn / (2 * sampleCount), budget.role === 'receiver' ? 1 : 0,
    payload.length / 4, ...payload.map((entry) => entry.length / 4),
    Buffer.byteLength(canonicalJson(observation)) / 1024,
    budget.availableActions.length / 4, refs.length / 4, ...identifiers];
}

export function auditE02Rows(rows, role, stage, turnRecords, instances, sampleCount = E02_ROWS_PER_STAGE) {
  checkSampleCount(sampleCount);
  assert.ok(['baby-a', 'baby-b'].includes(role));
  assert.ok(['before-restore', 'after-restore'].includes(stage));
  assert.equal(rows.length, sampleCount);
  const offset = stage === 'before-restore' ? 0 : sampleCount;
  const recordByTurn = new Map(turnRecords.map((record) => [record.turn, record]));
  assert.equal(recordByTurn.size, turnRecords.length);
  const refs = new Set();
  for (const [index, row] of rows.entries()) {
    const observation = row.observation;
    assert.equal(observation.recipient, role);
    assert.equal(observation.turn, index + offset);
    assert.equal(row.stage, stage);
    assert.equal(row.delivered, true);
    assert.equal(refs.has(observation.scenarioRef), false);
    refs.add(observation.scenarioRef);
    const record = recordByTurn.get(observation.turn);
    assert.ok(record);
    assert.equal(record.runId, observation.runId);
    assert.equal(record.scenarioRef, observation.scenarioRef);
    assert.equal(record.phase, 'running');
    assert.equal(row.budget.role, record.roles.sender === role ? 'sender' : 'receiver');
    assert.equal(record.observationHashes[role === 'baby-a' ? 'babyA' : 'babyB'], hashObservation(observation));
    const instance = instances[observation.scenarioRef];
    assert.ok(instance);
    assert.equal(instance.stateHash, hashCanonical(HASH_DOMAINS.scenarioState, {
      scenarioRef: instance.scenarioRef, groundTruth: instance.groundTruth, observations: instance.observations,
    }));
    assert.equal(record.scenarioStateHash, instance.stateHash);
    const truth = instance.groundTruth;
    assert.equal(row.label, E02_LABELS[truth.attributeCodes[String(truth.targetTypeCode)][0]]);
    assert.deepEqual(observation.payload, instance.observations[role]);
    assert.deepEqual(row.budget.candidateRefs ?? [], row.budget.role === 'receiver' ? instance.candidateRefs : []);
    for (const probe of E02_PROBES) e02Features(row, probe, sampleCount);
  }
  assert.equal(new Set(rows.map((row) => row.label)).size, 4);
}

// Reproduce the existing estimator's declared stratified split for inspection.
// This uses the same PRNG; it is not an independent statistical implementation.
export function e02Split(rows, seed, sampleCount = E02_ROWS_PER_STAGE) {
  checkSampleCount(sampleCount);
  const labels = [...new Set(rows.map((row) => row.label))].sort();
  assert.equal(labels.length, 4);
  const train = [], test = [];
  for (const [labelIndex, label] of labels.entries()) {
    const indices = rows.flatMap((row, index) => row.label === label ? [index] : []);
    assert.ok(indices.length >= 4);
    const shuffled = new SeededPrng(`${seed}/split/${labelIndex}`).shuffle(indices);
    const count = Math.floor(indices.length / 4);
    test.push(...shuffled.slice(0, count));
    train.push(...shuffled.slice(count));
  }
  assert.equal(new Set([...train, ...test]).size, rows.length);
  assert.ok(test.length >= (sampleCount === E02_REGISTERED_ROWS_PER_STAGE ? 501 : 200));
  return { train, test };
}

export function evaluateE02Probe(rows, provenance, seed, probe, sampleCount = E02_ROWS_PER_STAGE) {
  checkSampleCount(sampleCount);
  assert.equal(rows.length, sampleCount);
  assert.equal(provenance.track, 'scratch-rl');
  const split = e02Split(rows, seed, sampleCount);
  const input = { provenance,
    frozenFeatures: rows.map((row) => ({ label: row.label, features: e02Features(row, probe, sampleCount) })),
    preRegistration: { seed, confidence: 0.95, permutations: 20,
      maximumAccuracyAdvantage: 0.1, minimumTestRows: sampleCount === E02_REGISTERED_ROWS_PER_STAGE ? 501 : 200,
      positiveControlMinimumAdvantage: 0.2 } };
  const result = evaluateSemanticLeakage(input);
  assert.equal(result.linearProbe.trainRows, split.train.length);
  assert.equal(result.linearProbe.testRows, split.test.length);
  return { probe, input, split, result, passed: result.classification === 'strict-ungrounded-eligible'
    && result.linearProbe.negativeBoundDecision === 'below-bound' && result.linearProbe.positiveControl.detected };
}
