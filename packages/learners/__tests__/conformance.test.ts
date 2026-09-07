import type {
  DeliveredChannelArtifact,
  LearnerAdapter,
  LearnerAdapterFactory,
  LearnerInitContext,
  LedgerDraftEnvelope,
  Observation,
  OutcomeEvent,
  PrivateLedgerClient,
  TurnBudget,
  TurnProposalEnvelope,
} from '@ald/types';
import { LedgerEventSchema } from '@ald/types';
import { describe, expect, it } from 'vitest';

import {
  RecordingLedgerClient,
  assertToolOnlyProposal,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
  tailSuccessRate,
} from '../src/conformance.js';
import { LearnerConformanceError } from '../src/errors.js';
import { createNoLearningAdapterFactory } from '../src/no-learning.js';

type Defect =
  | 'none'
  | 'free-text'
  | 'trusted-field'
  | 'nested-trusted-field'
  | 'wrong-draft-type'
  | 'human-audit-content'
  | 'rewritten-channel-hash'
  | 'wrong-interpretation-type'
  | 'off-menu-selection'
  | 'unexpected-update-policy';

/** A deliberately non-conforming adapter, one defect at a time. */
class DefectiveAdapter implements LearnerAdapter {
  readonly track = 'no-learning' as const;
  private ledger: PrivateLedgerClient | undefined;
  private candidateRefs: string[] = [];

  constructor(private readonly defect: Defect) {
    if (defect === 'unexpected-update-policy') {
      Object.defineProperty(this, 'updatePolicy', {
        value: async () =>
          Promise.resolve({
            policyCheckpointRef: 'policy:none',
            policyHash: `sha256:${'0'.repeat(64)}`,
            turn: 0,
          }),
      });
    }
  }

  async init(context: LearnerInitContext): Promise<void> {
    this.ledger = context.ledger;
    return Promise.resolve();
  }

  async observe(_observation: Observation): Promise<void> {
    return Promise.resolve();
  }

  async act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope> {
    this.candidateRefs = turnBudget.candidateRefs ?? [];
    const proposal =
      turnBudget.role === 'sender'
        ? { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } }
        : {
            kind: 'select_object',
            publicArtifact: {
              objectRef:
                this.defect === 'off-menu-selection'
                  ? 'object:not-offered'
                  : (this.candidateRefs[0] as string),
            },
          };
    const draft = {
      eventType:
        this.defect === 'wrong-draft-type' ? 'term.first_emitted' : 'intention.recorded',
      contentSchema:
        this.defect === 'human-audit-content'
          ? 'human-audit-ledger'
          : 'agent-native-ledger',
      subjectId: 'symbol:S01',
      content: { artifactRef: 'proposal:x', termRef: 'symbol:S01' },
      blindingNonce: '0123456789abcdef01234567',
      evidenceRefs: [],
    };

    if (this.defect === 'trusted-field') {
      return Promise.resolve({
        proposal: { ...proposal, turn: turnBudget.turn },
        privateLedgerDraft: draft,
      } as unknown as TurnProposalEnvelope);
    }
    if (this.defect === 'nested-trusted-field') {
      return Promise.resolve({
        proposal: {
          ...proposal,
          publicArtifact: { ...proposal.publicArtifact, timestamp: 'now' },
        },
        privateLedgerDraft: draft,
      } as unknown as TurnProposalEnvelope);
    }
    if (this.defect === 'free-text') {
      return Promise.resolve({
        proposal,
        privateLedgerDraft: draft,
        message: 'the first mark is for the target',
      } as unknown as TurnProposalEnvelope);
    }
    return Promise.resolve({
      proposal,
      privateLedgerDraft: draft,
    } as unknown as TurnProposalEnvelope);
  }

  async receive(
    delivery: DeliveredChannelArtifact,
  ): Promise<LedgerDraftEnvelope> {
    return Promise.resolve({
      channelEventHash:
        this.defect === 'rewritten-channel-hash'
          ? `sha256:${'a'.repeat(64)}`
          : delivery.channelEventHash,
      privateLedgerDraft: {
        eventType:
          this.defect === 'wrong-interpretation-type'
            ? 'intention.recorded'
            : 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { artifactRef: delivery.channelEventHash },
        blindingNonce: '0123456789abcdef01234567',
        evidenceRefs: [],
      },
    } as unknown as LedgerDraftEnvelope);
  }

  async onOutcome(_outcome: OutcomeEvent): Promise<void> {
    void this.ledger;
    return Promise.resolve();
  }

  exportPolicy(): unknown {
    return { kind: 'defective' };
  }
}

function defectiveFactory(defect: Defect): LearnerAdapterFactory {
  return { track: 'no-learning', create: () => new DefectiveAdapter(defect) };
}

