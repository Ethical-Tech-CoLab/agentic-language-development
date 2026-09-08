import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  RecordingLedgerClient,
  assertAgentNativeContent,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
  type ConformanceOptions,
  type ConformanceResult,
} from '../src/conformance.js';
import { loadLearnerContract, type TrackLearnerContract } from '../src/contracts.js';
import { validateLearnerDraft } from '../src/drafts.js';
import {
  LearnerConfigurationError,
  UnsupportedLearningSignalError,
} from '../src/errors.js';
import { PREDICTIVE_LOSS_DEFINITION } from '../src/predictive-model.js';
import {
  SELF_SUPERVISED_UPDATE_RECORD_KEYS,
  ScalarRewardRefusedError,
  SelfSupervisedAdapter,
  createSelfSupervisedAdapterFactory,
} from '../src/self-supervised.js';

/**
 * `contracts/learner-contract.self-supervised.v1.md` does not exist yet
 * (SPEC §6.4 requires one per track, and authoring it is outside this
 * workstream's file ownership — see the integrator notes). Every test therefore
 * injects the `scratch-rl` contract body retagged for this track: it is a
 * stand-in for the contract-loading seam, not the track's real contract, and
 * nothing here depends on its text.
 */
function standInContract(): TrackLearnerContract {
  return { ...loadLearnerContract('scratch-rl'), track: 'self-supervised' };
}

function conformanceOptions(
  overrides: ConformanceOptions = {},
): ConformanceOptions {
  return {
    learningSignal: 'self-supervised',
    learnerContract: standInContract(),
    // The harness installs a getter that throws if `OutcomeEvent.reward` is
    // ever read, which is the strongest available proof of ALD-046 cb 1.
    rewardVisibility: 'forbidden',
    ...overrides,
  };
}

async function initAdapter(
  options: Parameters<typeof createSelfSupervisedAdapterFactory>[0] = {},
  overrides: {
    seed?: string;
    symbolInventorySize?: number;
    runId?: string;
    initialPolicy?: unknown;
  } = {},
) {
  const adapter = new SelfSupervisedAdapter(options);
  const symbolInventorySize = overrides.symbolInventorySize ?? 8;
  const config = buildConformanceRunConfig(
    'self-supervised',
    conformanceOptions({
      episodes: 8,
      symbolInventorySize,
      ...(overrides.runId === undefined ? {} : { runId: overrides.runId }),
    }),
  );
  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: standInContract(),
    seed: overrides.seed ?? 'seed-a',
    symbolInventory: fixedTokenInventory(symbolInventorySize),
    ledger,
    ...(overrides.initialPolicy === undefined
      ? {}
      : { initialPolicy: overrides.initialPolicy }),
  });
  return { adapter, ledger, config };
}

const SENDER_PAYLOAD = [
  [0, 0, 1],
  [1, 1, 0],
  [2, 2, 0],
  [3, 3, 0],
];

const RECEIVER_PAYLOAD = [
  [1, 1],
  [0, 0],
  [3, 3],
  [2, 2],
];

const CANDIDATE_REFS = ['1', '2', '3', '4'].map(
  (digit) => `object:sha256:${digit.repeat(64)}`,
);

