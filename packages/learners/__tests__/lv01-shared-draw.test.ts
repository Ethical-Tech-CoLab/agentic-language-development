/** LV01 shared action draw: the receiver selects by inverse CDF over the shared draw. */
import { drawIndexFromUnit } from '@ald/hashing';
import { fixedTokenInventory, type RunConfig } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { RecordingLedgerClient, buildConformanceRunConfig } from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { TabularReinforceAdapter } from '../src/tabular-reinforce.js';

const inventory = fixedTokenInventory(8);
const CANDIDATE_REFS = ['o:aabbccdd0011', 'o:aabbccdd0022', 'o:aabbccdd0033'];

async function initAdapter(seed: string): Promise<{
  adapter: TabularReinforceAdapter;
  config: RunConfig;
}> {
  const config = buildConformanceRunConfig('scratch-rl', {
    episodes: 4,
    symbolInventorySize: 8,
    messageLength: 1,
  });
  const adapter = new TabularReinforceAdapter({
    learningRate: 1,
    temperature: 0.5,
    messageLength: 1,
  });
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('scratch-rl'),
    seed,
    symbolInventory: inventory,
    ledger: new RecordingLedgerClient(config.runId, 'baby-a'),
  });
  return { adapter, config };
}

async function receiverSelect(
  adapter: TabularReinforceAdapter,
  config: RunConfig,
  sharedActionDrawU?: number,
): Promise<{ ref: string; probs: number[] }> {
  await adapter.observe({
    runId: config.runId,
    turn: 0,
    recipient: 'baby-a',
    encoding: 'opaque-numeric',
    payload: [[0, 0], [1, 1], [2, 2]],
    scenarioRef: 'scn:00112233445566aa',
  });
  await adapter.receive({
    runId: config.runId,
    turn: 0,
    logicalSender: 'baby-b',
    carrier: 'fixedtoken',
    publicArtifact: { symbols: [inventory[1] as string] },
    channelEventHash: `sha256:${'c'.repeat(64)}`,
  });
  const envelope = await adapter.act({
    turn: 0,
    role: 'receiver',
    responseBudgetMs: 1_000,
    availableActions: ['select_object'],
    candidateRefs: CANDIDATE_REFS,
    ...(sharedActionDrawU === undefined ? {} : { sharedActionDrawU }),
  });
  const proposal = envelope.proposal as { publicArtifact: { objectRef: string } };
  return { ref: proposal.publicArtifact.objectRef, probs: [...(envelope.selectionProbs ?? [])] };
}

describe('LV01 shared receiver draw', () => {
  it('selects by inverse CDF over the shared draw and discloses the vector', async () => {
    for (const seed of ['seed-one', 'seed-two']) {
      const { adapter, config } = await initAdapter(seed);
      const { ref, probs } = await receiverSelect(adapter, config, 0.62);
      expect(probs).toHaveLength(CANDIDATE_REFS.length);
      expect(CANDIDATE_REFS[drawIndexFromUnit(probs, 0.62)]).toBe(ref);
    }
  });

  it('reproduces the selection from the disclosed draw and vector', async () => {
    const { adapter, config } = await initAdapter('seed-repro');
    const first = await receiverSelect(adapter, config, 0.05);
    const { adapter: twin, config: twinConfig } = await initAdapter('seed-repro');
    const second = await receiverSelect(twin, twinConfig, 0.95);
    expect(first.probs).toEqual(second.probs);
    expect(CANDIDATE_REFS[drawIndexFromUnit(first.probs, 0.05)]).toBe(first.ref);
    expect(CANDIDATE_REFS[drawIndexFromUnit(second.probs, 0.95)]).toBe(second.ref);
  });

  it('rejects draws outside [0, 1)', async () => {
    const { adapter, config } = await initAdapter('seed-bad');
    await expect(receiverSelect(adapter, config, 1)).rejects.toThrow(/\[0, 1\)/u);
  });

  it('keeps the private stream when no shared draw is bound', async () => {
    const { adapter, config } = await initAdapter('seed-private');
    const { ref, probs } = await receiverSelect(adapter, config);
    expect(CANDIDATE_REFS).toContain(ref);
    expect(probs).toHaveLength(CANDIDATE_REFS.length);
  });
});
