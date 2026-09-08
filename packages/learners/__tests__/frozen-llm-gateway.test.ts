/**
 * ALD-044 criterion 2 (end-to-end half) and criterion 3 (Gateway-conformance
 * half): every completion shape the frozen model can produce is carried
 * through a real `SymbolGatewayImpl` over a real `InMemoryEvidenceWriter`, and
 * the reason code the §9.4 rejection framework assigns is asserted.
 *
 * This is the executable form of the mapping table documented in
 * `src/llm-prompt.ts`. It is also the EXPERIMENT-NOTEBOOK.md E10 "Prohibited
 * attempts" plumbing: the adapter forwards a violating completion unsanitized
 * on purpose (SPEC §10.2 forbids "sanitized and passed through"), so the
 * violation becomes an append-only `channel.rejected` event carrying a reason
 * code and a payload hash — and never the attempted content (§9.4).
 *
 * `@ald/gateway` is imported by these tests only; `@ald/learners`'s `src/`
 * does not depend on it, because a learner adapter runs inside the Baby's
 * isolation boundary and reaches the Gateway through the runtime (SPEC §6.3).
 */
import {
  GATEWAY_REASON_CODES,
  InMemoryEvidenceWriter,
  StepClock,
  SymbolGatewayImpl,
} from '@ald/gateway';
import { deriveSeedHex } from '@ald/hashing';
import {
  TurnProposalEnvelopeSchema,
  fixedTokenInventory,
  type GatewayRunContext,
  type GatewayTurnContext,
  type Observation,
  type RunConfig,
  type TurnBudget,
} from '@ald/types';
import { describe, expect, it } from 'vitest';

import { buildConformanceRunConfig, RecordingLedgerClient } from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import { FrozenLlmAdapter } from '../src/frozen-llm.js';
import {
  ScriptedModelClient,
  type ScriptedBehavior,
} from '../src/llm-scripted-client.js';

const INVENTORY_SIZE = 32;
const MAX_SYMBOLS = 4;
const INVENTORY = fixedTokenInventory(INVENTORY_SIZE);

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

/**
 * SPEC §9.1 free text alongside a valid tool call, prose, an off-inventory
 * mark, an over-long message, an extra artifact field, another carrier's
 * kind, and unparseable output — one row per prohibited-attempt category.
 */
const SENDER_MAPPING: readonly [ScriptedBehavior, string | 'accepted'][] = [
  ['valid-tool-call', 'accepted'],
  ['tool-call-with-free-text', 'free-text-present'],
  ['prose-only', 'free-text-present'],
  ['off-inventory-symbol', 'symbol-not-in-inventory'],
  ['oversized-payload', 'message-too-long'],
  ['extra-artifact-field', 'unexpected-artifact-field'],
  ['wrong-carrier-kind', 'carrier-mismatch'],
  ['malformed-json', 'invalid-envelope'],
  ['empty-output', 'invalid-envelope'],
];

function runConfig(): RunConfig {
  return buildConformanceRunConfig('frozen-llm', {
    symbolInventorySize: INVENTORY_SIZE,
    messageLength: MAX_SYMBOLS,
  });
}

interface Harness {
  adapter: FrozenLlmAdapter;
  gateway: SymbolGatewayImpl;
  evidence: InMemoryEvidenceWriter;
  config: RunConfig;
  ledger: RecordingLedgerClient;
}

async function harness(behavior: ScriptedBehavior): Promise<Harness> {
  const config = runConfig();
  const context: GatewayRunContext = {
    runId: config.runId,
    config,
    symbolInventory: INVENTORY,
    seed: config.randomSeed,
  };
  const evidence = InMemoryEvidenceWriter.forRun(config.runId, new StepClock());
  evidence.registerRun(config);
  const gateway = new SymbolGatewayImpl(context, evidence);

  const ledger = new RecordingLedgerClient(config.runId, 'baby-a');
  const adapter = new FrozenLlmAdapter({
    client: new ScriptedModelClient({ behavior, symbolInventory: INVENTORY }),
    valuesPerAttribute: 4,
    attributeCount: 2,
    messageLength: 1,
  });
  await adapter.init({
    runId: config.runId,
    role: 'baby-a',
    babyId: 'A',
    config,
    learnerContract: loadLearnerContract('frozen-llm'),
    seed: deriveSeedHex(config.randomSeed, 'baby-a'),
    symbolInventory: INVENTORY,
    ledger,
  });
  return { adapter, gateway, evidence, config, ledger };
}

function observation(
  payload: number[][],
  runId: string,
  turn = 1,
): Observation {
  return {
    runId,
    turn,
    recipient: 'baby-a',
    encoding: 'opaque-numeric',
    payload,
    scenarioRef: 'scn:0123456789abcdef',
  };
}

function senderBudget(turn = 1): TurnBudget {
  return {
    turn,
    role: 'sender',
    responseBudgetMs: 5_000,
    availableActions: ['emit_symbols'],
  };
}

function turnContext(turn = 1): GatewayTurnContext {
  return { turn, sender: 'baby-a', recipient: 'baby-b' };
}

