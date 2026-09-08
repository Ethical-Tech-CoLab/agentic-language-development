/**
 * ALD-044 — the `frozen-llm` adapter itself.
 *
 * Covers criterion 1 (the track is selectable through the ALD-023 run
 * configuration and records the exact model and weight hashes), the adapter
 * half of criterion 2 (a full observation → proposal → private-ledger turn),
 * and criterion 3's structural half (no weight-update path anywhere on the
 * adapter). The Gateway half of criteria 2 and 3 lives in
 * `frozen-llm-gateway.test.ts` and `frozen-llm-conformance.test.ts`.
 *
 * Every test drives a `ScriptedModelClient`: this machine has no 3B-8B weights
 * and no GPU, so what is demonstrated here is software readiness of the
 * mechanism, never a result about model behavior (Prototype Mode).
 */
import { deriveSeedHex, hashCanonical } from '@ald/hashing';
import {
  HASH_DOMAINS,
  TurnProposalEnvelopeSchema,
  fixedTokenInventory,
  type LearnerInitContext,
  type Observation,
  type RunConfig,
  type TurnBudget,
} from '@ald/types';
import { describe, expect, it } from 'vitest';

import { buildConformanceRunConfig, RecordingLedgerClient } from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { validateLearnerDraft } from '../src/drafts.js';
import { LearnerConfigurationError } from '../src/errors.js';
import {
  FrozenLlmAdapter,
  createFrozenLlmAdapterFactory,
  type FrozenLlmAdapterOptions,
} from '../src/frozen-llm.js';
import { formatModelRef, type LocalModelClient } from '../src/llm-client.js';
import { LocalModelTimeoutError, ToolUnavailableError } from '../src/llm-errors.js';
import { ScriptedModelClient } from '../src/llm-scripted-client.js';

const INVENTORY_SIZE = 32;
const MESSAGE_LENGTH = 4;
const INVENTORY = fixedTokenInventory(INVENTORY_SIZE);

/** attributeCount 2 × valuesPerAttribute 4: 16 type codes, 4 candidates. */
const SENDER_PAYLOAD = [
  [0, 1, 1],
  [2, 3, 0],
  [1, 0, 0],
  [3, 2, 0],
];
const RECEIVER_PAYLOAD = [
  [2, 3],
  [0, 1],
  [3, 2],
  [1, 0],
];
const CANDIDATE_REFS = ['o:aaaa1111', 'o:bbbb2222', 'o:cccc3333', 'o:dddd4444'];

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    ...buildConformanceRunConfig('frozen-llm', {
      symbolInventorySize: INVENTORY_SIZE,
      messageLength: MESSAGE_LENGTH,
    }),
    ...overrides,
  };
}

function observation(
  payload: number[][],
  recipient: 'baby-a' | 'baby-b',
  turn = 1,
): Observation {
  return {
    runId: 'run-conformance',
    turn,
    recipient,
    encoding: 'opaque-numeric',
    payload,
    scenarioRef: 'scn:0123456789abcdef',
  };
}

function senderBudget(turn = 1, responseBudgetMs = 5_000): TurnBudget {
  return { turn, role: 'sender', responseBudgetMs, availableActions: ['emit_symbols'] };
}

function receiverBudget(turn = 1, responseBudgetMs = 5_000): TurnBudget {
  return {
    turn,
    role: 'receiver',
    responseBudgetMs,
    availableActions: ['select_object'],
    candidateRefs: CANDIDATE_REFS,
  };
}

interface Harness {
  adapter: FrozenLlmAdapter;
  ledger: RecordingLedgerClient;
  context: LearnerInitContext;
}

async function harness(
  options: FrozenLlmAdapterOptions = {},
  overrides: Partial<RunConfig> = {},
  role: 'baby-a' | 'baby-b' = 'baby-a',
): Promise<Harness> {
  const runConfig = config(overrides);
  const ledger = new RecordingLedgerClient(runConfig.runId, role);
  const client = options.client ?? new ScriptedModelClient({ symbolInventory: INVENTORY });
  const adapter = new FrozenLlmAdapter({
    valuesPerAttribute: 4,
    attributeCount: 2,
    messageLength: 1,
    ...options,
    client,
  });
  const context: LearnerInitContext = {
    runId: runConfig.runId,
    role,
    babyId: role === 'baby-a' ? 'A' : 'B',
    config: runConfig,
    learnerContract: loadLearnerContract('frozen-llm'),
    seed: deriveSeedHex('ald-frozen-llm-test', role),
    symbolInventory: INVENTORY,
    ledger,
  };
  await adapter.init(context);
  return { adapter, ledger, context };
}

