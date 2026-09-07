import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
  tailSuccessRate,
  type ConformanceResult,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { validateLearnerDraft } from '../src/drafts.js';
import {
  LearnerConfigurationError,
  UnsupportedLearningSignalError,
} from '../src/errors.js';
import { predictReceiverChoice } from '../src/ledger-prediction.js';
import {
  parseExportedTabularPolicy,
  tabularPolicyShape,
} from '../src/policy.js';
import {
  TabularReinforceAdapter,
  createTabularReinforceAdapterFactory,
} from '../src/tabular-reinforce.js';

/**
 * E11 training hyperparameters. Only the ratio `learningRate / temperature`
 * matters for a tabular softmax policy, so this is one point on a family of
 * equivalent settings; it reaches the pre-registered above-chance threshold on
 * every seed tried. The adapter defaults (0.3 / 1.0) are the documented
 * conservative starting point, not this tuned pair.
 */
const TRAINING_OPTIONS = { learningRate: 1, temperature: 0.5 } as const;
const TRAINING_EPISODES = 3_000;
const TRAINING_SEEDS = [1, 2, 3];

async function initAdapter(
  options: Parameters<typeof createTabularReinforceAdapterFactory>[0] = {},
  overrides: {
    seed?: string;
    symbolInventorySize?: number;
    learningSignal?: 'extrinsic-task' | 'intrinsic-prediction-progress';
    initialPolicy?: unknown;
  } = {},
) {
  const adapter = new TabularReinforceAdapter(options);
  const config = buildConformanceRunConfig('scratch-rl', {
    episodes: 8,
    symbolInventorySize: overrides.symbolInventorySize ?? 8,
    ...(overrides.learningSignal === undefined
      ? {}
      : { learningSignal: overrides.learningSignal }),
  });
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('scratch-rl'),
    seed: overrides.seed ?? 'seed-a',
    symbolInventory: fixedTokenInventory(overrides.symbolInventorySize ?? 8),
    ledger,
    ...(overrides.initialPolicy === undefined
      ? {}
      : { initialPolicy: overrides.initialPolicy }),
  });
  return { adapter, ledger, config };
}

describe('TabularReinforceAdapter conformance (ALD-045)', () => {
  it('passes the adapter conformance harness', async () => {
    const result = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
      { episodes: 40, seed: 'scratch-rl-conformance' },
    );
    expect(result.proposals).toBe(80);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(result.ledgers[role].countOf('intention.recorded')).toBe(40);
      expect(result.ledgers[role].countOf('interpretation.recorded')).toBe(20);
      expect(result.ledgers[role].countOf('hypothesis.created')).toBeGreaterThan(0);
      expect(result.checkpoints[role]).toHaveLength(40);
      for (const checkpoint of result.checkpoints[role]) {
        expect(checkpoint.policyCheckpointRef).toBe(
          `policy:${checkpoint.policyHash}`,
        );
        expect(checkpoint.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      }
    }
  });

  it('exposes updatePolicy, unlike the control tracks (SPEC §6.2)', async () => {
    const { adapter } = await initAdapter();
    expect(typeof adapter.updatePolicy).toBe('function');
  });

  it('starts from an exactly uniform policy', async () => {
    const { adapter, ledger, config } = await initAdapter();
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: [
        [0, 0, 1],
        [1, 1, 0],
      ],
      scenarioRef: 'scenario:x',
    });
    const envelope = await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    const weights = envelope.privateLedgerDraft.content
      .associationWeights as number[];
    expect(weights).toHaveLength(8);
    expect(new Set(weights)).toEqual(new Set([0.125]));
    expect(envelope.privateLedgerDraft.content.probability).toBe(0.125);
    expect(ledger.countOf('term.first_emitted')).toBe(1);
  });
});

