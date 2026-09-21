import { afterEach, describe, expect, it, vi } from 'vitest';

import { senderForTurn } from '../src/index.js';
import { createHarness, noLearningOverrides, testConfig, type Harness } from './helpers.js';

describe('receiver task action through the Gateway', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('forfeits a wrong-kind receiver action without appending its intention', async () => {
    harness = await createHarness();
    const runId = 'run-receiver-task-gateway';
    const config = testConfig(noLearningOverrides({
      runId,
      experimentId: 'E03',
      randomSeed: 'ald-receiver-task-gateway',
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
    }));
    await harness.runtime.createRun(config);
    const receiver = senderForTurn(0, config.roleReversalPeriod) === 'baby-a'
      ? 'baby-b' : 'baby-a';
    const adapter = harness.runtime.adaptersFor(runId)[receiver];
    const originalAct = adapter.act.bind(adapter);
    vi.spyOn(adapter, 'act').mockImplementation(async (budget) => {
      const envelope = await originalAct(budget);
      return budget.role === 'receiver'
        ? {
            ...envelope,
            proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
          }
        : envelope;
    });

    const result = await harness.runtime.step(runId);
    expect(result.outcome.details).toMatchObject({ reasonCode: 'invalid-task-action' });
    expect(harness.runtime.auditLog(runId).some((event) =>
      event.reasonCode === 'invalid-task-action')).toBe(true);
    const ledger = receiver === 'baby-a'
      ? harness.runtime.ledgers(runId).babyA
      : harness.runtime.ledgers(runId).babyB;
    expect(ledger.some((event) => event.eventType === 'intention.recorded')).toBe(false);
  });
});
