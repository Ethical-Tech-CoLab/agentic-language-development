/**
 * ALD-031 — SPEC §9.2 alternate neutral carrier protocols.
 *
 * Every vector runs through a real `SymbolGatewayImpl` over a real
 * `EvidenceWriter` with no learner adapter involved (ALD-036 criterion 2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChannelEventSchema,
  HASH_DOMAINS,
  LedgerEventSchema,
  type GatewaySubmitResult,
  type RunConfig,
} from '@ald/types';
import { SeededPrng, computeEntryHash, hashCanonical, hashCarrierMark } from '@ald/hashing';

import {
  ALL_CARRIER_ACTION_KINDS,
  CARRIER_ACTION_KINDS,
  InvalidCarrierFamilyError,
  assertSingleCarrierFamily,
  availableCarrierActions,
  carrierModule,
  isCarrierActionKind,
  registerCarrierModule,
  registeredCarriers,
  resetCarrierModules,
  type CarrierModule,
} from '../src/carrier-modules.js';
import {
  ALTERNATE_CARRIER_VECTORS,
  FIXED_TOKEN_VECTORS,
  assertEveryCarrierHasVectors,
  conformanceVectorsFor,
  resetConformanceVectors,
  type ConformanceVector,
} from '../src/conformance-vectors.js';
import {
  ALTERNATE_CARRIERS,
  CARRIER_MARK_HASH_VECTORS,
  MissingGlyphBundleHashError,
  carrierInventory,
  carrierMarkHash,
  fixedGlyphModule,
  generateGlyphBundle,
  glyphInventory,
  hashGlyphBundle,
  registerAlternateCarriers,
} from '../src/carriers/index.js';
import { GATEWAY_REASON_CODES, isGatewayReasonCode } from '../src/reason-codes.js';
import { SymbolGatewayImpl } from '../src/symbol-gateway.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';
import { asEnvelope, intentionDraft, runContext, turn } from './support.js';

const GLYPH_BUNDLE_HASH = hashGlyphBundle(
  generateGlyphBundle({ seed: 'ald-carriers-test-bundle', size: 32 }),
);

/** A registered run over `carrier`, with the §9.2 config a run needs. */
function carrierHarness(
  carrier: RunConfig['carrierMode'],
  overrides: Partial<RunConfig> = {},
): {
  gateway: SymbolGatewayImpl;
  evidence: FakeEvidenceWriter;
  context: ReturnType<typeof runContext>;
} {
  const inventory = carrierInventory({
    carrierMode: carrier,
    symbolInventorySize: 32,
  });
  const context = runContext(
    {
      carrierMode: carrier,
      ...(carrier === 'fixed-glyph' ? { glyphBundleHash: GLYPH_BUNDLE_HASH } : {}),
      ...overrides,
    },
    // A generative carrier declares no inventory (SPEC §9.2), but the Gateway
    // still requires a non-degenerate `symbolInventory` for the §9.1 checks it
    // shares, so the fixed-token default stands in there.
    inventory.length >= 2 ? { symbolInventory: inventory } : {},
  );
  const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
  evidence.registerRun(context.config);
  return {
    gateway: new SymbolGatewayImpl(context, evidence),
    evidence,
    context,
  };
}

/** A minimal valid proposal for each carrier. */
const VALID_PROPOSALS: Readonly<
  Record<RunConfig['carrierMode'], { kind: string; publicArtifact: unknown }>
> = {
  'fixed-token': { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
  'fixed-glyph': { kind: 'emit_glyphs', publicArtifact: { glyphs: ['G01'] } },
  'generative-bitmap': {
    kind: 'emit_bitmap',
    publicArtifact: { bitmap: { bits: new Array<0 | 1>(256).fill(0) } },
  },
  'generative-canvas': {
    kind: 'emit_canvas',
    publicArtifact: {
      strokes: [{ startX: 0, startY: 0, endX: 15, endY: 15, width: 1 }],
    },
  },
  'generative-tone': {
    kind: 'emit_tones',
    publicArtifact: { tones: { tones: [{ pitchBin: 2, durationBin: 3 }] } },
  },
};

const ALL_CARRIERS = Object.keys(VALID_PROPOSALS) as RunConfig['carrierMode'][];

function envelopeFor(carrier: RunConfig['carrierMode']): unknown {
  return {
    proposal: VALID_PROPOSALS[carrier],
    privateLedgerDraft: intentionDraft(),
  };
}

/** Every non-empty string reachable from a submission's public artifact. */
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
  // Strings shorter than three characters are dropped: a rejection result is
  // mostly hex digests, so `"1"` or `"C4"` appears inside a hash by chance
  // and would make the leak assertion meaningless rather than strict.
  return found.filter((value) => value.length >= 3);
}

