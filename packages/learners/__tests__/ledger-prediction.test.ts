import { fixedTokenInventory } from '@ald/types';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  runLearnerAdapterConformance,
  type ConformanceResult,
} from '../src/conformance.js';
import { LearnerStateError } from '../src/errors.js';
import {
  predictReceiverChoice,
  predictSenderSymbol,
} from '../src/ledger-prediction.js';
import { parseExportedTabularPolicy } from '../src/policy.js';
import { createTabularReinforceAdapterFactory } from '../src/tabular-reinforce.js';

const OPTIONS = { learningRate: 1, temperature: 0.5 } as const;

describe('ledger-to-prediction functions (RESEARCH §6.8)', () => {
  let evaluation: ConformanceResult;
  let policies: Record<'baby-a' | 'baby-b', unknown>;

  beforeAll(async () => {
    const trained = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(OPTIONS),
      {
        episodes: 400,
        seed: 'prediction-train',
        validation: 'none',
        collectDrafts: false,
        recordPolicyHashes: false,
      },
    );
    policies = {
      'baby-a': trained.adapters['baby-a'].exportPolicy(),
      'baby-b': trained.adapters['baby-b'].exportPolicy(),
    };
    evaluation = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(OPTIONS),
      {
        episodes: 60,
        seed: 'prediction-eval',
        updatePolicy: false,
        initialPolicies: policies,
      },
    );
  }, 30_000);

  it('matches the receiver argmax recorded in every interpretation event', () => {
    let checked = 0;
    for (const role of ['baby-a', 'baby-b'] as const) {
      for (const draft of evaluation.ledgers[role].draftsOf(
        'interpretation.recorded',
      )) {
        const prediction = predictReceiverChoice(
          policies[role],
          draft.content.symbols as string[],
          evaluation.symbolInventory,
          draft.content.candidateTypeCodes as number[],
        );
        expect(prediction.index).toBe(draft.content.argmaxCandidateIndex);
        const recorded = draft.content.inferredDistribution as number[];
        prediction.distribution.forEach((value, index) => {
          expect(value).toBeCloseTo(recorded[index] as number, 6);
        });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('is computed from exported policy state alone, so a JSON round trip is enough', () => {
    const draft = evaluation.ledgers['baby-a'].draftsOf(
      'interpretation.recorded',
    )[0];
    const symbols = draft?.content.symbols as string[];
    const typeCodes = draft?.content.candidateTypeCodes as number[];
    const roundTripped = JSON.parse(
      JSON.stringify(policies['baby-a']),
    ) as unknown;
    expect(
      predictReceiverChoice(
        roundTripped,
        symbols,
        evaluation.symbolInventory,
        typeCodes,
      ),
    ).toEqual(
      predictReceiverChoice(
        policies['baby-a'],
        symbols,
        evaluation.symbolInventory,
        typeCodes,
      ),
    );
  });

  it('predicts the sender symbol as the argmax of its own table', () => {
    const policy = parseExportedTabularPolicy(policies['baby-a']);
    const inventory = evaluation.symbolInventory;
    for (let typeCode = 0; typeCode < policy.thetaSender.length; typeCode += 1) {
      const prediction = predictSenderSymbol(policy, typeCode, inventory);
      const logits = policy.thetaSender[typeCode] as number[];
      const best = logits.indexOf(Math.max(...logits));
      expect(prediction.index).toBe(best);
      expect(prediction.symbol).toBe(inventory[best]);
      expect(prediction.distribution).toHaveLength(logits.length);
    }
  });

  it('returns the lowest index for an untrained, uniform policy', () => {
    const uniform = {
      version: 1,
      thetaSender: [
        [0, 0],
        [0, 0],
      ],
      thetaReceiver: [
        [
          [0, 0],
          [0, 0],
        ],
      ],
      baseline: 0,
      options: {
        valuesPerAttribute: 2,
        attributeCount: 1,
        messageLength: 1,
        learningRate: 0.3,
        baselineDecay: 0.9,
        temperature: 1,
      },
    };
    const inventory = fixedTokenInventory(2);
    expect(predictSenderSymbol(uniform, 1, inventory).index).toBe(0);
    const receiver = predictReceiverChoice(uniform, ['S02'], inventory, [1, 0]);
    expect(receiver.index).toBe(0);
    expect(receiver.distribution).toEqual([0.5, 0.5]);
  });

  it('rejects inputs it cannot ground in the policy', () => {
    const policy = policies['baby-a'];
    const inventory = evaluation.symbolInventory;
    expect(() =>
      predictReceiverChoice(policy, ['S99'], inventory, [0, 1]),
    ).toThrow(LearnerStateError);
    expect(() =>
      predictReceiverChoice(policy, ['S01', 'S02'], inventory, [0, 1]),
    ).toThrow(LearnerStateError);
    expect(() => predictReceiverChoice(policy, ['S01'], inventory, [99])).toThrow(
      LearnerStateError,
    );
    expect(() => predictReceiverChoice(policy, ['S01'], inventory, [])).toThrow(
      LearnerStateError,
    );
    expect(() => predictSenderSymbol(policy, -1, inventory)).toThrow(
      LearnerStateError,
    );
    expect(() => predictSenderSymbol(policy, 0, ['S01'])).toThrow(
      LearnerStateError,
    );
  });

  it('rejects a malformed or ragged policy', () => {
    expect(() => parseExportedTabularPolicy({ version: 2 })).toThrow();
    expect(() =>
      parseExportedTabularPolicy({
        version: 1,
        thetaSender: [[0, 0], [0]],
        thetaReceiver: [[[0, 0], [0, 0]]],
        baseline: 0,
        options: {
          valuesPerAttribute: 2,
          attributeCount: 1,
          messageLength: 1,
          learningRate: 0.3,
          baselineDecay: 0.9,
          temperature: 1,
        },
      }),
    ).toThrow(/rectangular/u);
  });
});
