/**
 * SPEC §8.1 step 6, §8.2, §11.3 and ALD-035 criterion 3: the receiver's
 * interpretation event must echo the `channelEventHash` of the delivery
 * addressed to it, and every schema failure uses the standard Gateway shape.
 */
import { describe, expect, it } from 'vitest';

import { LedgerEventSchema } from '@ald/types';
import type { GatewaySubmitResult, LedgerDraftEnvelope } from '@ald/types';
import { computeEntryHash } from '@ald/hashing';

import { InterpretationRejectedError, toGatewayError } from '../src/errors.js';
import {
  harness,
  intentionDraft,
  interpretationDraft,
  symbolEnvelope,
  turn,
} from './support.js';

function accepted(
  result: GatewaySubmitResult,
): Extract<GatewaySubmitResult, { kind: 'accepted' }> {
  if (result.kind !== 'accepted') {
    throw new Error(`expected an accepted result, got ${result.reasonCode}`);
  }
  return result;
}

async function delivered() {
  const run = harness();
  const result = accepted(
    await run.gateway.submitProposal(turn(), symbolEnvelope(['S13', 'S04'])),
  );
  return { ...run, result };
}

const OTHER_HASH = `sha256:${'b'.repeat(64)}`;

describe('interpretation binding (SPEC §11.3)', () => {
  it('accepts the recipient echoing the delivered channel event hash', async () => {
    const { gateway, evidence, context, result } = await delivered();
    const envelope: LedgerDraftEnvelope = {
      channelEventHash: result.channelEvent.entryHash,
      privateLedgerDraft: interpretationDraft(),
    };

    const event = await gateway.submitInterpretation(
      turn(),
      'baby-b',
      envelope,
    );
    const parsed = LedgerEventSchema.parse(event);
    expect(parsed.babyId).toBe('B');
    expect(parsed.eventType).toBe('interpretation.recorded');
    expect(parsed.channelEventHash).toBe(result.channelEvent.entryHash);
    expect(parsed.entryHash).toBe(computeEntryHash('baby-b-ledger', parsed));
    expect(evidence.ledgerEvents(context.runId, 'B')).toHaveLength(1);
  });

  it('rejects a mismatched channel event hash and commits the rejection', async () => {
    const { gateway, evidence, context } = await delivered();
    let caught: unknown;
    try {
      await gateway.submitInterpretation(turn(), 'baby-b', {
        channelEventHash: OTHER_HASH,
        privateLedgerDraft: interpretationDraft(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InterpretationRejectedError);
    const error = caught as InterpretationRejectedError;
    expect(error.reasonCode).toBe('interpretation-hash-mismatch');
    expect(error.channelEvent.gatewayValidationResult).toBe('rejected');
    // SPEC §9.4: the rejection is attributed to the offending recipient.
    expect(error.channelEvent.logicalSender).toBe('baby-b');
    expect(error.consecutiveRejections).toBe(1);
    expect(error.pauseRequested).toBe(false);

    expect(evidence.ledgerEvents(context.runId, 'B')).toHaveLength(0);
    const events = evidence.channelEvents(context.runId);
    expect(events).toHaveLength(2);
    expect(events[1]?.reasonCode).toBe('interpretation-hash-mismatch');

    // SPEC §12.3 response shape.
    expect(toGatewayError(error)).toMatchObject({
      status: 422,
      error: { code: 'CHANNEL_REJECTED' },
    });
  });

  it('rejects the other Baby echoing a delivery addressed to its twin', async () => {
    const { gateway, result } = await delivered();
    await expect(
      gateway.submitInterpretation(turn(), 'baby-a', {
        channelEventHash: result.channelEvent.entryHash,
        privateLedgerDraft: interpretationDraft(),
      }),
    ).rejects.toBeInstanceOf(InterpretationRejectedError);
  });

  it('rejects an interpretation for a turn with no recorded delivery', async () => {
    const { gateway, result } = await delivered();
    await expect(
      gateway.submitInterpretation(turn({ turn: 9 }), 'baby-b', {
        channelEventHash: result.channelEvent.entryHash,
        privateLedgerDraft: interpretationDraft(),
      }),
    ).rejects.toBeInstanceOf(InterpretationRejectedError);
  });

  it('requires an interpretation.recorded draft', async () => {
    const { gateway, result } = await delivered();
    let caught: unknown;
    try {
      await gateway.submitInterpretation(turn(), 'baby-b', {
        channelEventHash: result.channelEvent.entryHash,
        privateLedgerDraft: intentionDraft(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InterpretationRejectedError);
    expect((caught as InterpretationRejectedError).reasonCode).toBe(
      'missing-interpretation',
    );
  });

  it('rejects a malformed ledger draft envelope', async () => {
    const { gateway } = await delivered();
    for (const malformed of [
      { channelEventHash: 'not-a-hash', privateLedgerDraft: interpretationDraft() },
      { privateLedgerDraft: interpretationDraft() },
      {
        channelEventHash: OTHER_HASH,
        privateLedgerDraft: interpretationDraft(),
        note: 'extra',
      },
    ]) {
      let caught: unknown;
      try {
        await gateway.submitInterpretation(
          turn(),
          'baby-b',
          malformed as unknown as LedgerDraftEnvelope,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InterpretationRejectedError);
      expect((caught as InterpretationRejectedError).reasonCode).toBe(
        'invalid-envelope',
      );
    }
  });

  it('does not leak the sender intention into the receiver ledger event', async () => {
    const { gateway, result } = await delivered();
    const event = await gateway.submitInterpretation(turn(), 'baby-b', {
      channelEventHash: result.channelEvent.entryHash,
      privateLedgerDraft: interpretationDraft({
        content: { artifactRef: 'receiver-guess' },
      }),
    });
    expect(event.content.artifactRef).toBe('receiver-guess');
    expect(JSON.stringify(event)).not.toContain('nonce-intention');
  });

  it('binds an oracle delivery for interpretation too', async () => {
    const { gateway } = harness({
      communicationCondition: 'oracle',
      experimentId: 'E03',
    });
    const { channelEvent } = await gateway.submitControlArtifact(turn(), {
      symbols: ['S07'],
    });
    const event = await gateway.submitInterpretation(turn(), 'baby-b', {
      channelEventHash: channelEvent.entryHash,
      privateLedgerDraft: interpretationDraft(),
    });
    expect(event.channelEventHash).toBe(channelEvent.entryHash);
  });
});
