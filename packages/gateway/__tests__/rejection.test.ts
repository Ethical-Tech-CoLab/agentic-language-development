/**
 * ALD-034: the protocol-independent rejection framework — consistent shape,
 * append-only `channel.rejected` events with no raw content, the consecutive
 * rejection counter, and the automatic pause at the configured ceiling
 * (SPEC §9.4, §14.5).
 */
import { describe, expect, it } from 'vitest';

import { ChannelEventSchema } from '@ald/types';

import {
  GATEWAY_ACTOR_ID,
  MAX_CONSECUTIVE_REJECTIONS_REASON,
} from '../src/symbol-gateway.js';
import { asEnvelope, harness, symbolEnvelope, turn } from './support.js';

const BAD = ['S99'];

describe('rejection behaviour (SPEC §9.4, ALD-034)', () => {
  it('counts consecutive rejections and requests a pause at the default of five', async () => {
    const { gateway, evidence, context } = harness();
    expect(context.config.maxConsecutiveRejections).toBe(5);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await gateway.submitProposal(
        turn({ turn: attempt }),
        symbolEnvelope(BAD),
      );
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') {
        return;
      }
      expect(result.consecutiveRejections).toBe(attempt);
      expect(result.pauseRequested).toBe(false);
      expect(gateway.consecutiveRejections()).toBe(attempt);
    }
    expect(evidence.interventionEvents(context.runId)).toHaveLength(0);

    const fifth = await gateway.submitProposal(
      turn({ turn: 5 }),
      symbolEnvelope(BAD),
    );
    expect(fifth.kind).toBe('rejected');
    if (fifth.kind !== 'rejected') {
      return;
    }
    expect(fifth.consecutiveRejections).toBe(5);
    expect(fifth.pauseRequested).toBe(true);

    const interventions = evidence.interventionEvents(context.runId);
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.eventType).toBe('safety-trigger');
    expect(interventions[0]?.actorId).toBe(GATEWAY_ACTOR_ID);
    expect(interventions[0]?.reasonCode).toBe(
      MAX_CONSECUTIVE_REJECTIONS_REASON,
    );
    expect(interventions[0]?.details.consecutiveRejections).toBe(5);
    // The audit entry names the reason code, never the attempted content.
    expect(JSON.stringify(interventions[0])).not.toContain('S99');
  });

  it('honours a lower configured ceiling', async () => {
    const { gateway } = harness({ maxConsecutiveRejections: 2 });
    const first = await gateway.submitProposal(turn(), symbolEnvelope(BAD));
    const second = await gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(BAD),
    );
    expect(first.kind === 'rejected' && first.pauseRequested).toBe(false);
    expect(second.kind === 'rejected' && second.pauseRequested).toBe(true);
  });

  it('resets the counter after an accepted proposal', async () => {
    const { gateway } = harness();
    await gateway.submitProposal(turn(), symbolEnvelope(BAD));
    await gateway.submitProposal(turn({ turn: 2 }), symbolEnvelope(BAD));
    expect(gateway.consecutiveRejections()).toBe(2);

    const accepted = await gateway.submitProposal(
      turn({ turn: 3 }),
      symbolEnvelope(['S01']),
    );
    expect(accepted.kind).toBe('accepted');
    expect(gateway.consecutiveRejections()).toBe(0);

    const next = await gateway.submitProposal(
      turn({ turn: 4 }),
      symbolEnvelope(BAD),
    );
    expect(next.kind === 'rejected' && next.consecutiveRejections).toBe(1);
  });

  it('resets the counter on request', async () => {
    const { gateway } = harness();
    await gateway.submitProposal(turn(), symbolEnvelope(BAD));
    expect(gateway.consecutiveRejections()).toBe(1);
    gateway.resetRejectionCounter();
    expect(gateway.consecutiveRejections()).toBe(0);
  });

  it('commits no sender ledger event for a rejected proposal', async () => {
    const { gateway, evidence, context } = harness();
    await gateway.submitProposal(turn(), symbolEnvelope(BAD));
    expect(evidence.ledgerEvents(context.runId, 'A')).toHaveLength(0);
    expect(evidence.channelEvents(context.runId)).toHaveLength(1);
  });

  it('chains rejected and accepted channel events in one append-only stream', async () => {
    const { gateway, evidence, context } = harness();
    await gateway.submitProposal(turn(), symbolEnvelope(BAD));
    await gateway.submitProposal(turn({ turn: 2 }), symbolEnvelope(['S02']));
    await gateway.submitProposal(turn({ turn: 3 }), symbolEnvelope(BAD));

    const events = evidence.channelEvents(context.runId);
    expect(events.map((event) => event.gatewayValidationResult)).toEqual([
      'rejected',
      'accepted',
      'rejected',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.previousChannelHash).toBe(
        events[index - 1]?.entryHash,
      );
    }
    const recovery = await evidence.recover(context.runId);
    expect(recovery.ok).toBe(true);
  });

  it('records a timeout as a channel rejection with no payload (SPEC §8.3)', async () => {
    const { gateway, evidence, context } = harness();
    const result = await gateway.rejectForTimeout(turn({ turn: 7 }), 'baby-b');

    expect(result.kind).toBe('rejected');
    expect(result.reasonCode).toBe('timeout');
    const event = ChannelEventSchema.parse(result.channelEvent);
    expect(event.reasonCode).toBe('timeout');
    expect(event.logicalSender).toBe('baby-b');
    expect(event.turn).toBe(7);
    expect(event.deliveryReceipt).toBeUndefined();
    expect(event.publicArtifactHash).toBe(result.rejectedPayloadHash);
    expect(evidence.channelEvents(context.runId)).toHaveLength(1);
  });

  it('never echoes the attempted payload in the rejection result', async () => {
    const { gateway } = harness();
    const result = await gateway.submitProposal(
      turn(),
      asEnvelope({
        proposal: {
          kind: 'emit_symbols',
          publicArtifact: { symbols: ['S01'], plea: 'the target is the red square' },
        },
        privateLedgerDraft: symbolEnvelope(['S01']).privateLedgerDraft,
      }),
    );

    expect(result.kind).toBe('rejected');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('red square');
    expect(serialized).not.toContain('plea');
    expect(serialized).not.toContain('S01');
    expect(Object.keys(result).sort()).toEqual([
      'channelEvent',
      'consecutiveRejections',
      'kind',
      'pauseRequested',
      'reasonCode',
      'rejectedPayloadHash',
    ]);
  });

  it('hashes the rejected payload deterministically and distinctly', async () => {
    const first = harness();
    const second = harness();
    const a = await first.gateway.submitProposal(turn(), symbolEnvelope(BAD));
    const b = await second.gateway.submitProposal(turn(), symbolEnvelope(BAD));
    const c = await second.gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(['S98']),
    );

    expect(a.kind === 'rejected' && a.rejectedPayloadHash).toBe(
      b.kind === 'rejected' ? b.rejectedPayloadHash : '',
    );
    expect(a.kind === 'rejected' && a.rejectedPayloadHash).not.toBe(
      c.kind === 'rejected' ? c.rejectedPayloadHash : '',
    );
  });

  it('survives an unserializable submission', async () => {
    const circular: Record<string, unknown> = { kind: 'emit_symbols' };
    circular.self = circular;
    const { gateway } = harness();
    const result = await gateway.submitProposal(turn(), asEnvelope(circular));
    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reasonCode).toBe(
      'invalid-envelope',
    );
  });
});