describe('assertToolOnlyProposal (SPEC §6.3, §11.3)', () => {
  const valid = {
    proposal: { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
    privateLedgerDraft: {
      eventType: 'intention.recorded',
      contentSchema: 'agent-native-ledger',
      subjectId: 'symbol:S01',
      content: { artifactRef: 'proposal:x' },
      blindingNonce: '0123456789abcdef01234567',
      evidenceRefs: [],
    },
  };

  it('accepts a bare tool call with its intention draft', () => {
    expect(() => assertToolOnlyProposal(valid, 'unit')).not.toThrow();
  });

  it('rejects free text alongside a valid tool call', () => {
    expect(() =>
      assertToolOnlyProposal({ ...valid, message: 'hello' }, 'unit'),
    ).toThrow(LearnerConformanceError);
  });

  it('rejects a missing intention draft', () => {
    expect(() =>
      assertToolOnlyProposal({ proposal: valid.proposal }, 'unit'),
    ).toThrow(/missing privateLedgerDraft/u);
  });

  it('rejects every runtime-assigned trusted field, at any depth', () => {
    for (const key of ['runId', 'turn', 'sender', 'hash', 'timestamp']) {
      expect(() =>
        assertToolOnlyProposal(
          {
            ...valid,
            proposal: {
              ...valid.proposal,
              publicArtifact: { symbols: ['S01'], [key]: 'x' },
            },
          },
          'unit',
        ),
        key,
      ).toThrow(/trusted field/u);
      expect(() =>
        assertToolOnlyProposal(
          {
            ...valid,
            proposal: {
              ...valid.proposal,
              publicArtifact: { nested: [{ [key]: 'x' }] },
            },
          },
          'unit',
        ),
        `nested ${key}`,
      ).toThrow(/trusted field/u);
    }
  });

  it('rejects a trusted field regardless of letter case', () => {
    expect(() =>
      assertToolOnlyProposal(
        {
          ...valid,
          proposal: {
            ...valid.proposal,
            publicArtifact: { symbols: ['S01'], RunId: 'x' },
          },
        },
        'unit',
      ),
    ).toThrow(/trusted field/u);
  });

  it('rejects extra keys on the proposal itself', () => {
    expect(() =>
      assertToolOnlyProposal(
        { ...valid, proposal: { ...valid.proposal, note: 'x' } },
        'unit',
      ),
    ).toThrow(/exactly kind and publicArtifact/u);
  });

  it('rejects a non-object envelope', () => {
    expect(() => assertToolOnlyProposal('emit S01', 'unit')).toThrow(
      LearnerConformanceError,
    );
  });

  it('rejects a publicArtifact key that is not part of the kind\'s schema, even when it names no trusted field', () => {
    // Regression: assertToolOnlyProposal used to constrain only the
    // envelope's and the proposal's own key sets, never publicArtifact's, so
    // a non-trusted free-text field riding alongside the tool call (e.g. a
    // side channel between Babies) passed unnoticed (SPEC §6.3, §11.3).
    expect(() =>
      assertToolOnlyProposal(
        {
          ...valid,
          proposal: {
            ...valid.proposal,
            publicArtifact: { symbols: ['S01'], sideChannel: 'candidate 2' },
          },
        },
        'unit',
      ),
    ).toThrow(/publicArtifact for kind "emit_symbols" must hold exactly symbols/u);
  });

  it('rejects a trusted field hidden as a non-enumerable own property', () => {
    // Regression: assertNoTrustedFields used to walk with Object.entries,
    // which only sees own *enumerable* properties, so a trusted field
    // defined non-enumerably was invisible to it even though Object.keys
    // still matched the schema's field set.
    const publicArtifact: Record<string, unknown> = { symbols: ['S01'] };
    Object.defineProperty(publicArtifact, 'runId', {
      value: 'leaked-run',
      enumerable: false,
    });
    expect(Object.keys(publicArtifact)).toEqual(['symbols']);
    expect(() =>
      assertToolOnlyProposal(
        { ...valid, proposal: { ...valid.proposal, publicArtifact } },
        'unit',
      ),
    ).toThrow(/trusted field/u);
  });

  it('rejects a trusted field planted on the publicArtifact prototype', () => {
    // Regression: assertNoTrustedFields never walked the prototype chain,
    // so a trusted field inherited rather than owned was invisible to it —
    // and also invisible to Object.keys, so it would not even trip the
    // artifact key-set check.
    const publicArtifact = Object.assign(
      Object.create({ runId: 'leaked-run', timestamp: 'leaked-ts' }),
      { symbols: ['S01'] },
    );
    expect(Object.keys(publicArtifact)).toEqual(['symbols']);
    expect(() =>
      assertToolOnlyProposal(
        { ...valid, proposal: { ...valid.proposal, publicArtifact } },
        'unit',
      ),
    ).toThrow(/trusted field/u);
  });
});

describe('runLearnerAdapterConformance', () => {
  it('rejects each defect it exists to catch', async () => {
    const defects: Defect[] = [
      'free-text',
      'trusted-field',
      'nested-trusted-field',
      'wrong-draft-type',
      'human-audit-content',
      'rewritten-channel-hash',
      'wrong-interpretation-type',
      'off-menu-selection',
      'unexpected-update-policy',
    ];
    for (const defect of defects) {
      await expect(
        runLearnerAdapterConformance(defectiveFactory(defect), {
          episodes: 2,
          seed: `defect-${defect}`,
        }),
        defect,
      ).rejects.toThrow(LearnerConformanceError);
    }
  });

  it('accepts the reference adapter under the same assertions', async () => {
    const result = await runLearnerAdapterConformance(
      createNoLearningAdapterFactory(),
      { episodes: 6, seed: 'harness-happy-path' },
    );
    expect(result.successFlags).toHaveLength(6);
    expect(tailSuccessRate(result, 3)).toBeGreaterThanOrEqual(0);
  });

  it('alternates roles every episode by default (SPEC §8.1 step 9)', async () => {
    const result = await runLearnerAdapterConformance(
      createNoLearningAdapterFactory(),
      { episodes: 8, seed: 'role-reversal' },
    );
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(result.ledgers[role].countOf('interpretation.recorded')).toBe(4);
      expect(result.ledgers[role].countOf('intention.recorded')).toBe(8);
    }
  });

  it('honors roleReversalPeriod', async () => {
    const result = await runLearnerAdapterConformance(
      createNoLearningAdapterFactory(),
      { episodes: 8, seed: 'role-reversal-4', roleReversalPeriod: 4 },
    );
    expect(result.config.roleReversalPeriod).toBe(4);
    expect(result.ledgers['baby-a'].countOf('interpretation.recorded')).toBe(4);
  });

  it('rejects more candidates than there are object types', async () => {
    await expect(
      runLearnerAdapterConformance(createNoLearningAdapterFactory(), {
        episodes: 1,
        candidateCount: 32,
      }),
    ).rejects.toThrow(LearnerConformanceError);
  });

  it('gives each Baby a different derived seed', async () => {
    const result = await runLearnerAdapterConformance(
      createNoLearningAdapterFactory(),
      { episodes: 4, seed: 'per-baby-seed' },
    );
    expect(result.adapters['baby-a'].exportPolicy()).not.toEqual(
      result.adapters['baby-b'].exportPolicy(),
    );
  });
});