describe('TabularReinforceAdapter training (E11)', () => {
  let trained: ConformanceResult[] = [];

  beforeAll(async () => {
    trained = [];
    for (const seed of TRAINING_SEEDS) {
      trained.push(
        await runLearnerAdapterConformance(
          createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
          {
            episodes: TRAINING_EPISODES,
            seed: `e11-train-${seed}`,
            validation: 'none',
            collectDrafts: false,
            recordPolicyHashes: false,
          },
        ),
      );
    }
  }, 60_000);

  it('reaches above-chance referential success on every seed', () => {
    expect(trained).toHaveLength(TRAINING_SEEDS.length);
    for (const result of trained) {
      expect(tailSuccessRate(result, 200)).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('trains both roles privately inside one adapter', () => {
    for (const result of trained) {
      for (const role of ['baby-a', 'baby-b'] as const) {
        const policy = result.adapters[role].exportPolicy() as {
          thetaSender: number[][];
          thetaReceiver: number[][][];
        };
        const senderMoved = policy.thetaSender.some((logits) =>
          logits.some((logit) => logit !== 0),
        );
        const receiverMoved = policy.thetaReceiver.some((table) =>
          table.some((logits) => logits.some((logit) => logit !== 0)),
        );
        expect(senderMoved).toBe(true);
        expect(receiverMoved).toBe(true);
      }
    }
  });

  it('holds its policy constant and stays above 0.8 in held-out evaluation', async () => {
    const source = trained[0] as ConformanceResult;
    const evaluation = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
      {
        episodes: 400,
        seed: 'e11-held-out',
        validation: 'none',
        collectDrafts: false,
        updatePolicy: false,
        initialPolicies: {
          'baby-a': source.adapters['baby-a'].exportPolicy(),
          'baby-b': source.adapters['baby-b'].exportPolicy(),
        },
      },
    );
    expect(evaluation.successRate).toBeGreaterThanOrEqual(0.8);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(new Set(evaluation.policyHashes[role]).size).toBe(1);
      expect(evaluation.checkpoints[role]).toHaveLength(0);
    }
  });

  it('reproduces identical behavior from an exported policy in a derived run', async () => {
    const source = trained[0] as ConformanceResult;
    const policies = {
      'baby-a': source.adapters['baby-a'].exportPolicy(),
      'baby-b': source.adapters['baby-b'].exportPolicy(),
    };
    const roundTripped = JSON.parse(JSON.stringify(policies)) as typeof policies;

    const first = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
      {
        episodes: 40,
        seed: 'e11-derived',
        updatePolicy: false,
        initialPolicies: policies,
      },
    );
    const second = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
      {
        episodes: 40,
        seed: 'e11-derived',
        updatePolicy: false,
        initialPolicies: roundTripped,
      },
    );

    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(first.adapters[role].exportPolicy()).toEqual(policies[role]);
      expect(JSON.stringify(first.ledgers[role].drafts)).toBe(
        JSON.stringify(second.ledgers[role].drafts),
      );
    }
    expect(first.successFlags).toEqual(second.successFlags);
  });
});

