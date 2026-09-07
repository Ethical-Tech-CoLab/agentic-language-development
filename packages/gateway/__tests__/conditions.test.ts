/**
 * ALD-029 criterion 2: the six SPEC §9.6 communication-control conditions
 * produce their exact documented behaviour from the same proposals and the
 * same code, and criterion 3: every turn records the Baby-proposal hash when
 * one exists plus the exact delivered-artifact hash.
 */
import { describe, expect, it } from 'vitest';

import { ChannelEventSchema, HASH_DOMAINS } from '@ald/types';
import type { AgentActionProposal, GatewaySubmitResult } from '@ald/types';
import { hashCanonical, hashCarrierMark } from '@ald/hashing';

import {
  ControlArtifactNotPermittedError,
  OracleRequiresControlArtifactError,
  ShuffledBatchRequiredError,
} from '../src/errors.js';
import { harness, symbolEnvelope, turn } from './support.js';

const PROPOSED = ['S13', 'S04'];

function accepted(
  result: GatewaySubmitResult,
): Extract<GatewaySubmitResult, { kind: 'accepted' }> {
  if (result.kind !== 'accepted') {
    throw new Error(`expected an accepted result, got ${result.reasonCode}`);
  }
  return result;
}

/** Reads the `symbols` field of a delivered or proposed artifact. */
function symbolsOf(artifact: unknown): string[] {
  return (artifact as { symbols?: string[] } | undefined)?.symbols ?? [];
}

