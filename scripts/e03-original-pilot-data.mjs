import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function jsonLines(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0 && lines.every((line) => line.length > 0));
  return lines.map((line) => JSON.parse(line));
}

// The caller must first pass both original-bundle integrity verifiers. This
// reconciles the unsigned operational summary against the signed records.
export function reconcileE03OriginalPilotData(bundle, record, condition, runId) {
  const turns = jsonLines(join(bundle, 'turn-records.jsonl'));
  assert.equal(turns.length, 201, `${runId}: original turn-record grain changed`);
  assert.ok(turns.every((turn, index) => turn.runId === runId &&
    turn.sequence === index + 1 && turn.communicationCondition === condition));
  assert.equal(turns[0].phase, 'running');
  assert.equal(turns[0].turn, 0);
  const evaluation = turns.slice(1);
  assert.ok(evaluation.every((turn, index) => turn.phase === 'evaluating' &&
    turn.turn === index + 1 && typeof turn.outcome?.success === 'boolean' &&
    /^sha256:[a-f0-9]{64}$/u.test(turn.scenarioStateHash)));
  const scenarioStateHashes = evaluation.map((turn) => turn.scenarioStateHash);
  const agreements = evaluation.filter((turn) => turn.outcome.success).length;
  assert.deepEqual(record.observations.scenarioStateHashes, scenarioStateHashes,
    `${runId}: unsigned scenario summary differs from signed original records`);
  assert.equal(record.observations.agreements, agreements,
    `${runId}: unsigned agreement summary differs from signed original records`);

  const channel = jsonLines(join(bundle, 'channel-transcript.jsonl'));
  assert.ok(channel.every((event, index) => event.runId === runId &&
    event.sequence === index + 1 && event.communicationCondition === condition));
  assert.equal(record.observations.channelEvents, channel.length);
  const accepted = channel.filter((event) => event.gatewayValidationResult === 'accepted');
  assert.ok(accepted.length > 0);
  assert.equal(record.observations.acceptedChannelEvents, accepted.length,
    `${runId}: unsigned channel count differs from signed original transcript`);
  assert.ok(accepted.every((event) => event.origin ===
    (condition === 'oracle' ? 'gateway-control' : 'baby')));
  assert.ok(accepted.every((event) => (event.deliveryReceipt !== undefined) ===
    (condition !== 'disabled')));
  if (condition === 'constant') {
    assert.equal(new Set(accepted.map((event) => event.publicArtifactHash)).size, 1);
  }
  if (condition === 'random') {
    assert.ok(new Set(accepted.map((event) => event.publicArtifactHash)).size > 1);
  }
  return { scenarioStateHashes, agreements, channelEvents: channel.length,
    acceptedChannelEvents: accepted.length };
}