describe('SelfSupervisedAdapter conformance (ALD-046 cb 2)', () => {
  it('completes full turns and a predictive update on three seeds, in both roles', async () => {
    for (const seed of ['ss-seed-1', 'ss-seed-2', 'ss-seed-3']) {
      const result = await runLearnerAdapterConformance(
        createSelfSupervisedAdapterFactory(),
        conformanceOptions({ episodes: 24, seed }),
      );
      expect(result.proposals).toBe(48);
      for (const role of ['baby-a', 'baby-b'] as const) {
        // roleReversalPeriod 1: every Baby is sender on half the episodes and
        // receiver on the other half, so both halves of the adapter ran.
        expect(result.ledgers[role].countOf('intention.recorded')).toBe(24);
        expect(result.ledgers[role].countOf('interpretation.recorded')).toBe(12);
        expect(
          result.ledgers[role].countOf('hypothesis.created'),
        ).toBeGreaterThan(0);
        expect(result.checkpoints[role]).toHaveLength(24);
        for (const checkpoint of result.checkpoints[role]) {
          expect(checkpoint.policyCheckpointRef).toBe(
            `policy:${checkpoint.policyHash}`,
          );
          expect(checkpoint.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
        }
      }
    }
  });

  it('exposes updatePolicy, as SPEC §6.2 requires for a trainable track', async () => {
    const { adapter } = await initAdapter();
    expect(typeof adapter.updatePolicy).toBe('function');
    expect(adapter.track).toBe('self-supervised');
    expect(createSelfSupervisedAdapterFactory().track).toBe('self-supervised');
  });

  it('folds pairs into the predictive model as the run proceeds', async () => {
    const result = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 12, seed: 'ss-folding' }),
    );
    for (const role of ['baby-a', 'baby-b'] as const) {
      const policy = result.adapters[role].exportPolicy() as {
        model: { pairs: number };
      };
      expect(policy.model.pairs).toBeGreaterThan(0);
    }
    // Every checkpoint hash differs from the one before while pairs accumulate.
    expect(new Set(result.policyHashes['baby-a']).size).toBeGreaterThan(1);
  });

  it('writes agent-native content only, with no natural-language gloss', async () => {
    const result = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 8, seed: 'ss-agent-native' }),
    );
    for (const role of ['baby-a', 'baby-b'] as const) {
      for (const draft of result.ledgers[role].drafts) {
        const validated = validateLearnerDraft(draft);
        expect(validated.contentSchema).toBe('agent-native-ledger');
        assertAgentNativeContent(validated.content, `${role} ${draft.eventType}`);
      }
    }
  });
});

describe('SelfSupervisedAdapter reward refusal (ALD-046 cb 1)', () => {
  it('requires learningSignal "self-supervised" at init', async () => {
    const adapter = new SelfSupervisedAdapter();
    const config = buildConformanceRunConfig('scratch-rl', { episodes: 4 });
    expect(config.learningSignal).toBe('extrinsic-task');
    await expect(
      adapter.init({
        runId: config.runId,
        role: 'baby-a',
        babyId: 'A',
        config,
        learnerContract: standInContract(),
        seed: 'seed-a',
        symbolInventory: fixedTokenInventory(8),
        ledger: new RecordingLedgerClient(config.runId, 'baby-a'),
      }),
    ).rejects.toThrow(UnsupportedLearningSignalError);
  });

  it('refuses an update batch that names any other learning signal', async () => {
    const { adapter, config } = await initAdapter();
    for (const learningSignal of [
      'extrinsic-task',
      'intrinsic-prediction-progress',
      'none',
    ] as const) {
      await expect(
        adapter.updatePolicy({
          runId: config.runId,
          turns: [1],
          learningSignal,
        }),
      ).rejects.toThrow(UnsupportedLearningSignalError);
    }
    await expect(
      adapter.updatePolicy({
        runId: config.runId,
        turns: [],
        learningSignal: 'self-supervised',
      }),
    ).resolves.toMatchObject({ turn: 0 });
  });

  it('refuses a non-null scalar reward on onOutcome', async () => {
    const { adapter, config } = await initAdapter();
    for (const reward of [1, 0, -3, 0.5]) {
      await expect(
        adapter.onOutcome({
          runId: config.runId,
          turn: 1,
          role: 'sender',
          success: true,
          reward,
          payload: [1],
        }),
      ).rejects.toThrow(ScalarRewardRefusedError);
    }
  });

  it('accepts an outcome whose reward is null, as a reward-free run supplies', async () => {
    const { adapter, config } = await initAdapter();
    await expect(
      adapter.onOutcome({
        runId: config.runId,
        turn: 1,
        role: 'sender',
        success: true,
        reward: null,
        payload: [1],
      }),
    ).resolves.toBeUndefined();
  });

  it('never reads the reward field, which the throwing-getter probe proves', async () => {
    const { adapter, config } = await initAdapter();
    const outcome: Record<string, unknown> = {
      runId: config.runId,
      turn: 1,
      role: 'sender',
      success: true,
      payload: [1],
    };
    let reads = 0;
    Object.defineProperty(outcome, 'reward', {
      enumerable: true,
      configurable: true,
      get(): never {
        reads += 1;
        throw new Error('reward was read');
      },
    });
    await adapter.onOutcome(
      outcome as unknown as Parameters<typeof adapter.onOutcome>[0],
    );
    expect(reads).toBe(0);
  });
});