describe('ALD-044 × ALD-034: completion shape → Gateway reason code', () => {
  it.each(SENDER_MAPPING)(
    'a %s completion is %s at the Gateway',
    async (behavior, expected) => {
      const { adapter, gateway, config } = await harness(behavior);
      await adapter.observe(observation(SENDER_PAYLOAD, config.runId));
      const envelope = await adapter.act(senderBudget());
      const result = await gateway.submitProposal(turnContext(), envelope);

      if (expected === 'accepted') {
        expect(result.kind).toBe('accepted');
        return;
      }
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') {
        return;
      }
      expect(result.reasonCode).toBe(expected);
      expect(GATEWAY_REASON_CODES).toContain(result.reasonCode);
      expect(result.rejectedPayloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    },
  );

  it('commits an accepted proposal with the model marks and the intention event', async () => {
    const { adapter, gateway, evidence, config } = await harness('valid-tool-call');
    await adapter.observe(observation(SENDER_PAYLOAD, config.runId));
    const envelope = await adapter.act(senderBudget());
    const result = await gateway.submitProposal(turnContext(), envelope);

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') {
      return;
    }
    const marks = (envelope.proposal.publicArtifact as { symbols: string[] })
      .symbols;
    expect(result.delivery?.publicArtifact).toEqual({ symbols: marks });
    expect(result.senderLedgerEvent.eventType).toBe('intention.recorded');
    expect(result.senderLedgerEvent.contentSchema).toBe('agent-native-ledger');
    expect(evidence.channelEvents(config.runId)).toHaveLength(1);
    expect(evidence.channelEvents(config.runId)[0]?.gatewayValidationResult).toBe(
      'accepted',
    );
    expect(evidence.ledgerEvents(config.runId, 'A')).toHaveLength(1);
  });

  it('stores no attempted content for any rejected completion (SPEC §9.4)', async () => {
    const forbidden = [
      'ZZ9',
      'annotationCode',
      'I think this mark',
      'Here is my choice',
      '{"symbols": ["',
    ];
    for (const [behavior, expected] of SENDER_MAPPING) {
      if (expected === 'accepted') {
        continue;
      }
      const { adapter, gateway, evidence, config } = await harness(behavior);
      await adapter.observe(observation(SENDER_PAYLOAD, config.runId));
      await gateway.submitProposal(
        turnContext(),
        await adapter.act(senderBudget()),
      );
      const events = evidence.channelEvents(config.runId);
      expect(events).toHaveLength(1);
      expect(events[0]?.gatewayValidationResult).toBe('rejected');
      const serialized = JSON.stringify(events[0]);
      for (const fragment of forbidden) {
        expect(serialized, `${behavior} leaked ${fragment}`).not.toContain(
          fragment,
        );
      }
      expect(events[0]).not.toHaveProperty('publicArtifact');
    }
  });

  it('counts consecutive prohibited attempts toward the §9.4 pause', async () => {
    const { adapter, gateway, config } = await harness('prose-only');
    expect(config.maxConsecutiveRejections).toBe(3);
    const results = [];
    for (const turn of [1, 2, 3]) {
      await adapter.observe(observation(SENDER_PAYLOAD, config.runId, turn));
      results.push(
        await gateway.submitProposal(
          turnContext(turn),
          await adapter.act(senderBudget(turn)),
        ),
      );
    }
    const last = results[2];
    expect(last?.kind).toBe('rejected');
    if (last?.kind === 'rejected') {
      expect(last.consecutiveRejections).toBe(3);
      expect(last.pauseRequested).toBe(true);
    }
  });
});

describe('ALD-044 receiver-side violations (SPEC §11.3 task action)', () => {
  /**
   * A receiver's `select_object` is a task action: the Nursery Controller
   * parses it against `TurnProposalEnvelopeSchema` and forfeits the turn with
   * `invalid-task-action` when it does not match (see
   * `packages/orchestrator/src/nursery-runtime.ts`). The orchestrator is not
   * imported here; what is asserted is the property it keys on.
   */
  const RECEIVER_ROWS: readonly [ScriptedBehavior, boolean][] = [
    ['valid-tool-call', true],
    ['tool-call-with-free-text', false],
    ['prose-only', false],
    ['malformed-json', false],
    ['off-inventory-symbol', true],
    ['wrong-carrier-kind', false],
  ];

  it.each(RECEIVER_ROWS)(
    'a %s completion parses as a task action: %s',
    async (behavior, parses) => {
      const { adapter, config } = await harness(behavior);
      await adapter.observe(observation(RECEIVER_PAYLOAD, config.runId));
      const envelope = await adapter.act({
        turn: 1,
        role: 'receiver',
        responseBudgetMs: 5_000,
        availableActions: ['select_object'],
        candidateRefs: CANDIDATE_REFS,
      });
      const parsed = TurnProposalEnvelopeSchema.safeParse(envelope);
      expect(parsed.success && parsed.data.proposal.kind === 'select_object').toBe(
        parses,
      );
    },
  );

  it('records an off-candidate selection as a count, never as ledger text', async () => {
    const { adapter, config } = await harness('off-inventory-symbol');
    await adapter.observe(observation(RECEIVER_PAYLOAD, config.runId));
    const envelope = await adapter.act({
      turn: 1,
      role: 'receiver',
      responseBudgetMs: 5_000,
      availableActions: ['select_object'],
      candidateRefs: CANDIDATE_REFS,
    });
    const content = envelope.privateLedgerDraft.content;
    expect(content.selection).toBeUndefined();
    expect(content.offInventoryCount).toBe(1);
    expect(JSON.stringify(content)).not.toContain('ZZ9');
  });
});