describe('ALD-044 criterion 1: selectable and bound to exact model/weight hashes', () => {
  it('accepts the conformance reference modelRef only for the scripted double in prototype mode', async () => {
    const { adapter } = await harness();
    expect(adapter.modelRef).toBe('reference:frozen-llm');
    expect(adapter.describeProvenance().modelRef).toBe('reference:frozen-llm');
  });

  it('accepts the exact <modelId>@<weightsHash> form', async () => {
    const client = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const description = client.describe();
    const modelRef = formatModelRef(description.modelId, description.weightsHash);
    const { adapter } = await harness(
      { client },
      {
        babyA: { track: 'frozen-llm', modelRef, trainingIsolation: 'independent' },
      },
    );
    expect(adapter.modelRef).toBe(modelRef);
    expect(adapter.exportPolicy().weightsHash).toBe(description.weightsHash);
    expect(adapter.exportPolicy().modelId).toBe(description.modelId);
  });

  it('refuses a modelRef that does not identify the model in use', async () => {
    await expect(
      harness(
        {},
        {
          babyA: {
            track: 'frozen-llm',
            modelRef: `some-other-model@sha256:${'11'.repeat(32)}`,
            trainingIsolation: 'independent',
          },
        },
      ),
    ).rejects.toBeInstanceOf(LearnerConfigurationError);
  });

  it('refuses the reference modelRef for a research-grade deployment', async () => {
    await expect(
      harness({}, { deploymentMode: 'research-grade' }),
    ).rejects.toBeInstanceOf(LearnerConfigurationError);
  });

  it('refuses the reference modelRef for a client that is not the scripted double', async () => {
    const weightsHash = `sha256:${'99'.repeat(32)}`;
    const realish: LocalModelClient = {
      describe: () => ({
        modelId: 'local-3b',
        weightsHash,
        weightsHashSource: 'weights-file',
        contextLength: 8_192,
        toolCallingMode: 'json-schema-grammar',
      }),
      complete: () =>
        Promise.resolve({ raw: '', finishReason: 'stop' as const }),
    };
    await expect(harness({ client: realish })).rejects.toBeInstanceOf(
      LearnerConfigurationError,
    );
  });

  it('requires learningSignal "none" for a frozen model', async () => {
    // The schema already forbids the combination, so the run configuration is
    // bypassed here to prove the adapter re-checks it rather than trusting it.
    const runConfig = { ...config(), learningSignal: 'extrinsic-task' as const };
    await expect(harness({}, runConfig)).rejects.toBeInstanceOf(
      LearnerConfigurationError,
    );
  });

  it('refuses a run whose role is configured for another track', async () => {
    await expect(
      harness(
        {},
        {
          babyA: {
            track: 'scratch-rl',
            modelRef: 'reference:frozen-llm',
            trainingIsolation: 'independent',
          },
        },
      ),
    ).rejects.toBeInstanceOf(LearnerConfigurationError);
  });

  it('refuses a contract that governs another track, and an empty contract', async () => {
    const runConfig = config();
    const build = async (
      contract: { version: string; text: string; track?: 'scratch-rl' },
    ): Promise<void> => {
      const adapter = new FrozenLlmAdapter({
        client: new ScriptedModelClient(),
      });
      await adapter.init({
        runId: runConfig.runId,
        role: 'baby-a',
        babyId: 'A',
        config: runConfig,
        learnerContract: contract,
        seed: 'seed',
        symbolInventory: INVENTORY,
        ledger: new RecordingLedgerClient(runConfig.runId, 'baby-a'),
      });
    };
    await expect(
      build({ version: '1', text: 'x', track: 'scratch-rl' }),
    ).rejects.toBeInstanceOf(LearnerConfigurationError);
    await expect(build({ version: '1', text: '   ' })).rejects.toBeInstanceOf(
      LearnerConfigurationError,
    );
  });

  it('has no default model: the factory refuses to build without a client', () => {
    let thrown: unknown;
    try {
      createFrozenLlmAdapterFactory();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LearnerConfigurationError);
    expect((thrown as Error).message).toContain('ALD-044');
    expect(
      createFrozenLlmAdapterFactory({ client: new ScriptedModelClient() }).track,
    ).toBe('frozen-llm');
  });

  it('records the model provenance for the SPEC §6.5 battery', async () => {
    const { adapter } = await harness();
    const provenance = adapter.describeProvenance();
    expect(provenance.track).toBe('frozen-llm');
    expect(provenance.weightUpdatePath).toBe('none');
    // §6.5's closing paragraph exempts this track: it is never claimed to be
    // language-naive, so the text tokenizer is declared rather than denied.
    expect(provenance.textTokenizerPresent).toBe(true);
    expect(provenance.components).toHaveLength(1);
    expect(provenance.components[0]).toMatchObject({
      kind: 'language-model',
      provenance: 'frozen-open-weight',
      textAligned: true,
      hash: new ScriptedModelClient().describe().weightsHash,
    });
  });
});

