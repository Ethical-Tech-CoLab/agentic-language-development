import { describe, expect, it } from 'vitest';

import { harness, intentionDraft, symbolEnvelope, turn } from './support.js';

function taskEnvelope(objectRef = 'o:1') {
  return {
    proposal: { kind: 'select_object' as const, publicArtifact: { objectRef } },
    privateLedgerDraft: intentionDraft(),
  };
}

describe('Gateway-owned receiver task action', () => {
  it('limits Controller-originated ledger appends to lifecycle event types', async () => {
    const { gateway, evidence, context } = harness();
    await gateway.appendLifecycleLedgerEvent(2, 'baby-a', intentionDraft({
      eventType: 'policy.checkpointed',
      subjectId: 'policy',
      content: { policyCheckpointRef: 'policy:one' },
    }));
    await gateway.appendLifecycleLedgerEvent(3, 'baby-b', intentionDraft({
      eventType: 'run.sealed',
      subjectId: 'run',
      content: { checkpointRef: 'checkpoint:one' },
    }));
    expect(evidence.ledgerEvents(context.runId, 'A').map((event) => event.eventType))
      .toEqual(['policy.checkpointed']);
    expect(evidence.ledgerEvents(context.runId, 'B').map((event) => event.eventType))
      .toEqual(['run.sealed']);
    await expect(gateway.appendLifecycleLedgerEvent(4, 'baby-a', intentionDraft()))
      .rejects.toThrow(/not permitted/u);
    await expect(gateway.appendLifecycleLedgerEvent(-1, 'baby-a', intentionDraft({
      eventType: 'run.sealed', content: { checkpointRef: 'checkpoint:one' },
    }))).rejects.toThrow(/nonnegative/u);
    expect(evidence.ledgerEvents(context.runId, 'A')).toHaveLength(1);
  });

  it('appends only a valid receiver intention and returns the parsed task action', async () => {
    const { gateway, evidence, context } = harness();
    const action = await gateway.submitReceiverTaskAction(turn(), 'baby-b', taskEnvelope());
    expect(action).toEqual({ kind: 'select_object', publicArtifact: { objectRef: 'o:1' } });
    expect(evidence.ledgerEvents(context.runId, 'B')).toHaveLength(1);
    expect(evidence.ledgerEvents(context.runId, 'B')[0]?.eventType).toBe('intention.recorded');
    expect(evidence.channelEvents(context.runId)).toHaveLength(0);
  });

  it('refuses malformed, wrong-kind, wrong-draft, and wrong-role actions', async () => {
    const { gateway, evidence, context } = harness();
    expect(await gateway.submitReceiverTaskAction(turn(), 'baby-b', undefined)).toBeNull();
    expect(await gateway.submitReceiverTaskAction(
      turn(), 'baby-b', symbolEnvelope(['S01']),
    )).toBeNull();
    expect(await gateway.submitReceiverTaskAction(turn(), 'baby-b', {
      ...taskEnvelope(),
      privateLedgerDraft: intentionDraft({ eventType: 'hypothesis.created' }),
    })).toBeNull();
    await expect(gateway.submitReceiverTaskAction(turn(), 'baby-a', taskEnvelope()))
      .rejects.toThrow(/role does not match/u);
    expect(evidence.ledgerEvents(context.runId, 'B')).toHaveLength(0);
    expect(evidence.channelEvents(context.runId)).toHaveLength(0);
  });
});
