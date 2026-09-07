/**
 * ALD-034 criterion 3 and ALD-036 criterion 3: a second protocol module can
 * register later without changing the rejection event shape or the pause
 * policy, and the consolidated suite requires every registered module to
 * contribute accept/reject vectors.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelEventSchema } from '@ald/types';
import type { GatewaySubmitResult } from '@ald/types';

import {
  carrierModule,
  registerCarrierModule,
  registeredCarriers,
  resetCarrierModules,
  type CarrierModule,
} from '../src/carrier-modules.js';
import {
  assertEveryCarrierHasVectors,
  conformanceVectorsFor,
  FIXED_TOKEN_VECTORS,
  registerConformanceVectors,
  resetConformanceVectors,
  type ConformanceVector,
} from '../src/conformance-vectors.js';
import { UnsupportedCarrierError } from '../src/errors.js';
import { SymbolGatewayImpl } from '../src/symbol-gateway.js';
import { asEnvelope, harness, intentionDraft, runContext, symbolEnvelope, turn } from './support.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';

/**
 * A minimal stand-in for the ALD-031 `generative-canvas` module: enough of a
 * grammar to accept a bounded stroke list and reject everything else.
 */
const stubCanvasModule: CarrierModule = {
  carrier: 'generative-canvas',
  allowedKinds: ['emit_canvas'],
  validate(proposal, context) {
    const artifact = (proposal as { publicArtifact?: unknown }).publicArtifact;
    if (typeof artifact !== 'object' || artifact === null) {
      return { ok: false, reasonCode: 'invalid-envelope', detail: 'no artifact' };
    }
    const keys = Object.keys(artifact);
    if (keys.length !== 1 || keys[0] !== 'strokes') {
      return {
        ok: false,
        reasonCode: 'unexpected-artifact-field',
        detail: `artifact carries ${keys.length} field(s)`,
      };
    }
    const strokes = (artifact as { strokes: unknown }).strokes;
    if (!Array.isArray(strokes)) {
      return { ok: false, reasonCode: 'invalid-envelope', detail: 'not an array' };
    }
    if (strokes.length === 0) {
      return { ok: false, reasonCode: 'empty-message', detail: 'no strokes' };
    }
    const max = context.runContext.config.maxStrokes ?? 8;
    if (strokes.length > max) {
      return {
        ok: false,
        reasonCode: 'message-too-long',
        detail: `${strokes.length} strokes exceed ${max}`,
      };
    }
    return { ok: true, artifact: { strokes: strokes as never } };
  },
  randomArtifact() {
    return { strokes: [{ startX: 0, startY: 0, endX: 1, endY: 1, width: 1 }] };
  },
  constantArtifact() {
    return { strokes: [{ startX: 2, startY: 2, endX: 3, endY: 3, width: 2 }] };
  },
};

const stroke = { startX: 0, startY: 0, endX: 4, endY: 4, width: 1 } as const;

function canvasEnvelope(count: number): unknown {
  return {
    proposal: {
      kind: 'emit_canvas',
      publicArtifact: {
        strokes: Array.from({ length: count }, () => ({ ...stroke })),
      },
    },
    privateLedgerDraft: intentionDraft(),
  };
}

const STUB_VECTORS: readonly ConformanceVector[] = [
  { name: 'accepts one stroke', envelope: canvasEnvelope(1), expect: 'accepted' },
  {
    name: 'rejects nine strokes',
    envelope: canvasEnvelope(9),
    expect: 'message-too-long',
  },
];

function canvasHarness() {
  const context = runContext({ carrierMode: 'generative-canvas', maxStrokes: 8 });
  const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
  evidence.registerRun(context.config);
  return { context, evidence, gateway: new SymbolGatewayImpl(context, evidence) };
}

afterEach(() => {
  resetCarrierModules();
  resetConformanceVectors();
});

