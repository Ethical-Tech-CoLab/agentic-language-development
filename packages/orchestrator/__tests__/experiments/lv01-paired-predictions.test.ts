/** LV01 paired-case pre-action vectors: build, verify, and forgery rejection. */
import { selectLv01OrdinaryPredictor } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';
import { RecurrentCommunicationModel } from '@ald/learners';
import { fixedTokenInventory, type LedgerEvent } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  buildLv01PairedPredictionPayload,
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  verifyLv01PairedPredictionPayload,
  type Lv01PairedPredictionBuildInput,
} from '../../src/experiments/lv01-paired-predictions.js';

const inventory = fixedTokenInventory(32);
const token = inventory[2] as string;
const candidates = [1, 4, 9, 14];
const refs = ['ref-a', 'ref-b', 'ref-c', 'ref-d'];

function weights(): number[] {
  const array = Array.from({ length: 16 }, () => 0);
  array[1] = 3;
  array[4] = 1;
  return array;
}

function ledgerEvent(partial: Partial<LedgerEvent> & { sequence: number }): LedgerEvent {
  return {
    version: 1,
    runId: 'lv01-paired-prediction-fixture',
    babyId: 'A',
    turn: 0,
    eventType: 'hypothesis.created',
    contentSchema: 'agent-native-ledger',
    subjectId: `symbol:${token}`,
    content: {
      termRef: `symbol:${token}`,
      associationOverTypeCodes: weights(),
    },
    blindingNonce: 'nonce',
    previousEntryHash: hashCanonical('fixture-prev-v1', partial.sequence),
    recordedAt: '2026-09-27T00:00:00.000Z',
    writerKeyId: 'test-key',
    entryHash: hashCanonical('fixture-entry-v1', partial.sequence),
    writerSignature: 'sig',
    ...partial,
  } as LedgerEvent;
}

function frozenModel(): unknown {
  const model = new RecurrentCommunicationModel('lv01-paired-fixture', {
    typeCount: 16,
    symbolCount: 32,
    messageLength: 1,
    hiddenSize: 16,
  });
  model.updatePredictive([{ featureCode: 1, messageSymbolIndices: [2] }]);
  return model.export();
}

function ordinaryInput() {
  const row = (caseId: string, action: number) => ({
    caseId,
    receiverRole: 'baby-a' as const,
    deliveredToken: token,
    candidateTypeCodes: candidates,
    actualSelectedCandidateIndex: action,
  });
  const selection = selectLv01OrdinaryPredictor({
    inventory: [...inventory],
    training: [row('t-1', 0), row('t-2', 1)],
    validationFit: [row('f-1', 0), row('f-2', 0)],
    validationSelection: [row('s-1', 0), row('s-2', 1)],
  });
  return { ordinaryId: selection.refitPredictor.id, ordinaryFit: selection.refitPredictor.fit };
}

function buildInput(overrides: Partial<Lv01PairedPredictionBuildInput> = {}) {
  const records = mapLv01LedgerAssociations(
    [
      ledgerEvent({ sequence: 1, turn: 0 }),
      ledgerEvent({ sequence: 2, turn: 1, eventType: 'hypothesis.revised' }),
    ],
    'baby-a',
    () => true,
  );
  return {
    branch: 'normal' as const,
    predictionTreatment: 'ordinary-records' as const,
    turn: 0,
    receiver: 'baby-a' as const,
    caseId: 'case-1',
    candidateRefs: refs,
    candidateTypeCodes: candidates,
    deliveredToken: token,
    symbolInventory: [...inventory],
    ledgerRecords: records,
    cutoff: deriveLv01LedgerCutoff(records),
    frozenModel: frozenModel(),
    ...ordinaryInput(),
    state: {
      scenarioStateHash: hashCanonical('fixture-state-v1', 's'),
      receiverPolicyHash: hashCanonical('fixture-policy-v1', 'p'),
      trainingLedgerHeads: { babyA: ['a'], babyB: ['b'] },
    },
    scheduleDigest: hashCanonical('schedule-v1', 'none'),
    ...overrides,
  };
}