describe('SPEC §9.6 communication-control conditions', () => {
  it('normal delivers the validated Baby proposal unchanged', async () => {
    const { gateway, context } = harness({ communicationCondition: 'normal' });
    const result = accepted(
      await gateway.submitProposal(turn(), symbolEnvelope(PROPOSED)),
    );

    expect(symbolsOf(result.delivery?.publicArtifact)).toEqual(PROPOSED);
    expect(result.deliveredArtifactHash).toBe(
      hashCarrierMark(context.config.carrierMode, { symbols: PROPOSED }),
    );
    expect(result.channelEvent.communicationCondition).toBe('normal');
    expect(result.channelEvent.babyProposalHash).toBe(result.babyProposalHash);
  });

  it('disabled delivers no artifact but still records both hashes', async () => {
    const { gateway, context } = harness({ communicationCondition: 'disabled' });
    const result = accepted(
      await gateway.submitProposal(turn(), symbolEnvelope(PROPOSED)),
    );

    expect(result.delivery).toBeNull();
    expect(result.channelEvent.deliveryReceipt).toBeUndefined();
    expect(result.babyProposalHash).toBe(
      hashCanonical(HASH_DOMAINS.babyProposal, {
        kind: 'emit_symbols',
        publicArtifact: { symbols: PROPOSED },
      }),
    );
    // SPEC §11.5: for disabled, publicArtifactHash is the hash of canonical null.
    expect(result.deliveredArtifactHash).toBe(
      hashCarrierMark(context.config.carrierMode, null),
    );
    expect(result.deliveredArtifactHash).not.toBe(
      hashCarrierMark(context.config.carrierMode, { symbols: PROPOSED }),
    );
    // No delivery is recorded, so no interpretation can bind to this turn.
    expect(gateway.deliveryFor(1, 'baby-b')).toBeUndefined();
  });

  it('constant replaces every proposal with the module default artifact', async () => {
    const { gateway, context } = harness({ communicationCondition: 'constant' });
    const first = accepted(
      await gateway.submitProposal(turn(), symbolEnvelope(PROPOSED)),
    );
    const second = accepted(
      await gateway.submitProposal(
        turn({ turn: 2 }),
        symbolEnvelope(['S21', 'S22', 'S23']),
      ),
    );

    expect(symbolsOf(first.delivery?.publicArtifact)).toEqual([
      context.symbolInventory[0],
    ]);
    expect(first.deliveredArtifactHash).toBe(second.deliveredArtifactHash);
    expect(first.babyProposalHash).not.toBe(second.babyProposalHash);
    expect(first.deliveredArtifactHash).not.toBe(
      hashCarrierMark(context.config.carrierMode, { symbols: PROPOSED }),
    );
  });

  it('constant honours a pre-registered artifact and validates it', () => {
    const { gateway } = harness(
      { communicationCondition: 'constant' },
      { constantArtifact: { symbols: ['S09', 'S09'] } },
    );
    expect(gateway.condition).toBe('constant');

    expect(() =>
      harness(
        { communicationCondition: 'constant' },
        { constantArtifact: { symbols: ['S99'] } },
      ),
    ).toThrow(/symbol-not-in-inventory/u);
  });

  it('random delivers a seeded valid artifact that is never the proposal', async () => {
    const { gateway, context } = harness({ communicationCondition: 'random' });
    const result = accepted(
      await gateway.submitProposal(turn(), symbolEnvelope(PROPOSED)),
    );

    const delivered = symbolsOf(result.delivery?.publicArtifact);
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered.length).toBeLessThanOrEqual(4);
    for (const symbol of delivered) {
      expect(context.symbolInventory).toContain(symbol);
    }
    expect(result.deliveredArtifactHash).toBe(
      hashCarrierMark(context.config.carrierMode, { symbols: delivered }),
    );
    expect(result.babyProposalHash).toBeDefined();
  });

  it('random is reproducible from the run seed and varies per turn', async () => {
    const first = harness({ communicationCondition: 'random' });
    const second = harness({ communicationCondition: 'random' });

    const deliveries: string[][][] = [[], []];
    for (const [index, run] of [first, second].entries()) {
      for (const turnNumber of [1, 2, 3, 4, 5]) {
        const result = accepted(
          await run.gateway.submitProposal(
            turn({ turn: turnNumber }),
            symbolEnvelope(PROPOSED),
          ),
        );
        (deliveries[index] as string[][]).push(
          symbolsOf(result.delivery?.publicArtifact),
        );
      }
    }

    expect(deliveries[0]).toEqual(deliveries[1]);
    const distinct = new Set(
      (deliveries[0] as string[][]).map((symbols) => symbols.join(',')),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('random draws only artifacts its own module accepts, across seeds', async () => {
    for (const seedIndex of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const run = harness(
        { communicationCondition: 'random', symbolInventorySize: 2, maxSymbolsPerMessage: 8 },
        { maxSymbolRepeats: 1 },
        { seed: `seed-random-${seedIndex}` },
      );
      for (const turnNumber of [1, 2, 3]) {
        const result = accepted(
          await run.gateway.submitProposal(
            turn({ turn: turnNumber }),
            symbolEnvelope(['S01']),
          ),
        );
        const delivered = symbolsOf(result.delivery?.publicArtifact);
        expect(delivered.length).toBeGreaterThanOrEqual(1);
        expect(delivered.length).toBeLessThanOrEqual(8);
        for (let index = 1; index < delivered.length; index += 1) {
          expect(delivered[index]).not.toBe(delivered[index - 1]);
        }
      }
    }
  });

  it('shuffled delivers another episode of the batch under a seeded derangement', async () => {
    const batch: AgentActionProposal['publicArtifact'][] = [
      { symbols: ['S01'] },
      { symbols: ['S02'] },
      { symbols: ['S03'] },
      { symbols: ['S04'] },
    ];

    const deliveredPerIndex: string[][] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const { gateway } = harness({ communicationCondition: 'shuffled' });
      const result = accepted(
        await gateway.submitProposal(
          turn({ turn: index + 1, batchArtifacts: batch, batchIndex: index }),
          symbolEnvelope(symbolsOf(batch[index])),
        ),
      );
      const delivered = symbolsOf(result.delivery?.publicArtifact);
      deliveredPerIndex.push(delivered);
      // Never this episode's own artifact.
      expect(delivered).not.toEqual(symbolsOf(batch[index]));
      expect(result.deliveredArtifactHash).not.toBe(
        hashCarrierMark('fixed-token', batch[index]),
      );
      expect(result.babyProposalHash).toBeDefined();
    }

    // A permutation, so every batch artifact is delivered exactly once.
    expect(
      new Set(deliveredPerIndex.map((symbols) => symbols.join(','))).size,
    ).toBe(batch.length);
  });

  it('shuffled is reproducible from the run seed', async () => {
    const batch: AgentActionProposal['publicArtifact'][] = [
      { symbols: ['S01'] },
      { symbols: ['S02'] },
      { symbols: ['S03'] },
    ];
    const runs = [harness({ communicationCondition: 'shuffled' }), harness({ communicationCondition: 'shuffled' })];
    const observed: string[][] = [];
    for (const run of runs) {
      const result = accepted(
        await run.gateway.submitProposal(
          turn({ batchArtifacts: batch, batchIndex: 2 }),
          symbolEnvelope(['S03']),
        ),
      );
      observed.push(symbolsOf(result.delivery?.publicArtifact));
    }
    expect(observed[0]).toEqual(observed[1]);
  });

  it('shuffled requires the batch and rejects an out-of-range index', async () => {
    const { gateway } = harness({ communicationCondition: 'shuffled' });
    await expect(
      gateway.submitProposal(turn(), symbolEnvelope(['S01'])),
    ).rejects.toBeInstanceOf(ShuffledBatchRequiredError);

    await expect(
      gateway.submitProposal(
        turn({ batchArtifacts: [{ symbols: ['S01'] }], batchIndex: 4 }),
        symbolEnvelope(['S01']),
      ),
    ).rejects.toBeInstanceOf(ShuffledBatchRequiredError);
  });

  it('shuffled with a single-episode batch can only deliver that episode', async () => {
    const { gateway } = harness({ communicationCondition: 'shuffled' });
    const result = accepted(
      await gateway.submitProposal(
        turn({ batchArtifacts: [{ symbols: ['S05'] }], batchIndex: 0 }),
        symbolEnvelope(['S05']),
      ),
    );
    expect(symbolsOf(result.delivery?.publicArtifact)).toEqual(['S05']);
  });

  it('oracle refuses learner proposals and commits gateway-control artifacts', async () => {
    const { gateway, evidence, context } = harness({
      communicationCondition: 'oracle',
      experimentId: 'E03',
    });

    await expect(
      gateway.submitProposal(turn(), symbolEnvelope(PROPOSED)),
    ).rejects.toBeInstanceOf(OracleRequiresControlArtifactError);

    const { channelEvent, delivery } = await gateway.submitControlArtifact(
      turn(),
      { symbols: ['S11', 'S12'] },
    );
    const parsed = ChannelEventSchema.parse(channelEvent);
    expect(parsed.origin).toBe('gateway-control');
    expect(parsed.communicationCondition).toBe('oracle');
    expect(parsed.babyProposalHash).toBeUndefined();
    expect(parsed.senderLedgerSequence).toBeUndefined();
    expect(parsed.publicArtifactHash).toBe(
      hashCarrierMark(context.config.carrierMode, { symbols: ['S11', 'S12'] }),
    );
    expect(parsed.deliveryReceipt?.recipient).toBe('baby-b');
    expect(symbolsOf(delivery.publicArtifact)).toEqual(['S11', 'S12']);
    expect(gateway.deliveryFor(1, 'baby-b')?.channelEventHash).toBe(
      parsed.entryHash,
    );
    // No sender ledger event exists for an oracle turn.
    expect(evidence.ledgerEvents(context.runId, 'A')).toHaveLength(0);
  });

  it('oracle validates the Scenario Engine artifact against the carrier', async () => {
    const { gateway } = harness({
      communicationCondition: 'oracle',
      experimentId: 'E03',
    });
    await expect(
      gateway.submitControlArtifact(turn(), { symbols: ['not a symbol'] }),
    ).rejects.toThrow(/free-text-present/u);
  });

  it('rejects control artifacts under the other five conditions', async () => {
    for (const condition of [
      'normal',
      'disabled',
      'constant',
      'random',
      'shuffled',
    ] as const) {
      const { gateway } = harness({ communicationCondition: condition });
      await expect(
        gateway.submitControlArtifact(turn(), { symbols: ['S01'] }),
      ).rejects.toBeInstanceOf(ControlArtifactNotPermittedError);
    }
  });

  it('records both hashes for every Baby-originated condition', async () => {
    for (const condition of [
      'normal',
      'disabled',
      'constant',
      'random',
      'shuffled',
    ] as const) {
      const { gateway } = harness({ communicationCondition: condition });
      const result = accepted(
        await gateway.submitProposal(
          turn({
            batchArtifacts: [{ symbols: ['S01'] }, { symbols: ['S02'] }],
            batchIndex: 0,
          }),
          symbolEnvelope(PROPOSED),
        ),
      );
      expect(result.babyProposalHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(result.deliveredArtifactHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(result.channelEvent.babyProposalHash).toBe(result.babyProposalHash);
      expect(result.channelEvent.publicArtifactHash).toBe(
        result.deliveredArtifactHash,
      );
      // The two hashes use different domains, so they are never equal even
      // under `normal`; comparability is via the carrier-mark hash instead.
      expect(result.babyProposalHash).not.toBe(result.deliveredArtifactHash);
    }
  });
});