describe('TabularReinforceAdapter learning signals', () => {
  it('leaves the policy untouched when updatePolicy is never called', async () => {
    const { adapter, config } = await initAdapter(TRAINING_OPTIONS);
    const before = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      adapter.exportPolicy(),
    );
    for (let turn = 1; turn <= 20; turn += 1) {
      await adapter.observe({
        runId: config.runId,
        turn,
        recipient: 'baby-a',
        encoding: 'opaque-numeric',
        payload: [
          [0, 0, 1],
          [1, 1, 0],
        ],
        scenarioRef: 'scenario:x',
      });
      await adapter.act({
        turn,
        role: 'sender',
        responseBudgetMs: 1_000,
        availableActions: ['emit_symbols'],
      });
      await adapter.onOutcome({
        runId: config.runId,
        turn,
        role: 'sender',
        success: turn % 2 === 0,
        reward: turn % 2 === 0 ? 1 : 0,
        payload: [turn % 2 === 0 ? 1 : 0],
      });
    }
    expect(hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy())).toBe(
      before,
    );
  });

  it('runs the intrinsic prediction-progress mode without reading the task reward', async () => {
    const result = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory({
        ...TRAINING_OPTIONS,
        intrinsicMode: 'prediction-progress',
      }),
      {
        episodes: 200,
        seed: 'e11-intrinsic',
        learningSignal: 'intrinsic-prediction-progress',
        rewardVisibility: 'forbidden',
      },
    );
    expect(result.episodes).toBe(200);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(result.checkpoints[role]).toHaveLength(200);
      expect(result.ledgers[role].countOf('hypothesis.created')).toBeGreaterThan(0);
      // The intrinsic policy still moves: prediction progress is a real signal.
      expect(new Set(result.policyHashes[role]).size).toBeGreaterThan(1);
    }
  });

  it('does read the task reward under extrinsic-task, which the guard proves', async () => {
    await expect(
      runLearnerAdapterConformance(
        createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
        {
          episodes: 4,
          seed: 'e11-extrinsic-guard',
          rewardVisibility: 'forbidden',
        },
      ),
    ).rejects.toThrow(/outcome.reward was read/u);
  });

  it('rejects a learning signal it cannot consume', async () => {
    const { adapter, config } = await initAdapter(TRAINING_OPTIONS);
    await expect(
      adapter.updatePolicy({
        runId: config.runId,
        turns: [1],
        learningSignal: 'intrinsic-curiosity',
      }),
    ).rejects.toThrow(UnsupportedLearningSignalError);
    await expect(
      adapter.updatePolicy({
        runId: config.runId,
        turns: [1],
        learningSignal: 'self-supervised',
      }),
    ).rejects.toThrow(UnsupportedLearningSignalError);
  });

  it('rejects a batch signal that disagrees with the configured mode', async () => {
    const { adapter, config } = await initAdapter(
      { ...TRAINING_OPTIONS, intrinsicMode: 'prediction-progress' },
      { learningSignal: 'intrinsic-prediction-progress' },
    );
    await expect(
      adapter.updatePolicy({
        runId: config.runId,
        turns: [1],
        learningSignal: 'extrinsic-task',
      }),
    ).rejects.toThrow(UnsupportedLearningSignalError);
  });

  it('rejects intrinsicMode paired with an extrinsic-task run at init, rather than at the first updatePolicy call', async () => {
    // Regression: resolveRewardMode used to whitelist this combination at
    // init (returning rewardMode 'intrinsic-prediction-progress'), but
    // UpdateBatch.learningSignal always mirrors RunConfig.learningSignal, so
    // every updatePolicy call was guaranteed to throw
    // UnsupportedLearningSignalError instead. init() must now reject the
    // mismatch itself.
    await expect(
      initAdapter(
        { ...TRAINING_OPTIONS, intrinsicMode: 'prediction-progress' },
        { learningSignal: 'extrinsic-task' },
      ),
    ).rejects.toThrow(LearnerConfigurationError);
  });

  it('rejects an intrinsic-prediction-progress run configured without intrinsicMode, at init', async () => {
    // The two halves of the contract (the adapter option and the run's
    // declared learningSignal) must agree in both directions.
    await expect(
      initAdapter(TRAINING_OPTIONS, {
        learningSignal: 'intrinsic-prediction-progress',
      }),
    ).rejects.toThrow(LearnerConfigurationError);
  });

  it('reports the highest batch turn in the policy checkpoint reference', async () => {
    const { adapter, config } = await initAdapter(TRAINING_OPTIONS);
    const checkpoint = await adapter.updatePolicy({
      runId: config.runId,
      turns: [7, 3, 11],
      learningSignal: 'extrinsic-task',
    });
    expect(checkpoint.turn).toBe(11);
    expect(checkpoint.policyHash).toBe(
      hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy()),
    );
  });

  it('ignores turns it never acted on, so a batch cannot import foreign trajectories', async () => {
    const { adapter, config } = await initAdapter(TRAINING_OPTIONS);
    const before = hashCanonical(
      HASH_DOMAINS.policyCheckpoint,
      adapter.exportPolicy(),
    );
    const checkpoint = await adapter.updatePolicy({
      runId: config.runId,
      turns: [101, 102, 103],
      learningSignal: 'extrinsic-task',
    });
    expect(checkpoint.turn).toBe(103);
    expect(hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy())).toBe(
      before,
    );
  });

  it('rejects an initialPolicy whose shape does not match the run', async () => {
    const { adapter } = await initAdapter(TRAINING_OPTIONS);
    const policy = adapter.exportPolicy();
    await expect(
      initAdapter(TRAINING_OPTIONS, {
        symbolInventorySize: 16,
        initialPolicy: policy,
      }),
    ).rejects.toThrow(LearnerConfigurationError);
  });

  it('refuses a checkpoint written for a different game shape (SPEC §7.4)', async () => {
    const { adapter } = await initAdapter({
      ...TRAINING_OPTIONS,
      attributeCount: 3,
      valuesPerAttribute: 4,
    });
    const policy = adapter.exportPolicy();
    expect(policy.options.attributeCount).toBe(3);

    await expect(
      initAdapter(
        { ...TRAINING_OPTIONS, attributeCount: 2, valuesPerAttribute: 4 },
        { initialPolicy: policy },
      ),
    ).rejects.toThrow(/attributeCount 3 != 2/u);
  });

  it('refuses a checkpoint whose attribute space only shares its cardinality', async () => {
    // Regression: the shape check compared table dimensions alone, and a
    // 2-value/4-attribute space and a 4-value/2-attribute space both give 16
    // type codes — so the parent's logits loaded silently while every type
    // code decoded to a different object (SPEC §7.4 lineage).
    const { adapter } = await initAdapter({
      ...TRAINING_OPTIONS,
      attributeCount: 4,
      valuesPerAttribute: 2,
    });
    const policy = adapter.exportPolicy();
    expect(policy.thetaSender).toHaveLength(16);

    await expect(
      initAdapter(
        { ...TRAINING_OPTIONS, attributeCount: 2, valuesPerAttribute: 4 },
        { initialPolicy: policy },
      ),
    ).rejects.toThrow(/valuesPerAttribute 2 != 4/u);
  });

  it('loads a re-tuned checkpoint but reports the hyperparameter difference', async () => {
    const { adapter } = await initAdapter(TRAINING_OPTIONS);
    const policy = adapter.exportPolicy();

    const { adapter: derived } = await initAdapter(
      { learningRate: 0.3, temperature: 1 },
      { initialPolicy: policy },
    );
    expect(derived.policyLoadDiagnostics).toEqual([
      'learningRate 1 != 0.3',
      'temperature 0.5 != 1',
    ]);
    expect(derived.exportPolicy().thetaSender).toEqual(policy.thetaSender);
  });
});