describe('LV01 paired prediction payload', () => {
  it('commits hand-verifiable native, ordinary, and replay vectors', () => {
    const { payload, commitment } = buildLv01PairedPredictionPayload(buildInput());
    expect(payload.native.source).toBe('training-ledger');
    // weights [3,1,0,0] plus 1e-12 each, normalized over candidates [1,4,9,14].
    const total = 4 + 4e-12;
    expect(payload.native.distribution[0]).toBeCloseTo((3 + 1e-12) / total, 12);
    expect(payload.native.distribution[1]).toBeCloseTo((1 + 1e-12) / total, 12);
    expect(payload.native.selectedAssociation?.sequence).toBe(2);
    expect(payload.ordinary.distribution).toHaveLength(4);
    expect(payload.replay?.parameterCount).toBe(4049);
    expect(commitment).toMatch(/^sha256:/u);
  });

  it('verifies its own payload and rejects forged vectors', () => {
    const input = buildInput();
    const { payload, commitment } = buildLv01PairedPredictionPayload(input);
    const audit = {
      ledgerRecords: input.ledgerRecords,
      frozenModel: input.frozenModel,
      symbolInventory: input.symbolInventory,
    };
    expect(() => verifyLv01PairedPredictionPayload(payload, commitment, audit)).not.toThrow();

    const permuted = {
      ...payload,
      native: { ...payload.native, distribution: [...payload.native.distribution].reverse() },
    };
    expect(() => verifyLv01PairedPredictionPayload(permuted, commitment, audit))
      .toThrow(/native vector/u);

    const reordered = { ...payload, candidateTypeCodes: [4, 1, 9, 14] };
    expect(() => verifyLv01PairedPredictionPayload(reordered, commitment, audit))
      .toThrow(/native vector|ordinary vector/u);

    const movedCutoff = { ...payload, cutoff: { sequence: 99, turn: 99 } };
    expect(() => verifyLv01PairedPredictionPayload(movedCutoff, commitment, audit))
      .toThrow(/cutoff/u);

    const swappedReplay = payload.replay === null ? payload : {
      ...payload,
      replay: { ...payload.replay, distribution: [...payload.native.distribution] },
    };
    expect(() => verifyLv01PairedPredictionPayload(swappedReplay, commitment, audit))
      .toThrow(/replay vector/u);

    expect(() => verifyLv01PairedPredictionPayload(payload, `sha256:${'0'.repeat(64)}`, audit))
      .toThrow(/digest/u);
  });

  it('rejects a tampered ordinary fit', () => {
    const input = buildInput();
    const { payload, commitment } = buildLv01PairedPredictionPayload(input);
    const fit = payload.ordinary.fit;
    if (fit.kind !== 'count') throw new Error('fixture selected a non-count ordinary predictor');
    const tampered = {
      ...payload,
      ordinary: {
        ...payload.ordinary,
        fit: { ...fit, marginal: [100, 1, 1, 1] },
      },
    };
    expect(() => verifyLv01PairedPredictionPayload(tampered, commitment, {
      ledgerRecords: input.ledgerRecords,
      frozenModel: input.frozenModel,
      symbolInventory: input.symbolInventory,
    })).toThrow(/ordinary/u);
  });

  it('maps hypothesis records with checkpoint policy context', () => {
    const events = [
      ledgerEvent({ sequence: 1, turn: 0 }),
      ledgerEvent({
        sequence: 2,
        turn: 1,
        eventType: 'policy.checkpointed',
        subjectId: 'policy:checkpoint',
        content: {},
      }),
      ledgerEvent({ sequence: 3, turn: 2, eventType: 'hypothesis.revised' }),
      ledgerEvent({ sequence: 4, turn: 3, eventType: 'interpretation.recorded' }),
    ];
    const records = mapLv01LedgerAssociations(events, 'baby-a', () => true);
    expect(records.map((record) => record.sequence)).toEqual([1, 3]);
    expect(records[0]?.policyContextHash).toBe(events[0]?.previousEntryHash);
    expect(records[1]?.policyContextHash).toBe(events[1]?.entryHash);
    expect(records[0]?.token).toBe(token);
    expect(deriveLv01LedgerCutoff(records)).toEqual({ sequence: 3, turn: 2 });
  });

  it('fails closed on termRef disagreement and unauthenticated records', () => {
    expect(() => mapLv01LedgerAssociations(
      [ledgerEvent({ sequence: 1, content: { termRef: 'symbol:OTHER', associationOverTypeCodes: weights() } })],
      'baby-a',
      () => true,
    )).toThrow(/termRef/u);
    const records = mapLv01LedgerAssociations(
      [ledgerEvent({ sequence: 1 })],
      'baby-a',
      () => false,
    );
    expect(() => buildLv01PairedPredictionPayload(buildInput({ ledgerRecords: records })))
      .toThrow(/unauthenticated/u);
  });

  it('commits uniform-disabled natives with a null replay when nothing is delivered', () => {
    const { payload, commitment } = buildLv01PairedPredictionPayload(
      buildInput({ deliveredToken: null }),
    );
    expect(payload.native.source).toBe('uniform-disabled');
    expect(payload.native.distribution).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(payload.replay).toBeNull();
    const input = buildInput({ deliveredToken: null });
    expect(() => verifyLv01PairedPredictionPayload(payload, commitment, {
      ledgerRecords: input.ledgerRecords,
      frozenModel: input.frozenModel,
      symbolInventory: input.symbolInventory,
    })).not.toThrow();
  });
});