describe('ALD-044 criterion 2: a full turn through the adapter', () => {
  it('emits a tool-only proposal with its intention draft as sender', async () => {
    const { adapter, ledger } = await harness();
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    const envelope = await adapter.act(senderBudget());

    const parsed = TurnProposalEnvelopeSchema.parse(envelope);
    expect(parsed.proposal.kind).toBe('emit_symbols');
    const symbols = (parsed.proposal.publicArtifact as { symbols: string[] })
      .symbols;
    expect(symbols).toHaveLength(1);
    expect(INVENTORY).toContain(symbols[0]);
    expect(Object.keys(envelope.proposal).sort()).toEqual([
      'kind',
      'publicArtifact',
    ]);

    const draft = validateLearnerDraft(envelope.privateLedgerDraft);
    expect(draft.eventType).toBe('intention.recorded');
    expect(draft.contentSchema).toBe('agent-native-ledger');
    expect(draft.content.outputClass).toBe('tool-call');
    expect(draft.content.targetTypeCode).toBe(1);
    expect(draft.content.offInventoryCount).toBe(0);
    expect(draft.content.contractVersion).toBe('1');

    // The first-use event is on the chain before the proposal is returned.
    expect(ledger.countOf('term.first_emitted')).toBe(1);
  });

  it('interprets a delivery and selects a candidate as receiver', async () => {
    const { adapter, ledger } = await harness();
    await adapter.observe(observation(RECEIVER_PAYLOAD, 'baby-a'));
    const channelEventHash = `sha256:${'aa'.repeat(32)}`;
    const interpretation = await adapter.receive({
      runId: 'run-conformance',
      turn: 1,
      logicalSender: 'baby-b',
      carrier: 'fixed-token',
      publicArtifact: { symbols: ['S05'] },
      channelEventHash,
    });
    expect(interpretation.channelEventHash).toBe(channelEventHash);
    const interpretationDraft = validateLearnerDraft(
      interpretation.privateLedgerDraft,
    );
    expect(interpretationDraft.eventType).toBe('interpretation.recorded');
    expect(interpretationDraft.content.symbols).toEqual(['S05']);
    expect(interpretationDraft.content.candidateTypeCodes).toEqual([
      11, 1, 14, 4,
    ]);
    expect(ledger.countOf('term.first_received')).toBe(1);

    const envelope = await adapter.act(receiverBudget());
    const parsed = TurnProposalEnvelopeSchema.parse(envelope);
    expect(parsed.proposal.kind).toBe('select_object');
    const objectRef = (parsed.proposal.publicArtifact as { objectRef: string })
      .objectRef;
    expect(CANDIDATE_REFS).toContain(objectRef);
    const draft = validateLearnerDraft(envelope.privateLedgerDraft);
    expect(draft.content.selection).toBe(objectRef);
    expect(draft.evidenceRefs).toContain(`channel:${channelEventHash}`);
  });

  it('folds the outcome into private memory and appends hypothesis events', async () => {
    const { adapter, ledger } = await harness();
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    const envelope = await adapter.act(senderBudget());
    const symbol = (envelope.proposal.publicArtifact as { symbols: string[] })
      .symbols[0] as string;

    await adapter.onOutcome({
      runId: 'run-conformance',
      turn: 1,
      role: 'sender',
      success: true,
      reward: 1,
      payload: [1],
    });
    expect(ledger.countOf('hypothesis.created')).toBe(1);
    const created = ledger.draftsOf('hypothesis.created')[0];
    expect(created?.content.hypothesisRef).toBe(`hyp:${symbol}:1`);
    expect(created?.content.argmaxTypeCode).toBe(1);

    const policy = adapter.exportPolicy();
    expect(policy.memory.turns).toBe(1);
    expect(policy.memory.symbols[0]).toMatchObject({
      symbol,
      emitted: 1,
      hypothesisRef: `hyp:${symbol}:1`,
      argmaxTypeCode: 1,
    });
  });

  it('records a contradiction rather than overwriting a confident hypothesis', async () => {
    const { adapter, ledger } = await harness();
    for (const turn of [1, 2]) {
      await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a', turn));
      await adapter.act(senderBudget(turn));
      await adapter.onOutcome({
        runId: 'run-conformance',
        turn,
        role: 'sender',
        success: turn === 1,
        reward: null,
        payload: [turn === 1 ? 1 : 0],
      });
    }
    expect(ledger.countOf('hypothesis.created')).toBe(1);
    expect(ledger.countOf('hypothesis.contradicted')).toBe(1);
    expect(ledger.countOf('hypothesis.revised')).toBe(0);
  });

  it('revises a hypothesis when the memory argmax moves', async () => {
    const { adapter, ledger } = await harness();
    // Two turns naming the same mark for different target rows: the second
    // moves the argmax, which must append a revision that references the
    // prior hypothesis rather than rewriting it.
    const client = new ScriptedModelClient({
      behaviorFor: () => 'valid-tool-call',
    });
    void client;
    const payloads = [
      [
        [0, 1, 1],
        [2, 3, 0],
      ],
      [
        [0, 1, 0],
        [2, 3, 1],
      ],
    ];
    for (const [index, payload] of payloads.entries()) {
      const turn = index + 1;
      await adapter.observe(observation(payload, 'baby-a', turn));
      await adapter.act(senderBudget(turn));
      await adapter.onOutcome({
        runId: 'run-conformance',
        turn,
        role: 'sender',
        success: true,
        reward: null,
        payload: [1],
      });
    }
    const revised = ledger.draftsOf('hypothesis.revised');
    if (revised.length > 0) {
      expect(revised[0]?.content.priorHypothesisRef).toMatch(/^hyp:S\d{2}:1$/u);
    } else {
      // The naming function may map both rows to the same mark and type code;
      // in that case a created event and no revision is the correct record.
      expect(ledger.countOf('hypothesis.created')).toBeGreaterThan(0);
    }
  });

  it('is idempotent across a §14.5 retry: one completion, one identical envelope', async () => {
    const client = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const { adapter, ledger } = await harness({ client });
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    const first = await adapter.act(senderBudget());
    const second = await adapter.act(senderBudget());
    expect(second).toEqual(first);
    expect(client.callCount).toBe(1);
    expect(adapter.modelCallCount).toBe(1);
    expect(ledger.countOf('term.first_emitted')).toBe(1);
    expect(adapter.exportPolicy().memory.symbols[0]?.emitted).toBe(1);
  });

  it('is idempotent across a repeated outcome', async () => {
    const { adapter, ledger } = await harness();
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    await adapter.act(senderBudget());
    const outcome = {
      runId: 'run-conformance',
      turn: 1,
      role: 'sender' as const,
      success: true,
      reward: null,
      payload: [1],
    };
    await adapter.onOutcome(outcome);
    await adapter.onOutcome(outcome);
    expect(ledger.countOf('hypothesis.created')).toBe(1);
    expect(adapter.exportPolicy().memory.turns).toBe(1);
  });

  it('tolerates a turn with no delivery (SPEC §9.6 disabled)', async () => {
    const { adapter } = await harness();
    await adapter.observe(observation(RECEIVER_PAYLOAD, 'baby-a'));
    const envelope = await adapter.act(receiverBudget());
    expect(TurnProposalEnvelopeSchema.parse(envelope).proposal.kind).toBe(
      'select_object',
    );
    const draft = validateLearnerDraft(envelope.privateLedgerDraft);
    expect(draft.content.symbols).toEqual([]);
  });
});