describe('TabularReinforceAdapter multi-symbol messages', () => {
  it('learns with position-specific receiver tables when messageLength is 2', async () => {
    const options = { ...TRAINING_OPTIONS, messageLength: 2 };
    const result = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(options),
      {
        episodes: 400,
        seed: 'multi-symbol',
        messageLength: 2,
        symbolInventorySize: 8,
        validation: 'none',
      },
    );
    expect(result.config.maxSymbolsPerMessage).toBe(2);

    const policy = parseExportedTabularPolicy(
      result.adapters['baby-a'].exportPolicy(),
    );
    expect(policy.thetaReceiver).toHaveLength(2);
    expect(tabularPolicyShape(policy)).toEqual({
      typeCount: 16,
      symbolCount: 8,
      messageLength: 2,
    });

    const draft = result.ledgers['baby-b'].draftsOf('interpretation.recorded')[0];
    expect(draft?.content.symbols).toHaveLength(2);
    const prediction = predictReceiverChoice(
      result.adapters['baby-b'].exportPolicy(),
      draft?.content.symbols as string[],
      result.symbolInventory,
      draft?.content.candidateTypeCodes as number[],
    );
    expect(prediction.distribution).toHaveLength(4);
    expect(result.successRate).toBeGreaterThan(0.25);
  }, 30_000);

  it('refuses a message longer than the run permits', async () => {
    await expect(
      initAdapter({ ...TRAINING_OPTIONS, messageLength: 4 }),
    ).rejects.toThrow(LearnerConfigurationError);
  });
});