describe('SelfSupervisedAdapter update buffer (ALD-046 cb 3)', () => {
  it('buffers exactly the pre-registered record fields and nothing else', async () => {
    const { adapter, config } = await initAdapter();
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: SENDER_PAYLOAD,
      scenarioRef: 'scenario:sender',
    });
    await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    await adapter.observe({
      runId: config.runId,
      turn: 2,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: RECEIVER_PAYLOAD,
      scenarioRef: 'scenario:receiver',
    });
    await adapter.act({
      turn: 2,
      role: 'receiver',
      responseBudgetMs: 1_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });

    const buffer = adapter.updateBuffer;
    expect(buffer).toHaveLength(2);
    const [sender, receiver] = buffer;
    expect(Object.keys(sender ?? {}).sort()).toEqual([
      ...SELF_SUPERVISED_UPDATE_RECORD_KEYS,
    ]);
    expect(Object.keys(receiver ?? {}).sort()).toEqual(
      SELF_SUPERVISED_UPDATE_RECORD_KEYS.filter(
        (key) => key !== 'targetIndexIfSender',
      ),
    );
    expect(sender?.role).toBe('sender');
    expect(receiver?.role).toBe('receiver');
    expect(receiver?.targetIndexIfSender).toBeUndefined();
  });

  it('carries no success, reward or outcome key in the buffer or the policy', async () => {
    const { adapter, config } = await initAdapter();
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: SENDER_PAYLOAD,
      scenarioRef: 'scenario:sender',
    });
    await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    await adapter.onOutcome({
      runId: config.runId,
      turn: 1,
      role: 'sender',
      success: true,
      reward: null,
      payload: [1],
    });

    const forbidden = /success|reward|outcome/iu;
    expect(JSON.stringify([...adapter.updateBuffer])).not.toMatch(forbidden);
    expect(JSON.stringify(adapter.exportPolicy())).not.toMatch(forbidden);

    const result = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 10, seed: 'ss-structure' }),
    );
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(JSON.stringify(result.adapters[role].exportPolicy())).not.toMatch(
        forbidden,
      );
    }
  });

  it('records the pre-registered loss definition in the exported policy', async () => {
    const { adapter } = await initAdapter();
    const policy = adapter.exportPolicy();
    expect(policy.lossDefinition).toBe(PREDICTIVE_LOSS_DEFINITION);
    expect(policy.pairingRule).toBe('receiver-argmax-self-training:v1');
    expect(policy.track).toBe('self-supervised');
    expect(policy.model.lossDefinition).toBe(PREDICTIVE_LOSS_DEFINITION);
  });

  it('clears a folded turn and cannot import a turn it never acted on', async () => {
    const { adapter, config } = await initAdapter();
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: SENDER_PAYLOAD,
      scenarioRef: 'scenario:sender',
    });
    await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    // A batch naming a turn this Baby never acted on cannot import a foreign
    // trajectory: there is nothing buffered under that turn (SPEC §10.4).
    const checkpoint = await adapter.updatePolicy({
      runId: config.runId,
      turns: [1, 99],
      learningSignal: 'self-supervised',
    });
    expect(checkpoint.turn).toBe(99);
    expect(adapter.updateBuffer).toHaveLength(0);
    expect(adapter.exportPolicy().model.pairs).toBe(1);
  });
});

