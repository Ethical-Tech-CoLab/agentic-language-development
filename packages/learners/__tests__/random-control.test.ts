/**
 * SPEC §9.6 `random`: the control delivers a uniformly drawn message whose
 * length is anywhere in `[1, maxSymbolsPerMessage]`, and §9.6 requires all six
 * conditions to run over "the same scenarios and learner interfaces". A
 * delivered length that differs from the adapter's configured `messageLength`
 * is therefore a legal artifact, and the reference `scratch-rl` adapter must
 * act on it rather than crash: a deterministic adapter failure would be
 * retried once by `NurseryRuntime` (§14.5) and then pause the control run.
 *
 * The contract is: score the delivered prefix the receiver holds tables for,
 * treat missing positions as absent, and record the delivered symbols verbatim
 * in the interpretation event (§8.2).
 */
import { fixedTokenInventory, type RunConfig } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { TabularReinforceAdapter } from '../src/tabular-reinforce.js';

const SYMBOL_INVENTORY_SIZE = 8;
const inventory = fixedTokenInventory(SYMBOL_INVENTORY_SIZE);

const RECEIVER_PAYLOAD = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
];

const CANDIDATE_REFS = ['o:aabbccdd0011', 'o:aabbccdd0022', 'o:aabbccdd0033'];

async function initAdapter(
  messageLength: number,
  maxSymbolsPerMessage: number,
): Promise<{
  adapter: TabularReinforceAdapter;
  ledger: RecordingLedgerClient;
  config: RunConfig;
}> {
  const config = buildConformanceRunConfig('scratch-rl', {
    episodes: 4,
    symbolInventorySize: SYMBOL_INVENTORY_SIZE,
    messageLength: maxSymbolsPerMessage,
  });
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  const adapter = new TabularReinforceAdapter({
    learningRate: 1,
    temperature: 0.5,
    messageLength,
  });
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('scratch-rl'),
    seed: 'seed-random-control',
    symbolInventory: inventory,
    ledger,
  });
  return { adapter, ledger, config };
}

/** One receiver turn: observe, receive `symbols`, then select a candidate. */
async function receiverTurn(
  adapter: TabularReinforceAdapter,
  ledger: RecordingLedgerClient,
  config: RunConfig,
  turn: number,
  symbols: string[],
): Promise<{ interpretation: Record<string, unknown>; intention: Record<string, unknown> }> {
  ledger.turn = turn;
  await adapter.observe({
    runId: config.runId,
    turn,
    recipient: 'baby-a',
    encoding: 'opaque-numeric',
    payload: RECEIVER_PAYLOAD.slice(0, CANDIDATE_REFS.length),
    scenarioRef: 'scn:00112233445566aa',
  });
  const channelEventHash = `sha256:${'c'.repeat(64)}` as const;
  const envelope = await adapter.receive({
    runId: config.runId,
    turn,
    logicalSender: 'baby-b',
    carrier: 'fixed-token',
    publicArtifact: { symbols },
    channelEventHash,
  });
  await ledger.append(envelope.privateLedgerDraft, { channelEventHash });

  const proposal = await adapter.act({
    turn,
    role: 'receiver',
    responseBudgetMs: 1_000,
    availableActions: ['select_object'],
    candidateRefs: CANDIDATE_REFS,
  });
  await ledger.append(proposal.privateLedgerDraft);

  await adapter.onOutcome({
    runId: config.runId,
    turn,
    role: 'receiver',
    success: true,
    reward: 1,
    payload: [1],
  });
  await adapter.updatePolicy({
    runId: config.runId,
    turns: [turn],
    learningSignal: 'extrinsic-task',
  });

  return {
    interpretation: envelope.privateLedgerDraft.content,
    intention: proposal.privateLedgerDraft.content,
  };
}

describe('scratch-rl receiver under the SPEC §9.6 random control', () => {
  it('acts on a message longer than its configured messageLength', async () => {
    const { adapter, ledger, config } = await initAdapter(1, 4);
    const delivered = [
      inventory[2] as string,
      inventory[5] as string,
      inventory[7] as string,
    ];

    const { interpretation, intention } = await receiverTurn(
      adapter,
      ledger,
      config,
      1,
      delivered,
    );

    // The interpretation event records what was actually delivered (§8.2),
    // not the truncated prefix the policy could score.
    expect(interpretation.symbols).toEqual(delivered);
    expect(intention.symbols).toEqual(delivered);
    expect(intention.associationWeights as number[]).toHaveLength(
      CANDIDATE_REFS.length,
    );
    expect(CANDIDATE_REFS).toContain(proposalSelection(intention));
    // Only the prefix has a receiver table, so only the prefix is credited.
    const policy = adapter.exportPolicy();
    expect(policy.thetaReceiver).toHaveLength(1);
    expect(policy.thetaReceiver[0]?.[2]?.some((logit) => logit !== 0)).toBe(true);
    expect(policy.thetaReceiver[0]?.[5]?.every((logit) => logit === 0)).toBe(
      true,
    );
  });

  it('acts on a message shorter than its configured messageLength', async () => {
    const { adapter, ledger, config } = await initAdapter(2, 4);
    const delivered = [inventory[3] as string];

    const { interpretation, intention } = await receiverTurn(
      adapter,
      ledger,
      config,
      1,
      delivered,
    );

    expect(interpretation.symbols).toEqual(delivered);
    expect(intention.symbols).toEqual(delivered);
    expect(CANDIDATE_REFS).toContain(proposalSelection(intention));
    // Position 0 was delivered and credited; position 1 was absent, so its
    // table is untouched.
    const policy = adapter.exportPolicy();
    expect(policy.thetaReceiver).toHaveLength(2);
    expect(policy.thetaReceiver[0]?.[3]?.some((logit) => logit !== 0)).toBe(true);
    expect(
      policy.thetaReceiver[1]?.flat().every((logit) => logit === 0),
    ).toBe(true);
  });

  it('still refuses a delivered symbol outside the inventory', async () => {
    const { adapter, ledger, config } = await initAdapter(1, 4);
    await expect(
      receiverTurn(adapter, ledger, config, 1, ['S99']),
    ).rejects.toThrow(/not in the inventory/u);
  });
});

function proposalSelection(content: Record<string, unknown>): string {
  return content.selection as string;
}