describe('buildConformanceRunConfig', () => {
  it('produces a configuration that satisfies the track cross-checks', () => {
    expect(buildConformanceRunConfig('no-learning').learningSignal).toBe('none');
    expect(buildConformanceRunConfig('scratch-rl').learningSignal).toBe(
      'extrinsic-task',
    );
    expect(
      buildConformanceRunConfig('scratch-rl', {
        learningSignal: 'intrinsic-prediction-progress',
      }).learningSignal,
    ).toBe('intrinsic-prediction-progress');
  });

  it('rejects a track/learning-signal combination the spec forbids', () => {
    expect(() =>
      buildConformanceRunConfig('no-learning', { learningSignal: 'extrinsic-task' }),
    ).toThrow();
  });

  it('binds maxSymbolsPerMessage to the harness message length', () => {
    expect(buildConformanceRunConfig('scratch-rl', { messageLength: 2 })
      .maxSymbolsPerMessage).toBe(2);
  });
});

describe('RecordingLedgerClient', () => {
  it('chains, sequences and validates the events it synthesizes', async () => {
    const ledger = new RecordingLedgerClient('run-x', 'baby-b');
    const draft = {
      eventType: 'term.first_emitted',
      contentSchema: 'agent-native-ledger' as const,
      subjectId: 'symbol:S01',
      content: { termRef: 'symbol:S01' },
      blindingNonce: '0123456789abcdef01234567',
      evidenceRefs: [],
    };
    ledger.turn = 3;
    const first = await ledger.append(draft);
    const second = await ledger.append(
      { ...draft, subjectId: 'symbol:S02', content: { termRef: 'symbol:S02' } },
      { channelEventHash: `sha256:${'b'.repeat(64)}` },
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.previousEntryHash).toBe(`sha256:${'0'.repeat(64)}`);
    expect(second.previousEntryHash).toBe(first.entryHash);
    expect(second.channelEventHash).toBe(`sha256:${'b'.repeat(64)}`);
    expect(first.babyId).toBe('B');
    expect(first.turn).toBe(3);
    expect(() => LedgerEventSchema.parse(second)).not.toThrow();
    expect(ledger.countOf('term.first_emitted')).toBe(2);
    expect(ledger.draftsOf('term.first_emitted')).toHaveLength(2);
  });

  it('rejects a draft missing its required content fields', async () => {
    const ledger = new RecordingLedgerClient('run-x', 'baby-a');
    await expect(
      ledger.append({
        eventType: 'hypothesis.revised',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { hypothesisRef: 'hyp:S01:2' },
        blindingNonce: '0123456789abcdef01234567',
        evidenceRefs: [],
      }),
    ).rejects.toThrow(/priorHypothesisRef/u);
  });
});