describe('SelfSupervisedAdapter initialization and determinism (ALD-046 cb 1, ALD-045 cb 1)', () => {
  it('records the random-initialization hash at init, distinct per private seed', async () => {
    const left = await initAdapter({}, { seed: 'seed-left' });
    const right = await initAdapter({}, { seed: 'seed-right' });
    const again = await initAdapter({}, { seed: 'seed-left' });

    expect(left.adapter.initialPolicyHash()).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(left.adapter.initialPolicyHash()).toBe(
      hashCanonical(
        HASH_DOMAINS.policyCheckpoint,
        left.adapter.exportPolicy(),
      ),
    );
    expect(left.adapter.initialPolicyHash()).not.toBe(
      right.adapter.initialPolicyHash(),
    );
    expect(left.adapter.initialPolicyHash()).toBe(
      again.adapter.initialPolicyHash(),
    );
  });

  it('starts from an exactly uniform model when priorNoise is disabled', async () => {
    const { adapter } = await initAdapter({ priorNoise: 0 });
    const weights = adapter.exportPolicy().model.weights;
    expect(weights.flat(2).every((weight) => weight === 0)).toBe(true);
  });

  it('reproduces identical policy hashes and choices from one seed', async () => {
    const options = conformanceOptions({ episodes: 16, seed: 'ss-determinism' });
    const first = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      options,
    );
    const second = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      options,
    );
    expect(second.policyHashes).toEqual(first.policyHashes);
    expect(second.successFlags).toEqual(first.successFlags);
    expect(
      second.ledgers['baby-a'].drafts.map((draft) => draft.blindingNonce),
    ).toEqual(first.ledgers['baby-a'].drafts.map((draft) => draft.blindingNonce));
  });

  it('diverges between two different run seeds', async () => {
    const left = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 16, seed: 'ss-left' }),
    );
    const right = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 16, seed: 'ss-right' }),
    );
    expect(right.policyHashes['baby-a']).not.toEqual(
      left.policyHashes['baby-a'],
    );
  });

  it('reproduces identical behaviour from an exported policy in a derived run (SPEC §7.4)', async () => {
    const warm = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({ episodes: 12, seed: 'ss-warm' }),
    );
    const initialPolicies = {
      'baby-a': warm.adapters['baby-a'].exportPolicy(),
      'baby-b': warm.adapters['baby-b'].exportPolicy(),
    };
    const derived = conformanceOptions({
      episodes: 8,
      seed: 'ss-derived',
      runId: 'run-ss-derived',
      initialPolicies,
    });
    const first = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      derived,
    );
    const second = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      derived,
    );
    const fresh = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory(),
      conformanceOptions({
        episodes: 8,
        seed: 'ss-derived',
        runId: 'run-ss-derived',
      }),
    );

    expect(second.policyHashes).toEqual(first.policyHashes);
    expect(first.policyHashes['baby-a']).not.toEqual(fresh.policyHashes['baby-a']);
    // A derived run starts a fresh ledger chain, so it re-records first uses.
    expect(first.ledgers['baby-a'].countOf('term.first_emitted')).toBeGreaterThan(
      0,
    );
  });

  it('refuses a checkpoint written for a different attribute space', async () => {
    const { adapter } = await initAdapter({
      attributeCount: 2,
      valuesPerAttribute: 4,
    });
    const policy = adapter.exportPolicy();
    await expect(
      initAdapter(
        { attributeCount: 4, valuesPerAttribute: 2 },
        { initialPolicy: policy },
      ),
    ).rejects.toThrow(LearnerConfigurationError);
  });

  it('reports a re-tuned checkpoint difference rather than refusing it', async () => {
    const { adapter } = await initAdapter({ temperature: 1 });
    const policy = adapter.exportPolicy();
    const loaded = await initAdapter(
      { temperature: 0.5 },
      { initialPolicy: policy },
    );
    expect(loaded.adapter.policyLoadDiagnostics).toEqual([
      'temperature 1 != 0.5',
    ]);
  });
});