beforeEach(() => {
  registerAlternateCarriers();
});

afterEach(() => {
  resetCarrierModules();
  resetConformanceVectors();
});

describe('alternate carrier registration (ALD-031 criterion 3)', () => {
  it('ALD-031: registers all four §9.2 modules and their ALD-036 vectors', () => {
    expect(registeredCarriers()).toEqual([
      'fixed-glyph',
      'fixed-token',
      'generative-bitmap',
      'generative-canvas',
      'generative-tone',
    ]);
    for (const carrier of ALTERNATE_CARRIERS) {
      expect(conformanceVectorsFor(carrier)).toBe(
        ALTERNATE_CARRIER_VECTORS.get(carrier),
      );
    }
    expect(conformanceVectorsFor('fixed-token')).toBe(FIXED_TOKEN_VECTORS);
    expect(() =>
      assertEveryCarrierHasVectors(registeredCarriers()),
    ).not.toThrow();
  });

  it('ALD-031: is idempotent, so a second bootstrap changes nothing', () => {
    registerAlternateCarriers();
    registerAlternateCarriers();
    expect(registeredCarriers()).toHaveLength(5);
  });

  it('ALD-031: leaves fixed-token alone after a reset (never the default)', () => {
    resetCarrierModules();
    resetConformanceVectors();
    expect(registeredCarriers()).toEqual(['fixed-token']);
    expect(() =>
      assertEveryCarrierHasVectors(registeredCarriers()),
    ).not.toThrow();
  });

  it('ALD-031: every carrier owns exactly one tool family', () => {
    for (const carrier of ALL_CARRIERS) {
      expect(CARRIER_ACTION_KINDS[carrier]).toHaveLength(1);
      expect(availableCarrierActions({ carrierMode: carrier })).toEqual(
        carrierModule(carrier).allowedKinds,
      );
      expect(() =>
        assertSingleCarrierFamily({ carrierMode: carrier }),
      ).not.toThrow();
    }
    expect(new Set(ALL_CARRIER_ACTION_KINDS).size).toBe(5);
  });

  it('ALD-031: refuses a module whose family disagrees with its carrier', () => {
    const impostor: CarrierModule = {
      ...fixedGlyphModule,
      carrier: 'generative-tone',
    };
    registerCarrierModule(impostor);
    let caught: unknown;
    try {
      assertSingleCarrierFamily({ carrierMode: 'generative-tone' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidCarrierFamilyError);
    expect((caught as InvalidCarrierFamilyError).actualKinds).toEqual([
      'emit_glyphs',
    ]);
  });
});

describe('exactly one carrier family is available in a run (ALD-031 criterion 3)', () => {
  for (const carrier of ALL_CARRIERS) {
    for (const submitted of ALL_CARRIERS) {
      const expected = carrier === submitted ? 'accepted' : 'carrier-mismatch';
      it(`ALD-031: a ${submitted} proposal on a ${carrier} run is ${expected}`, async () => {
        const { gateway } = carrierHarness(carrier);
        const result = await gateway.submitProposal(
          turn(),
          asEnvelope(envelopeFor(submitted)),
        );
        if (expected === 'accepted') {
          expect(result.kind).toBe('accepted');
        } else {
          expect(result.kind === 'rejected' && result.reasonCode).toBe(
            'carrier-mismatch',
          );
        }
      });
    }
  }

  it('ALD-031: no carrier offers another carrier’s emit tool', () => {
    for (const carrier of ALL_CARRIERS) {
      for (const kind of ALL_CARRIER_ACTION_KINDS) {
        expect(isCarrierActionKind(carrier, kind)).toBe(
          (CARRIER_ACTION_KINDS[carrier] as readonly string[]).includes(kind),
        );
      }
    }
  });
});

describe('carrier-qualified markHash (ALD-031 criterion 1)', () => {
  it('ALD-031: reproduces the published §9.2 hash vectors', () => {
    for (const vector of CARRIER_MARK_HASH_VECTORS) {
      expect(carrierMarkHash(vector.carrier, vector.artifact), vector.name).toBe(
        vector.markHash,
      );
      expect(hashCarrierMark(vector.carrier, vector.artifact)).toBe(
        vector.markHash,
      );
    }
  });

  it('ALD-031: the same canonical artifact hashes differently per carrier', () => {
    const artifact = { glyphs: ['G01', 'G02'] };
    const asGlyph = carrierMarkHash('fixed-glyph', artifact);
    const asBitmap = carrierMarkHash(
      'generative-bitmap',
      artifact as unknown as never,
    );
    expect(asGlyph).not.toBe(asBitmap);
    expect(new Set(CARRIER_MARK_HASH_VECTORS.map((v) => v.markHash)).size).toBe(
      CARRIER_MARK_HASH_VECTORS.length,
    );
  });

  it('ALD-031: is insensitive to key order but sensitive to mark order', () => {
    const ordered = { strokes: [{ startX: 1, startY: 2, endX: 3, endY: 4, width: 1 }] };
    const shuffledKeys = {
      strokes: [{ width: 1, endY: 4, endX: 3, startY: 2, startX: 1 }],
    };
    expect(carrierMarkHash('generative-canvas', ordered)).toBe(
      carrierMarkHash('generative-canvas', shuffledKeys),
    );
    expect(carrierMarkHash('generative-tone', {
      tones: { tones: [{ pitchBin: 1, durationBin: 1 }, { pitchBin: 2, durationBin: 1 }] },
    })).not.toBe(
      carrierMarkHash('generative-tone', {
        tones: { tones: [{ pitchBin: 2, durationBin: 1 }, { pitchBin: 1, durationBin: 1 }] },
      }),
    );
  });

  for (const carrier of ALTERNATE_CARRIERS) {
    it(`ALD-031: a ${carrier} delivery records the markHash as its artifact hash`, async () => {
      const first = carrierHarness(carrier);
      const result: GatewaySubmitResult = await first.gateway.submitProposal(
        turn(),
        asEnvelope(envelopeFor(carrier)),
      );
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') {
        return;
      }
      const proposal = VALID_PROPOSALS[carrier];
      const expected = carrierMarkHash(
        carrier,
        proposal.publicArtifact as never,
      );
      const channelEvent = ChannelEventSchema.parse(result.channelEvent);
      const ledgerEvent = LedgerEventSchema.parse(result.senderLedgerEvent);
      expect(result.deliveredArtifactHash).toBe(expected);
      expect(channelEvent.publicArtifactHash).toBe(expected);
      expect(channelEvent.carrier).toBe(carrier);
      expect(channelEvent.senderEntryHash).toBe(ledgerEvent.entryHash);
      expect(channelEvent.entryHash).toBe(
        computeEntryHash('channel', channelEvent),
      );
      expect(result.babyProposalHash).toBe(
        hashCanonical(HASH_DOMAINS.babyProposal, proposal),
      );
      expect(result.delivery?.publicArtifact).toEqual(proposal.publicArtifact);

      // A second, independent Gateway over a different run reproduces the
      // identical mark hash: content addressing is process-independent.
      const second = carrierHarness(carrier, { runId: 'run-gateway-002' });
      const again = await second.gateway.submitProposal(
        turn({ turn: 7, sender: 'baby-b', recipient: 'baby-a' }),
        asEnvelope(envelopeFor(carrier)),
      );
      expect(again.kind === 'accepted' && again.deliveredArtifactHash).toBe(
        expected,
      );
    });
  }
});

describe('alternate carrier conformance vectors (ALD-031, ALD-036)', () => {
  it('ALD-031: covers every reason code the §9.2 modules can produce', () => {
    const covered = new Set<string>();
    for (const vectors of ALTERNATE_CARRIER_VECTORS.values()) {
      for (const vector of vectors) {
        if (vector.expect !== 'accepted') {
          covered.add(vector.expect);
        }
      }
    }
    for (const reasonCode of [
      'glyph-not-in-inventory',
      'bitmap-size-invalid',
      'bitmap-value-invalid',
      'too-many-strokes',
      'stroke-out-of-range',
      'stroke-width-invalid',
      'too-many-tones',
      'tone-out-of-range',
      'empty-message',
      'message-too-long',
      'symbol-repeat-limit',
      'free-text-present',
      'unexpected-artifact-field',
      'carrier-mismatch',
      'invalid-envelope',
      'trusted-metadata-present',
      'missing-intention',
    ]) {
      expect(covered, reasonCode).toContain(reasonCode);
    }
    for (const code of covered) {
      expect(isGatewayReasonCode(code)).toBe(true);
      expect(GATEWAY_REASON_CODES).toContain(code);
    }
  });

  for (const [carrier, vectors] of ALTERNATE_CARRIER_VECTORS) {
    for (const vector of vectors as readonly ConformanceVector[]) {
      const label =
        vector.expect === 'accepted' ? 'accepts' : `rejects (${vector.expect})`;
      it(`ALD-031 ${carrier} ${label}: ${vector.name}`, async () => {
        const { gateway } = carrierHarness(carrier);
        const result = await gateway.submitProposal(
          turn(),
          asEnvelope(vector.envelope),
        );

        if (vector.expect === 'accepted') {
          expect(result.kind).toBe('accepted');
          if (result.kind !== 'accepted') {
            return;
          }
          const channelEvent = ChannelEventSchema.parse(result.channelEvent);
          expect(channelEvent.gatewayValidationResult).toBe('accepted');
          expect(channelEvent.deliveryReceipt?.recipient).toBe('baby-b');
          return;
        }

        expect(result.kind).toBe('rejected');
        if (result.kind !== 'rejected') {
          return;
        }
        expect(result.reasonCode).toBe(vector.expect);

        // ALD-034: the shared rejection framework, unchanged by the new
        // modules — a committed `channel.rejected` event carrying a reason
        // code and a payload hash and no part of the attempted content.
        const channelEvent = ChannelEventSchema.parse(result.channelEvent);
        expect(channelEvent.gatewayValidationResult).toBe('rejected');
        expect(channelEvent.reasonCode).toBe(vector.expect);
        expect(channelEvent.deliveryReceipt).toBeUndefined();
        expect(channelEvent.publicArtifactHash).toBe(result.rejectedPayloadHash);
        const serialized = JSON.stringify(result);
        for (const leaked of artifactStrings(vector.envelope)) {
          expect(serialized).not.toContain(leaked);
        }
      });
    }
  }

  it('ALD-031: commits exactly one channel event per submission, per carrier', async () => {
    for (const [carrier, vectors] of ALTERNATE_CARRIER_VECTORS) {
      const { gateway, evidence, context } = carrierHarness(carrier);
      for (const vector of vectors) {
        gateway.resetRejectionCounter();
        await gateway.submitProposal(turn(), asEnvelope(vector.envelope));
      }
      expect(evidence.channelEvents(context.runId), carrier).toHaveLength(
        vectors.length,
      );
    }
  });
});

describe('§9.6 communication controls over the §9.2 carriers (ALD-029, ALD-031)', () => {
  for (const carrier of ALTERNATE_CARRIERS) {
    it(`ALD-031: ${carrier} constant and random artifacts are themselves valid`, () => {
      const { gateway } = carrierHarness(carrier);
      const module = carrierModule(carrier);
      const context = gateway.carrierContext;
      const constant = module.constantArtifact(context);
      const validation = module.validate(
        { kind: module.allowedKinds[0], publicArtifact: constant },
        context,
      );
      expect(validation.ok, carrier).toBe(true);

      for (let draw = 0; draw < 12; draw += 1) {
        const artifact = module.randomArtifact(
          new SeededPrng(`carrier-random/${carrier}/${String(draw)}`),
          context,
        );
        const check = module.validate(
          { kind: module.allowedKinds[0], publicArtifact: artifact },
          context,
        );
        expect(check.ok, `${carrier} draw ${String(draw)}`).toBe(true);
      }
    });

    it(`ALD-031: ${carrier} delivers the pre-registered constant under \`constant\``, async () => {
      const { gateway } = carrierHarness(carrier, {
        communicationCondition: 'constant',
      });
      const result = await gateway.submitProposal(
        turn(),
        asEnvelope(envelopeFor(carrier)),
      );
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') {
        return;
      }
      expect(result.delivery?.publicArtifact).toEqual(
        carrierModule(carrier).constantArtifact(gateway.carrierContext),
      );
    });

    it(`ALD-031: ${carrier} \`random\` replays from the run seed`, async () => {
      const deliveries = await Promise.all(
        [0, 1].map(async () => {
          const { gateway } = carrierHarness(carrier, {
            communicationCondition: 'random',
          });
          const result = await gateway.submitProposal(
            turn(),
            asEnvelope(envelopeFor(carrier)),
          );
          return result.kind === 'accepted' ? result.deliveredArtifactHash : '';
        }),
      );
      expect(deliveries[0]).not.toBe('');
      expect(deliveries[0]).toBe(deliveries[1]);
    });

    it(`ALD-031: ${carrier} delivers nothing under \`disabled\``, async () => {
      const { gateway } = carrierHarness(carrier, {
        communicationCondition: 'disabled',
      });
      const result = await gateway.submitProposal(
        turn(),
        asEnvelope(envelopeFor(carrier)),
      );
      expect(result.kind === 'accepted' && result.delivery).toBeNull();
    });
  }
});