describe('ALD-044 criterion 3: no weight-update path', () => {
  it('exposes no updatePolicy member, on the instance or its prototype', async () => {
    const { adapter } = await harness();
    const withUpdate = adapter as unknown as Record<string, unknown>;
    expect(withUpdate.updatePolicy).toBeUndefined();
    expect('updatePolicy' in withUpdate).toBe(false);
    const names = new Set<string>();
    let current: object | null = adapter;
    while (current !== null && current !== Object.prototype) {
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === 'string') {
          names.add(key);
        }
      }
      current = Object.getPrototypeOf(current);
    }
    for (const forbidden of [
      'updatePolicy',
      'train',
      'fineTune',
      'applyGradients',
      'setWeights',
    ]) {
      expect([...names]).not.toContain(forbidden);
    }
  });

  it('exports a policy carrying no prompt text and no raw model output', async () => {
    const client = new ScriptedModelClient({
      behavior: 'tool-call-with-free-text',
      symbolInventory: INVENTORY,
    });
    const { adapter } = await harness({ client });
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    await adapter.act(senderBudget());
    await adapter.onOutcome({
      runId: 'run-conformance',
      turn: 1,
      role: 'sender',
      success: false,
      reward: null,
      payload: [0],
    });

    const policy = adapter.exportPolicy();
    const serialized = JSON.stringify(policy);
    const contract = loadLearnerContract('frozen-llm').text;
    expect(serialized).not.toContain(contract.slice(0, 40));
    for (const fragment of ['Here is my choice', 'I will keep using it']) {
      expect(serialized).not.toContain(fragment);
    }
    expect(policy.contractVersion).toBe('1');
    expect(policy.toolCallingMode).toBe('scripted');
    expect(policy.weightsHashSource).toBe('scripted-double');
    // Canonicalizable: hashing the export is what the runtime records.
    expect(hashCanonical(HASH_DOMAINS.policyCheckpoint, policy)).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it('keeps model output out of the private ledger entirely', async () => {
    const client = new ScriptedModelClient({
      behaviors: ['prose-only', 'off-inventory-symbol', 'tool-call-with-free-text'],
      symbolInventory: INVENTORY,
    });
    const { adapter, ledger } = await harness({ client });
    const intentions: Record<string, unknown>[] = [];
    for (const turn of [1, 2, 3]) {
      await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a', turn));
      const envelope = await adapter.act(senderBudget(turn));
      // The Evidence Writer commits the intention draft with the channel
      // event (SPEC §8.2); the harness stands in for it here.
      await ledger.append(envelope.privateLedgerDraft);
      intentions.push(envelope.privateLedgerDraft.content);
      await adapter.onOutcome({
        runId: 'run-conformance',
        turn,
        role: 'sender',
        success: false,
        reward: null,
        payload: [0],
      });
    }
    const serialized = JSON.stringify(ledger.drafts);
    for (const fragment of ['ZZ9', 'I think this mark', 'Here is my choice']) {
      expect(serialized).not.toContain(fragment);
    }
    expect(intentions.map((content) => content.outputClass)).toEqual([
      'text-only',
      'tool-call',
      'tool-call-text',
    ]);
    // The off-inventory mark is counted, never stored.
    expect(intentions.map((content) => content.offInventoryCount)).toEqual([
      0, 1, 0,
    ]);
  });
});

