/**
 * ALD-036: the fixed-token conformance suite. Every vector runs through a
 * real `SymbolGatewayImpl` over a real `EvidenceWriter`, with no learner
 * adapter involved.
 */
import { describe, expect, it } from 'vitest';

import {
  ChannelEventSchema,
  LedgerEventSchema,
  HASH_DOMAINS,
  type GatewaySubmitResult,
} from '@ald/types';
import {
  computeEntryHash,
  hashCanonical,
  hashCarrierMark,
  verifyHashSignature,
} from '@ald/hashing';

import {
  CONFORMANCE_INVENTORY,
  CONFORMANCE_MAX_SYMBOL_REPEATS,
  CONFORMANCE_MAX_SYMBOLS,
  FIXED_TOKEN_VECTORS,
} from '../src/conformance-vectors.js';
import { isGatewayReasonCode } from '../src/reason-codes.js';
import { asEnvelope, harness, turn } from './support.js';

/** Every string reachable from the offending public artifact. */
function artifactStrings(envelopeValue: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  const proposal = (envelopeValue as { proposal?: { publicArtifact?: unknown } })
    ?.proposal;
  walk(proposal?.publicArtifact);
  return found.filter((value) => value.length > 0);
}

describe('fixed-token conformance vectors (ALD-036)', () => {
  it('declares a 32-symbol inventory and the SPEC §9.1 defaults', () => {
    expect(CONFORMANCE_INVENTORY).toHaveLength(32);
    expect(CONFORMANCE_INVENTORY[0]).toBe('S01');
    expect(CONFORMANCE_INVENTORY[31]).toBe('S32');
    expect(CONFORMANCE_MAX_SYMBOLS).toBe(4);
    expect(CONFORMANCE_MAX_SYMBOL_REPEATS).toBe(3);
  });

  it('covers every reason code the fixed-token module can produce', () => {
    const covered = new Set(
      FIXED_TOKEN_VECTORS.filter((vector) => vector.expect !== 'accepted').map(
        (vector) => vector.expect,
      ),
    );
    for (const reasonCode of [
      'invalid-envelope',
      'trusted-metadata-present',
      'missing-intention',
      'carrier-mismatch',
      'unexpected-artifact-field',
      'free-text-present',
      'symbol-not-in-inventory',
      'empty-message',
      'message-too-long',
      'symbol-repeat-limit',
    ]) {
      expect(covered).toContain(reasonCode);
    }
    expect(
      FIXED_TOKEN_VECTORS.some((vector) => vector.expect === 'accepted'),
    ).toBe(true);
  });

  for (const vector of FIXED_TOKEN_VECTORS) {
    it(`${vector.expect === 'accepted' ? 'accepts' : `rejects (${vector.expect})`}: ${vector.name}`, async () => {
      const { gateway, evidence, context } = harness();
      const result: GatewaySubmitResult = await gateway.submitProposal(
        turn(),
        asEnvelope(vector.envelope),
      );

      if (vector.expect === 'accepted') {
        expect(result.kind).toBe('accepted');
        if (result.kind !== 'accepted') {
          return;
        }

        // ALD-035 criterion 2: the committed events are schema-valid, chained,
        // and signed by the channel/ledger writer keys.
        const channelEvent = ChannelEventSchema.parse(result.channelEvent);
        const ledgerEvent = LedgerEventSchema.parse(result.senderLedgerEvent);
        expect(channelEvent.gatewayValidationResult).toBe('accepted');
        expect(channelEvent.origin).toBe('baby');
        expect(channelEvent.senderLedgerSequence).toBe(ledgerEvent.sequence);
        expect(channelEvent.senderEntryHash).toBe(ledgerEvent.entryHash);
        expect(channelEvent.deliveryReceipt?.recipient).toBe('baby-b');
        expect(channelEvent.entryHash).toBe(
          computeEntryHash('channel', channelEvent),
        );
        expect(ledgerEvent.entryHash).toBe(
          computeEntryHash('baby-a-ledger', ledgerEvent),
        );

        const keys = evidence.signerRegistry.publicKeys();
        const channelKey = keys.find((key) => key.domain === 'channel');
        const ledgerKey = keys.find((key) => key.domain === 'baby-a-ledger');
        expect(
          verifyHashSignature(
            channelEvent.entryHash,
            channelEvent.writerSignature,
            channelKey?.publicKey ?? '',
          ),
        ).toBe(true);
        expect(
          verifyHashSignature(
            ledgerEvent.entryHash,
            ledgerEvent.writerSignature,
            ledgerKey?.publicKey ?? '',
          ),
        ).toBe(true);

        // ALD-029 criterion 3: both hashes are recorded and match.
        const proposal = (
          vector.envelope as { proposal: { kind: string; publicArtifact: unknown } }
        ).proposal;
        expect(result.babyProposalHash).toBe(
          hashCanonical(HASH_DOMAINS.babyProposal, proposal),
        );
        expect(result.babyProposalHash).toBe(channelEvent.babyProposalHash);
        expect(result.deliveredArtifactHash).toBe(
          channelEvent.publicArtifactHash,
        );
        expect(result.deliveredArtifactHash).toBe(
          hashCarrierMark(context.config.carrierMode, proposal.publicArtifact),
        );
        expect(result.delivery?.publicArtifact).toEqual(proposal.publicArtifact);
        expect(result.delivery?.channelEventHash).toBe(channelEvent.entryHash);
        // SPEC §4.2: the sender's private ledger content never reaches the
        // receiver's delivery envelope.
        expect(JSON.stringify(result.delivery)).not.toContain('artifact-1');
        return;
      }

      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') {
        return;
      }
      expect(result.reasonCode).toBe(vector.expect);
      expect(isGatewayReasonCode(result.reasonCode)).toBe(true);

      // ALD-034 criterion 1: an append-only channel.rejected event with a
      // reason code and payload hash, and no raw content anywhere.
      const channelEvent = ChannelEventSchema.parse(result.channelEvent);
      expect(channelEvent.gatewayValidationResult).toBe('rejected');
      expect(channelEvent.reasonCode).toBe(vector.expect);
      expect(channelEvent.deliveryReceipt).toBeUndefined();
      expect(channelEvent.publicArtifactHash).toBe(result.rejectedPayloadHash);
      expect(channelEvent.entryHash).toBe(
        computeEntryHash('channel', channelEvent),
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('symbols');
      for (const leaked of artifactStrings(vector.envelope)) {
        expect(serialized).not.toContain(leaked);
      }
    });
  }

  it('commits exactly one channel event per submission', async () => {
    const { gateway, evidence, context } = harness();
    for (const vector of FIXED_TOKEN_VECTORS) {
      gateway.resetRejectionCounter();
      await gateway.submitProposal(turn(), asEnvelope(vector.envelope));
    }
    expect(evidence.channelEvents(context.runId)).toHaveLength(
      FIXED_TOKEN_VECTORS.length,
    );
  });
});