describe('protocol module registration (ALD-034, ALD-036)', () => {
  it('registers only the fixed-token module by default', () => {
    expect(registeredCarriers()).toEqual(['fixed-token']);
    expect(carrierModule('fixed-token').allowedKinds).toEqual(['emit_symbols']);
  });

  it('refuses to construct a Gateway for an unregistered carrier', () => {
    const context = runContext({ carrierMode: 'generative-bitmap' });
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    evidence.registerRun(context.config);
    let caught: unknown;
    try {
      new SymbolGatewayImpl(context, evidence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedCarrierError);
    expect((caught as UnsupportedCarrierError).details?.backlogRefs).toEqual([
      'ALD-031',
      'ALD-033',
    ]);
  });

  it('routes a later-registered module without touching Gateway code', async () => {
    registerCarrierModule(stubCanvasModule);
    expect(registeredCarriers()).toEqual(['fixed-token', 'generative-canvas']);

    const { gateway, context, evidence } = canvasHarness();
    const result: GatewaySubmitResult = await gateway.submitProposal(
      turn(),
      asEnvelope(canvasEnvelope(2)),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') {
      return;
    }
    const event = ChannelEventSchema.parse(result.channelEvent);
    expect(event.carrier).toBe('generative-canvas');
    expect(event.deliveryReceipt?.deliveredArtifactHash).toBe(
      result.deliveredArtifactHash,
    );
    expect(evidence.ledgerEvents(context.runId, 'A')).toHaveLength(1);

    // Fixed-token proposals are not routable on a canvas run.
    const mismatch = await gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(['S01']),
    );
    expect(mismatch.kind === 'rejected' && mismatch.reasonCode).toBe(
      'carrier-mismatch',
    );
  });

  it('gives a second module the identical rejection shape and pause policy', async () => {
    registerCarrierModule(stubCanvasModule);
    const canvas = canvasHarness();
    const tokens = harness();

    const canvasRejection = await canvas.gateway.submitProposal(
      turn(),
      asEnvelope(canvasEnvelope(9)),
    );
    const tokenRejection = await tokens.gateway.submitProposal(
      turn(),
      symbolEnvelope(['S01', 'S02', 'S03', 'S04', 'S05']),
    );

    expect(canvasRejection.kind).toBe('rejected');
    expect(tokenRejection.kind).toBe('rejected');
    if (canvasRejection.kind !== 'rejected' || tokenRejection.kind !== 'rejected') {
      return;
    }
    expect(Object.keys(canvasRejection).sort()).toEqual(
      Object.keys(tokenRejection).sort(),
    );
    expect(canvasRejection.reasonCode).toBe(tokenRejection.reasonCode);

    const canvasEvent = ChannelEventSchema.parse(canvasRejection.channelEvent);
    const tokenEvent = ChannelEventSchema.parse(tokenRejection.channelEvent);
    expect(Object.keys(canvasEvent).sort()).toEqual(
      Object.keys(tokenEvent).sort(),
    );
    expect(canvasEvent.gatewayValidationResult).toBe('rejected');
    expect(canvasEvent.deliveryReceipt).toBeUndefined();

    // Identical pause policy: the fifth consecutive rejection trips it.
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await canvas.gateway.submitProposal(
        turn({ turn: attempt }),
        asEnvelope(canvasEnvelope(9)),
      );
    }
    const fifth = await canvas.gateway.submitProposal(
      turn({ turn: 5 }),
      asEnvelope(canvasEnvelope(9)),
    );
    expect(fifth.kind === 'rejected' && fifth.pauseRequested).toBe(true);
    const interventions = canvas.evidence.interventionEvents(
      canvas.context.runId,
    );
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.eventType).toBe('safety-trigger');
  });

  it('applies the §9.6 conditions to a second module unchanged', async () => {
    registerCarrierModule(stubCanvasModule);
    const context = runContext({
      carrierMode: 'generative-canvas',
      maxStrokes: 8,
      communicationCondition: 'constant',
    });
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    evidence.registerRun(context.config);
    const gateway = new SymbolGatewayImpl(context, evidence);

    const result = await gateway.submitProposal(
      turn(),
      asEnvelope(canvasEnvelope(3)),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') {
      return;
    }
    expect(result.delivery?.publicArtifact).toEqual(
      stubCanvasModule.constantArtifact(gateway.carrierContext),
    );
  });

  it('requires every registered module to contribute accept and reject vectors', () => {
    expect(conformanceVectorsFor('fixed-token')).toBe(FIXED_TOKEN_VECTORS);
    expect(() =>
      assertEveryCarrierHasVectors(registeredCarriers()),
    ).not.toThrow();

    registerCarrierModule(stubCanvasModule);
    expect(() => assertEveryCarrierHasVectors(registeredCarriers())).toThrow(
      /generative-canvas/u,
    );

    registerConformanceVectors('generative-canvas', STUB_VECTORS);
    expect(() =>
      assertEveryCarrierHasVectors(registeredCarriers()),
    ).not.toThrow();
  });

  it('rejects a vector set that never exercises a rejection', () => {
    expect(() =>
      registerConformanceVectors('generative-canvas', [
        { name: 'accepts one stroke', envelope: canvasEnvelope(1), expect: 'accepted' },
      ]),
    ).toThrow(/at least one rejection/u);
    expect(() =>
      registerConformanceVectors('generative-canvas', [
        {
          name: 'rejects nine strokes',
          envelope: canvasEnvelope(9),
          expect: 'message-too-long',
        },
      ]),
    ).toThrow(/at least one acceptance/u);
  });

  it('runs a second module vectors through the same suite driver', async () => {
    registerCarrierModule(stubCanvasModule);
    registerConformanceVectors('generative-canvas', STUB_VECTORS);
    const vectors = conformanceVectorsFor('generative-canvas') ?? [];
    expect(vectors).toHaveLength(2);

    for (const vector of vectors) {
      const { gateway } = canvasHarness();
      const result = await gateway.submitProposal(
        turn(),
        asEnvelope(vector.envelope),
      );
      if (vector.expect === 'accepted') {
        expect(result.kind).toBe('accepted');
      } else {
        expect(result.kind === 'rejected' && result.reasonCode).toBe(
          vector.expect,
        );
      }
    }
  });
});