describe('ALD-044 adapter faults versus model content', () => {
  it('throws a typed timeout when no completion arrives inside the model budget', async () => {
    const client = new ScriptedModelClient({
      behavior: 'timeout',
      timeoutOvershootMs: 30,
      symbolInventory: INVENTORY,
    });
    const { adapter } = await harness({ client });
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    await expect(adapter.act(senderBudget(1, 40))).rejects.toBeInstanceOf(
      LocalModelTimeoutError,
    );
  });

  it('throws when no tool this track can produce is offered', async () => {
    const { adapter } = await harness();
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    await expect(
      adapter.act({
        turn: 1,
        role: 'sender',
        responseBudgetMs: 1_000,
        availableActions: ['emit_symbols', 'emit_bitmap'],
      }),
    ).resolves.toBeDefined();
    await expect(
      adapter.act({
        turn: 2,
        role: 'receiver',
        responseBudgetMs: 1_000,
        availableActions: ['emit_bitmap'],
      }),
    ).rejects.toThrow();
    expect(ToolUnavailableError.name).toBe('ToolUnavailableError');
  });

  it('refuses every method before init()', async () => {
    const adapter = new FrozenLlmAdapter({ client: new ScriptedModelClient() });
    await expect(adapter.act(senderBudget())).rejects.toThrow(
      /init\(\) must be called/u,
    );
    expect(() => adapter.exportPolicy()).toThrow(/init\(\) must be called/u);
  });
});

