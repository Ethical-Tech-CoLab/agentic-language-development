import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileE03OriginalPilotData } from '../e03-original-pilot-data.mjs';

const directories: string[] = [];
const hash = `sha256:${'a'.repeat(64)}`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-original-pilot-data-'));
  directories.push(directory);
  const bundle = join(directory, 'bundle');
  mkdirSync(bundle);
  const turns = Array.from({ length: 201 }, (_, index) => ({
    runId: 'e03-pilot-disabled-s001', sequence: index + 1,
    communicationCondition: 'disabled', phase: index === 0 ? 'running' : 'evaluating',
    turn: index, scenarioStateHash: hash, outcome: { success: index === 1 },
  }));
  const channel = [{ runId: 'e03-pilot-disabled-s001', sequence: 1,
    communicationCondition: 'disabled', gatewayValidationResult: 'accepted',
    origin: 'baby', publicArtifactHash: hash }];
  writeFileSync(join(bundle, 'turn-records.jsonl'),
    `${turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`);
  writeFileSync(join(bundle, 'channel-transcript.jsonl'),
    `${channel.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const record = { observations: { scenarioStateHashes: Array(200).fill(hash),
    agreements: 1, channelEvents: 1, acceptedChannelEvents: 1 } };
  return { bundle, turns, record };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('verified original E03 pilot data reconciliation', () => {
  it('derives the success tally from the exact evaluation-turn grain', () => {
    const { bundle, record } = fixture();
    expect(reconcileE03OriginalPilotData(bundle, record, 'disabled',
      'e03-pilot-disabled-s001').agreements).toBe(1);
  });

  it('rejects an unsigned summary tally that contradicts the signed original', () => {
    const { bundle, record } = fixture();
    record.observations.agreements = 2;
    expect(() => reconcileE03OriginalPilotData(bundle, record, 'disabled',
      'e03-pilot-disabled-s001')).toThrow(/unsigned agreement summary/u);
  });

  it('rejects duplicate or missing evaluation-turn keys', () => {
    const { bundle, turns, record } = fixture();
    turns[200].turn = 199;
    writeFileSync(join(bundle, 'turn-records.jsonl'),
      `${turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`);
    expect(() => reconcileE03OriginalPilotData(bundle, record, 'disabled',
      'e03-pilot-disabled-s001')).toThrow();
  });
});
