/**
 * ALD-033 criterion 3 / ALD-036 — the affect half of the conformance suite.
 *
 * Every vector in `affect-vectors.ts` runs against a real `SymbolGatewayImpl`
 * over a real `EvidenceWriter`, with no learner adapter involved. An accepted
 * vector must produce exactly one schema-valid `AffectEvent`; a rejected
 * vector must produce exactly one `channel.rejected` event with reason
 * `affect-violation`, a payload hash, and no `AffectEvent` at all.
 */
import { describe, expect, it } from 'vitest';

import {
  AFFECT_DISPLAY_IDS,
  AffectEventSchema,
  type AffectSubmitResult,
  type BabyRole,
  type RunConfig,
} from '@ald/types';

import { AFFECT_VIOLATION_REASON } from '../src/affect.js';
import { createAffectWindow } from '../src/affect-windows.js';
import {
  AFFECT_NO_SUBMISSION_VECTORS,
  AFFECT_SUBMISSION_MODES,
  AFFECT_SUBMISSION_VECTORS,
  AFFECT_VECTOR_MODES,
  affectVectorsFor,
  assertEveryAffectModeHasVectors,
  type AffectVector,
  type AffectVectorMode,
} from '../src/affect-vectors.js';
import { isGatewayReasonCode } from '../src/reason-codes.js';
import { harness } from './support.js';

function affectHarness(affectMode: RunConfig['affectMode']) {
  return harness({ affectMode, affectWindowSchedule: 'every-turn' });
}

/**
 * Runs one vector in one mode. `outOfWindow` and `fromRecipient` vectors
 * exercise SPEC §9.3 rules 2 and 5; every other vector is submitted by the
 * window's own sender inside its open window.
 */
async function runVector(
  mode: AffectVectorMode,
  vector: AffectVector,
): Promise<{
  result: AffectSubmitResult;
  harness: ReturnType<typeof affectHarness>;
}> {
  const h = affectHarness(mode);
  const window = createAffectWindow({
    turn: 1,
    sender: 'baby-a',
    recipient: 'baby-b',
  });
  if (vector.outOfWindow !== 'never-opened') {
    h.gateway.affect.openWindow(window);
  }
  if (vector.outOfWindow === 'already-answered') {
    await h.gateway.affect.submitAffect(window, {
      kind: 'submit_affect',
      publicArtifact: { displayId: 'A1' },
    });
  }
  const sender: BabyRole =
    vector.fromRecipient === true ? window.recipient : window.sender;
  const result = await h.gateway.affect.submitAffectFrom(
    sender,
    window,
    vector.submission,
  );
  return { result, harness: h };
}

describe('ALD-033 criterion 3: affect conformance vectors', () => {
  it('every enabled affect mode contributes accept/reject vectors', () => {
    expect(() => assertEveryAffectModeHasVectors()).not.toThrow();
    for (const mode of AFFECT_VECTOR_MODES) {
      expect(affectVectorsFor(mode)?.length ?? 0).toBeGreaterThan(0);
    }
    expect(() =>
      assertEveryAffectModeHasVectors([
        'declared',
        'sideways' as AffectVectorMode,
      ]),
    ).toThrow(/contribute no conformance vectors/u);
  });

  it('covers every allowlisted display with an acceptance vector', () => {
    for (const displayId of AFFECT_DISPLAY_IDS) {
      expect(
        AFFECT_SUBMISSION_VECTORS.some(
          (vector) =>
            vector.expect === 'accepted' &&
            JSON.stringify(vector.submission).includes(`"${displayId}"`),
        ),
      ).toBe(true);
    }
  });

  for (const mode of AFFECT_SUBMISSION_MODES) {
    describe(`${mode} mode`, () => {
      for (const vector of AFFECT_SUBMISSION_VECTORS) {
        it(vector.name, async () => {
          const { result, harness: h } = await runVector(mode, vector);
          const affectRecords = h.evidence.readEvents(h.context.runId, 'affect');
          const channelRecords = h.evidence.channelEvents(h.context.runId);

          if (vector.expect === 'accepted') {
            expect(result.kind).toBe('accepted');
            expect(affectRecords).toHaveLength(1);
            const event = AffectEventSchema.parse(
              JSON.parse(affectRecords[0]?.canonicalJson ?? '{}'),
            );
            expect(event.affectMode).toBe(mode);
            expect(AFFECT_DISPLAY_IDS).toContain(event.displayId);
            expect(channelRecords).toHaveLength(0);
            return;
          }

          if (result.kind !== 'rejected') {
            throw new Error(`${vector.name} should have been rejected`);
          }
          expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
          expect(isGatewayReasonCode(result.reasonCode)).toBe(true);
          expect(result.rejectedPayloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
          // An `already-answered` vector legitimately has one earlier event.
          expect(affectRecords).toHaveLength(
            vector.outOfWindow === 'already-answered' ? 1 : 0,
          );
          const rejections = channelRecords.filter(
            (event) => event.gatewayValidationResult === 'rejected',
          );
          expect(rejections).toHaveLength(1);
          expect(rejections[0]?.reasonCode).toBe(AFFECT_VIOLATION_REASON);
          // SPEC §9.4: the committed event carries a hash, never content.
          expect(affectRecords.length + rejections.length).toBeGreaterThan(0);
          expect(
            JSON.stringify(rejections[0]),
          ).not.toContain('smuggled');
        });
      }
    });
  }

  for (const mode of ['derived', 'emergent'] as const) {
    describe(`${mode} mode has no submit_affect surface`, () => {
      for (const vector of AFFECT_NO_SUBMISSION_VECTORS) {
        it(vector.name, async () => {
          const { result, harness: h } = await runVector(mode, vector);
          if (result.kind !== 'rejected') {
            throw new Error(`${vector.name} should have been rejected`);
          }
          expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
          expect(h.evidence.readEvents(h.context.runId, 'affect')).toHaveLength(
            0,
          );
        });
      }
    });
  }
});