describe('fixed-glyph run configuration (ALD-031, SPEC §9.2)', () => {
  it('ALD-031: refuses to construct a glyph Gateway with no frozen bundle hash', () => {
    const context = runContext(
      { carrierMode: 'fixed-glyph' },
      { symbolInventory: glyphInventory(32) },
    );
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    evidence.registerRun(context.config);
    let caught: unknown;
    try {
      new SymbolGatewayImpl(context, evidence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingGlyphBundleHashError);
    expect((caught as MissingGlyphBundleHashError).details?.field).toBe(
      'glyphBundleHash',
    );
  });

  it('ALD-031: validates glyph ids against the declared inventory size', async () => {
    const { gateway } = carrierHarness('fixed-glyph', {
      symbolInventorySize: 4,
    });
    const inside = await gateway.submitProposal(turn(), asEnvelope({
      proposal: { kind: 'emit_glyphs', publicArtifact: { glyphs: ['G04'] } },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(inside.kind).toBe('accepted');

    const outside = await gateway.submitProposal(turn({ turn: 2 }), asEnvelope({
      proposal: { kind: 'emit_glyphs', publicArtifact: { glyphs: ['G05'] } },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(outside.kind === 'rejected' && outside.reasonCode).toBe(
      'glyph-not-in-inventory',
    );
  });

  it('ALD-031: declares no inventory for the generative carriers', () => {
    expect(carrierInventory({ carrierMode: 'fixed-token' })).toHaveLength(32);
    expect(carrierInventory({ carrierMode: 'fixed-glyph' })[0]).toBe('G01');
    for (const carrier of [
      'generative-bitmap',
      'generative-canvas',
      'generative-tone',
    ] as const) {
      expect(carrierInventory({ carrierMode: carrier })).toEqual([]);
    }
  });
});

describe('canvas stroke bound is configurable per run (SPEC §9.2, §18)', () => {
  it('ALD-031: honours maxStrokes without a code change', async () => {
    const { gateway } = carrierHarness('generative-canvas', { maxStrokes: 2 });
    const stroke = { startX: 0, startY: 0, endX: 1, endY: 1, width: 1 };
    const withinCap = await gateway.submitProposal(turn(), asEnvelope({
      proposal: { kind: 'emit_canvas', publicArtifact: { strokes: [stroke, stroke] } },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(withinCap.kind).toBe('accepted');

    const overCap = await gateway.submitProposal(turn({ turn: 2 }), asEnvelope({
      proposal: {
        kind: 'emit_canvas',
        publicArtifact: { strokes: [stroke, stroke, stroke] },
      },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(overCap.kind === 'rejected' && overCap.reasonCode).toBe(
      'too-many-strokes',
    );
  });

  it('ALD-031: clamps a configured cap to the §9.2 ceiling of 64', async () => {
    const { gateway } = carrierHarness('generative-canvas', { maxStrokes: 64 });
    const stroke = { startX: 0, startY: 0, endX: 1, endY: 1, width: 1 };
    const atCeiling = await gateway.submitProposal(turn(), asEnvelope({
      proposal: {
        kind: 'emit_canvas',
        publicArtifact: { strokes: Array.from({ length: 64 }, () => stroke) },
      },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(atCeiling.kind).toBe('accepted');

    const overCeiling = await gateway.submitProposal(turn({ turn: 2 }), asEnvelope({
      proposal: {
        kind: 'emit_canvas',
        publicArtifact: { strokes: Array.from({ length: 65 }, () => stroke) },
      },
      privateLedgerDraft: intentionDraft(),
    }));
    expect(overCeiling.kind === 'rejected' && overCeiling.reasonCode).toBe(
      'too-many-strokes',
    );
  });
});
