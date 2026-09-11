import { fixedTokenInventory, type LearnerInitContext } from '@ald/types';
import { describe, expect, it } from 'vitest';

import { generativeBitmapModule } from '../../gateway/src/carriers/bitmap.js';
import { generativeCanvasModule } from '../../gateway/src/carriers/canvas.js';
import { generativeToneModule } from '../../gateway/src/carriers/tone.js';
import type { CarrierModule } from '../../gateway/src/carrier-modules.js';
import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
} from '../src/conformance.js';
import {
  CARRIER_EMIT_KIND,
  createCarrierSupport,
  type CarrierAdapterSupport,
  type CarrierMode,
} from '../src/carrier-support.js';
import { loadLearnerContract } from '../src/contracts.js';
import { resolveGameShape } from '../src/game.js';
import { ExportedRecurrentScratchPolicySchema } from '../src/recurrent-scratch-policy.js';
import { createRecurrentActorCriticAdapterFactory } from '../src/tabular-reinforce.js';

const GENERATIVE_MODULES: Readonly<Record<CarrierMode, CarrierModule | undefined>> = {
  'fixed-token': undefined,
  'fixed-glyph': undefined,
  'generative-bitmap': generativeBitmapModule,
  'generative-canvas': generativeCanvasModule,
  'generative-tone': generativeToneModule,
};

function supportFor(
  carrier: CarrierMode,
  seed: string,
  options: { acquirePartnerForms?: boolean; modifyAcquiredForms?: boolean } = {},
): { support: CarrierAdapterSupport; context: LearnerInitContext } {
  const config = buildConformanceRunConfig('scratch-rl', {
    carrierMode: carrier,
    messageLength: 1,
    symbolInventorySize: 8,
    maxStrokes: 8,
  });
  const context: LearnerInitContext = {
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('scratch-rl'),
    seed,
    symbolInventory: fixedTokenInventory(8),
    ledger: new RecordingLedgerClient(config.runId, 'baby-a'),
  };
  return {
    support: createCarrierSupport(
      context,
      resolveGameShape({ messageLength: 1 }, 1),
      { inventedFormCount: 8, ...options },
    ),
    context,
  };
}

function assertAcceptedByGateway(
  module: CarrierModule,
  context: LearnerInitContext,
  artifact: unknown,
): void {
  const result = module.validate(
    {
      kind: CARRIER_EMIT_KIND[context.config.carrierMode],
      publicArtifact: artifact,
    },
    {
      runContext: {
        runId: context.runId,
        config: context.config,
        symbolInventory: [...context.symbolInventory],
        seed: context.seed,
      },
      maxSymbolRepeats: 4,
    },
  );
  expect(result).toMatchObject({ ok: true });
}

describe.each([
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
] as const)('%s learnable form bank (E13 qualification)', (carrier) => {
  it('acquires, exactly imitates, modifies, validates, and restores forms', () => {
    const source = supportFor(carrier, `${carrier}-source`);
    const learner = supportFor(carrier, `${carrier}-learner`, {
      acquirePartnerForms: true,
      modifyAcquiredForms: true,
    });
    const artifact = source.support.artifactForForms([0]);
    const before = learner.support.exportLearningState();

    const firstObservation = learner.support.observeDelivery(artifact, 3);
    expect(firstObservation.marks[0]?.formIndex).toBeNull();
    expect(learner.support.exportLearningState()).toEqual(before);

    const changes = learner.support.commitObservedForms([3]);
    expect(changes.map((change) => change.kind)).toEqual([
      'acquired',
      'modified',
    ]);
    const acquired = changes[0];
    const modified = changes[1];
    if (acquired === undefined || modified === undefined) {
      throw new Error('expected one acquired and one modified form');
    }
    expect(acquired.markHash).toBe(firstObservation.artifactMarkHash);
    expect(modified.parentMarkHash).toBe(acquired.markHash);
    expect(modified.markHash).not.toBe(acquired.markHash);

    const recognized = learner.support.parseDelivery(artifact).marks[0];
    expect(recognized).toMatchObject({
      formIndex: acquired.slot,
      origin: 'acquired',
    });
    expect(learner.support.artifactForForms([acquired.slot])).toEqual(artifact);

    const module = GENERATIVE_MODULES[carrier];
    if (module === undefined) throw new Error(`missing module for ${carrier}`);
    assertAcceptedByGateway(module, learner.context, artifact);
    assertAcceptedByGateway(
      module,
      learner.context,
      learner.support.artifactForForms([modified.slot]),
    );

    const checkpoint = learner.support.exportLearningState();
    const restored = supportFor(carrier, `${carrier}-learner`, {
      acquirePartnerForms: true,
      modifyAcquiredForms: true,
    });
    restored.support.restoreLearningState(JSON.parse(JSON.stringify(checkpoint)));
    expect(restored.support.exportLearningState()).toEqual(checkpoint);
    expect(restored.support.formInventoryHash).toBe(
      learner.support.formInventoryHash,
    );

    const corrupted = JSON.parse(JSON.stringify(checkpoint));
    corrupted.slots[0].artifact.unexpected = 'not-a-carrier-field';
    expect(() => restored.support.restoreLearningState(corrupted)).toThrow(
      /Unrecognized key|inconsistent or duplicate forms/u,
    );

    const evaluationSource = supportFor(carrier, `${carrier}-evaluation-source`);
    restored.support.observeDelivery(
      evaluationSource.support.artifactForForms([0]),
      9,
    );
    expect(restored.support.exportLearningState()).toEqual(checkpoint);
  });
});

describe('carrier learning controls', () => {
  it('keeps symbolic inventories immutable and rejects modification without acquisition', () => {
    const symbolic = supportFor('fixed-token', 'symbolic', {
      acquirePartnerForms: true,
      modifyAcquiredForms: true,
    });
    const before = symbolic.support.exportLearningState();
    symbolic.support.observeDelivery({ symbols: ['S01'] }, 1);
    expect(symbolic.support.commitObservedForms([1])).toEqual([]);
    expect(symbolic.support.exportLearningState()).toEqual(before);

    expect(() =>
      supportFor('generative-bitmap', 'invalid-options', {
        modifyAcquiredForms: true,
      }),
    ).toThrow(/requires acquirePartnerForms/u);
  });

  it.each([
    'generative-bitmap',
    'generative-canvas',
    'generative-tone',
  ] as const)('runs the recurrent adapter contract over %s', async (carrier) => {
    const result = await runLearnerAdapterConformance(
      createRecurrentActorCriticAdapterFactory({
        learningRate: 0.01,
        recurrent: { hiddenSize: 8, ppoEpochs: 2 },
        inventedFormCount: 8,
        acquirePartnerForms: true,
        modifyAcquiredForms: true,
      }),
      {
        carrierMode: carrier,
        messageLength: 1,
        symbolInventorySize: 8,
        episodes: 12,
        seed: `${carrier}-adapter`,
      },
    );

    for (const role of ['baby-a', 'baby-b'] as const) {
      const policy = ExportedRecurrentScratchPolicySchema.parse(
        result.adapters[role].exportPolicy(),
      );
      expect(policy.version).toBe(2);
      if (policy.version !== 2) throw new Error('expected carrier-state policy');
      expect(policy.carrierState.carrier).toBe(carrier);
      expect(
        policy.carrierState.slots.some((slot) => slot.origin === 'acquired'),
      ).toBe(true);
      expect(
        policy.carrierState.slots.some((slot) => slot.origin === 'modified'),
      ).toBe(true);
    }
  });
});
