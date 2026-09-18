import assert from 'node:assert/strict';
import { deriveSeedHex } from '@ald/hashing';

const conditions = ['disabled', 'constant', 'random', 'shuffled', 'normal', 'oracle'];

function groupBySlot(runs) {
  const slots = new Map();
  for (const run of runs) {
    const group = slots.get(run.slot) ?? [];
    group.push(run);
    slots.set(run.slot, group);
  }
  return slots;
}

function validateRegistration(registered) {
  assert.equal(registered.length, 168, 'E03 full registration must contain 168 potential runs');
  assert.equal(new Set(registered.map((run) => run.config.runId)).size, 168,
    'E03 full registration repeats a run ID');
  const slots = groupBySlot(registered);
  for (let slot = 1; slot <= 28; slot += 1) {
    const group = slots.get(slot) ?? [];
    assert.equal(group.length, 6, `E03 full slot ${slot} must contain six conditions`);
    assert.deepEqual(group.map((run) => run.condition).sort(), [...conditions].sort(),
      `E03 full slot ${slot} has the wrong condition matrix`);
    assert.ok(group.every((run) => run.use === (slot <= 25 ? 'primary' : 'reserve')),
      `E03 full slot ${slot} has the wrong primary/reserve class`);
  }
  return slots;
}

function validateAttempt(attempt, registrationById) {
  const registered = registrationById.get(attempt.runId);
  assert.ok(registered, `${attempt.runId}: attempt is not registered`);
  assert.equal(attempt.slot, registered.slot, `${attempt.runId}: slot binding changed`);
  assert.equal(attempt.condition, registered.condition, `${attempt.runId}: condition binding changed`);
  assert.equal(attempt.use, registered.use, `${attempt.runId}: use binding changed`);
  assert.equal(typeof attempt.valid, 'boolean', `${attempt.runId}: validity is unresolved`);
}

export function deriveE03FullAnalysisSeed(registered) {
  assert.equal(registered.length, 168,
    'E03 full analysis seed requires the exact 168-run registration');
  const seeds = registered.map((run) => run.config.seedBindings?.analysis);
  assert.ok(seeds.every((seed) => typeof seed === 'string') && new Set(seeds).size === 168,
    'E03 full analysis seed requires 168 distinct registered analysis seeds');
  return deriveSeedHex('e03-full-statistical-analysis-v1', ...seeds);
}

/**
 * Select the only next batch allowed by the prospective paired-reserve rule.
 * Primary runs are single-run batches in packet order. A reserve is always a
 * complete six-condition scenario slot. `done` can mean complete or exhausted;
 * the terminal reconciler determines which without inventing an outcome.
 */
export function nextE03FullCollectorBatch(registered, attempted) {
  const slots = validateRegistration(registered);
  const registrationById = new Map(registered.map((run) => [run.config.runId, run]));
  const attemptsById = new Map();
  for (const attempt of attempted) {
    validateAttempt(attempt, registrationById);
    assert.equal(attemptsById.has(attempt.runId), false, `${attempt.runId}: duplicate attempt`);
    attemptsById.set(attempt.runId, attempt);
  }

  const primaries = registered.filter((run) => run.use === 'primary');
  const nextPrimary = primaries.find((run) => !attemptsById.has(run.config.runId));
  if (nextPrimary) {
    assert.equal(attempted.some((attempt) => attempt.use === 'reserve'), false,
      'reserve collection cannot begin before every primary attempt');
    return { state: 'collect-primary', runs: [nextPrimary] };
  }

  const invalidPrimarySlots = [];
  for (let slot = 1; slot <= 25; slot += 1) {
    const group = slots.get(slot);
    assert.ok(group.every((run) => attemptsById.has(run.config.runId)),
      `primary slot ${slot} is incomplete`);
    if (group.some((run) => attemptsById.get(run.config.runId).valid === false)) {
      invalidPrimarySlots.push(slot);
    }
  }

  let validReserveSlots = 0;
  let nextReserveSlot = 26;
  for (let slot = 26; slot <= 28; slot += 1) {
    const group = slots.get(slot);
    const rows = group.map((run) => attemptsById.get(run.config.runId));
    const count = rows.filter(Boolean).length;
    if (count === 0) {
      const laterAttempted = registered.some((run) => run.slot > slot && run.use === 'reserve' &&
        attemptsById.has(run.config.runId));
      assert.equal(laterAttempted, false, 'reserve slots must be attempted in order');
      nextReserveSlot = slot;
      break;
    }
    assert.equal(count, 6, `reserve slot ${slot} is only partially attempted`);
    assert.equal(slot, nextReserveSlot, 'reserve slots must be attempted in order');
    if (rows.every((row) => row.valid)) validReserveSlots += 1;
    nextReserveSlot = slot + 1;
  }

  if (validReserveSlots >= invalidPrimarySlots.length) {
    return { state: 'done', runs: [], invalidPrimarySlots, validReserveSlots,
      reserveExhausted: false };
  }
  if (nextReserveSlot > 28) {
    return { state: 'done', runs: [], invalidPrimarySlots, validReserveSlots,
      reserveExhausted: true };
  }
  return { state: 'collect-reserve', runs: slots.get(nextReserveSlot),
    invalidPrimarySlots, validReserveSlots };
}