describe('SelfSupervisedAdapter provenance (SPEC §6.5)', () => {
  it('declares a fully random-initialized, tokenizer-free path', async () => {
    const { adapter } = await initAdapter();
    const provenance = adapter.describeProvenance();
    expect(provenance.track).toBe('self-supervised');
    expect(provenance.modelRef).toBe('reference:self-supervised');
    expect(provenance.textTokenizerPresent).toBe(false);
    expect(provenance.textAlignedEncoderPresent).toBe(false);
    expect(provenance.weightUpdatePath).toBe('private-buffers-only');
    expect(provenance.components).toHaveLength(2);
    for (const component of provenance.components) {
      expect(component.provenance).toBe('random-init');
      expect(component.textAligned).toBe(false);
      expect(component.hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
    expect(provenance.components.map((component) => component.kind)).toEqual([
      'world-model',
      'communication-policy',
    ]);
    expect(
      new Set(provenance.components.map((component) => component.hash)).size,
    ).toBe(2);
  });
});

describe('SelfSupervisedAdapter curriculum (E22, SPEC §18)', () => {
  it('honours learningRate, temperature and explorationRate', async () => {
    const { adapter } = await initAdapter();
    await adapter.applyCurriculumStage({
      stageIndex: 0,
      startTurn: 0,
      learnerOptions: { learningRate: 3, temperature: 0.25, explorationRate: 0 },
    });
    const options = adapter.exportPolicy().options;
    expect(options.learningRate).toBe(3);
    expect(options.temperature).toBe(0.25);
    expect(options.explorationRate).toBe(0);
    expect(adapter.exportPolicy().model.options.countIncrement).toBe(3);
  });

  it('rejects memoryCapacity rather than ignoring it', async () => {
    const { adapter } = await initAdapter();
    await expect(
      adapter.applyCurriculumStage({
        stageIndex: 1,
        startTurn: 10,
        learnerOptions: { memoryCapacity: 32 },
      }),
    ).rejects.toThrow(/memoryCapacity/u);
  });

  it('rejects a staged bandwidth its tables were not built for', async () => {
    const { adapter } = await initAdapter();
    await expect(
      adapter.applyCurriculumStage({
        stageIndex: 1,
        startTurn: 10,
        maxSymbolsPerMessage: 2,
      }),
    ).rejects.toThrow(/maxSymbolsPerMessage/u);
    await expect(
      adapter.applyCurriculumStage({
        stageIndex: 1,
        startTurn: 10,
        maxSymbolsPerMessage: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('freezes the model for a consolidation stage and discards its turns', async () => {
    const { adapter, config } = await initAdapter();
    await adapter.applyCurriculumStage({
      stageIndex: 2,
      startTurn: 0,
      consolidation: true,
    });
    await adapter.observe({
      runId: config.runId,
      turn: 1,
      recipient: 'baby-a',
      encoding: 'opaque-numeric',
      payload: SENDER_PAYLOAD,
      scenarioRef: 'scenario:sender',
    });
    await adapter.act({
      turn: 1,
      role: 'sender',
      responseBudgetMs: 1_000,
      availableActions: ['emit_symbols'],
    });
    const before = adapter.exportPolicy().model.weights;
    await adapter.updatePolicy({
      runId: config.runId,
      turns: [1],
      learningSignal: 'self-supervised',
    });
    expect(adapter.exportPolicy().model.weights).toEqual(before);
    expect(adapter.exportPolicy().model.pairs).toBe(0);
    expect(adapter.updateBuffer).toHaveLength(0);
  });
});

/**
 * E12 measurement, not a claim. The notebook's own hypothesis is that
 * reward-free mutual prediction "may produce weaker task-directed coordination
 * than RL"; nothing here is tuned, and the assertions below are only that the
 * two-adapter self-play game is deterministic and stays inside its own
 * definition of success. The observed rate is recorded in the task notes as a
 * data point.
 */
describe('SelfSupervisedAdapter self-play measurement (E12)', () => {
  const seeds = ['e12-1', 'e12-2', 'e12-3'];
  const results: ConformanceResult[] = [];

  beforeAll(async () => {
    for (const seed of seeds) {
      results.push(
        await runLearnerAdapterConformance(
          createSelfSupervisedAdapterFactory({ explorationRate: 0.05 }),
          conformanceOptions({
            episodes: 600,
            seed,
            validation: 'none',
            collectDrafts: false,
          }),
        ),
      );
    }
  });

  it('reports a success rate in [0, 1] on every seed without tuning to a target', () => {
    expect(results).toHaveLength(seeds.length);
    for (const result of results) {
      expect(result.successRate).toBeGreaterThanOrEqual(0);
      expect(result.successRate).toBeLessThanOrEqual(1);
      expect(result.successFlags).toHaveLength(600);
    }
  });

  it('reproduces the same self-play trajectory from the same seed', async () => {
    const seed = seeds[0] as string;
    const repeat = await runLearnerAdapterConformance(
      createSelfSupervisedAdapterFactory({ explorationRate: 0.05 }),
      conformanceOptions({
        episodes: 600,
        seed,
        validation: 'none',
        collectDrafts: false,
      }),
    );
    expect(repeat.successFlags).toEqual(
      (results[0] as ConformanceResult).successFlags,
    );
  });
});