describe('TabularReinforceAdapter hypothesis lifecycle (CONCEPT §11.2)', () => {
  let result: ConformanceResult;

  beforeAll(async () => {
    result = await runLearnerAdapterConformance(
      createTabularReinforceAdapterFactory(TRAINING_OPTIONS),
      {
        episodes: 600,
        seed: 'e11-hypotheses',
        validation: 'none',
      },
    );
  }, 30_000);

  it('appends a creation before any revision of the same term', () => {
    const drafts = result.ledgers['baby-a'].drafts;
    const revised = drafts.filter(
      (draft) => draft.eventType === 'hypothesis.revised',
    );
    expect(revised.length).toBeGreaterThan(0);

    let checkedChain = 0;
    for (const revision of revised) {
      const priorRef = revision.content.priorHypothesisRef as string;
      const newRef = revision.content.hypothesisRef as string;
      const priorIndex = drafts.findIndex(
        (draft) =>
          (draft.eventType === 'hypothesis.created' ||
            draft.eventType === 'hypothesis.revised') &&
          draft.content.hypothesisRef === priorRef,
      );
      expect(priorIndex).toBeGreaterThanOrEqual(0);
      expect(priorIndex).toBeLessThan(drafts.indexOf(revision));
      expect(newRef.startsWith(`${revision.subjectId.replace('symbol:', 'hyp:')}:`))
        .toBe(true);
      const priorVersion = Number(priorRef.split(':').pop());
      expect(Number(newRef.split(':').pop())).toBe(priorVersion + 1);
      const prior = drafts[priorIndex];
      expect(prior?.content.argmaxTypeCode).not.toBe(
        revision.content.argmaxTypeCode,
      );
      checkedChain += 1;
    }
    expect(checkedChain).toBeGreaterThan(0);
  });

  it('records exactly one creation per emitted or received term', () => {
    for (const role of ['baby-a', 'baby-b'] as const) {
      const created = result.ledgers[role].draftsOf('hypothesis.created');
      expect(new Set(created.map((draft) => draft.subjectId)).size).toBe(
        created.length,
      );
      for (const draft of created) {
        expect(draft.content.hypothesisRef).toBe(
          `${draft.subjectId.replace('symbol:', 'hyp:')}:1`,
        );
        expect(draft.content.termRef).toBe(draft.subjectId);
        expect(draft.evidenceRefs).toHaveLength(2);
        expect(draft.evidenceRefs[1]).toMatch(/^outcome:\d+$/u);
      }
    }
  });

  it('preserves contradictory evidence against a confident hypothesis', () => {
    const contradicted = result.ledgers['baby-a'].draftsOf(
      'hypothesis.contradicted',
    );
    expect(contradicted.length).toBeGreaterThan(0);
    for (const draft of contradicted) {
      expect(draft.content.confidence as number).toBeGreaterThan(0.5);
      expect(draft.content.evidenceRef).toMatch(/^outcome:\d+$/u);
      expect(draft.content.hypothesisRef).toMatch(/^hyp:S\d{2,3}:\d+$/u);
    }
  });

  it('writes agent-native content only, with no natural-language gloss', () => {
    for (const role of ['baby-a', 'baby-b'] as const) {
      for (const draft of result.ledgers[role].drafts) {
        expect(draft.contentSchema).toBe('agent-native-ledger');
        expect(() => validateLearnerDraft(draft)).not.toThrow();
        const association = draft.content.associationOverTypeCodes;
        if (Array.isArray(association)) {
          expect(association).toHaveLength(16);
          const total = (association as number[]).reduce(
            (sum, value) => sum + value,
            0,
          );
          expect(total).toBeCloseTo(1, 3);
        }
      }
    }
  });
});