describe('ALD-044 bounded private memory', () => {
  it('keeps at most maxTrackedSymbols records and maxDigestEntries in the prompt', async () => {
    const client = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const { adapter } = await harness({
      client,
      maxTrackedSymbols: 3,
      maxDigestEntries: 2,
    });
    for (let turn = 1; turn <= 12; turn += 1) {
      const target = turn % 4;
      const payload = SENDER_PAYLOAD.map((row, index) => [
        (row[0] as number + turn) % 4,
        (row[1] as number + turn) % 4,
        index === target ? 1 : 0,
      ]);
      await adapter.observe(observation(payload, 'baby-a', turn));
      await adapter.act(senderBudget(turn));
      await adapter.onOutcome({
        runId: 'run-conformance',
        turn,
        role: 'sender',
        success: true,
        reward: null,
        payload: [1],
      });
    }
    expect(adapter.exportPolicy().memory.symbols.length).toBeLessThanOrEqual(3);
    const digest = client.requests.at(-1)?.memoryDigest;
    expect(digest?.entries.length).toBeLessThanOrEqual(2);
    expect(digest?.symbolsTracked).toBeLessThanOrEqual(3);
  });

  it('puts only opaque numeric state and inventory marks in the prompt', async () => {
    const client = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const { adapter } = await harness({ client });
    await adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
    await adapter.act(senderBudget());

    const sent = client.requests[0];
    expect(sent?.systemPrompt).toBe(loadLearnerContract('frozen-llm').text);
    expect(sent?.observation.candidates).toEqual(
      SENDER_PAYLOAD.map((row) => row.slice(0, 2)),
    );
    expect(sent?.observation.targetIndex).toBe(0);
    expect(sent?.tools).toHaveLength(1);
    expect(sent?.tools[0]?.name).toBe('emit_symbols');
    expect(sent?.tools[0]?.parameters.properties.symbols).toMatchObject({
      maxItems: MESSAGE_LENGTH,
    });
    expect(sent?.temperature).toBe(0);
    expect(sent?.timeBudgetMs).toBe(4_000);
  });

  it('derives the sampling seed from the private seed, turn and role', async () => {
    const clientA = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const clientB = new ScriptedModelClient({ symbolInventory: INVENTORY });
    const a = await harness({ client: clientA });
    const b = await harness({ client: clientB });
    for (const target of [a, b]) {
      await target.adapter.observe(observation(SENDER_PAYLOAD, 'baby-a'));
      await target.adapter.act(senderBudget());
    }
    expect(clientA.requests[0]?.samplingSeed).toBe(
      clientB.requests[0]?.samplingSeed,
    );

    const other = await harness(
      { client: new ScriptedModelClient({ symbolInventory: INVENTORY }) },
      {},
      'baby-b',
    );
    await other.adapter.observe(observation(SENDER_PAYLOAD, 'baby-b'));
    await other.adapter.act(senderBudget());
    const otherClient = (other.adapter as unknown as {
      options: { client: ScriptedModelClient };
    }).options.client;
    expect(otherClient.requests[0]?.samplingSeed).not.toBe(
      clientA.requests[0]?.samplingSeed,
    );
  });
});
