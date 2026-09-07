/**
 * SPEC §12.3 response mapping, §8.3 turn deadlines, §8.2 Evidence Writer
 * boundary, and the fidelity of the in-memory writer the suite runs on.
 */
import { describe, expect, it } from 'vitest';

import {
  ChannelEventSchema,
  LedgerEventSchema,
  RunConfigSchema,
  type TurnCommitRequest,
} from '@ald/types';
import { computeEntryHash, verifyHashSignature } from '@ald/hashing';

import {
  ControlArtifactNotPermittedError,
  InvalidControlArtifactError,
  InvalidSymbolInventoryError,
  isGatewayError,
  OracleRequiresControlArtifactError,
  ShuffledBatchRequiredError,
  toGatewayError,
  toGatewayRejectionResponse,
  TurnDeadlineExceededError,
  UnsupportedCarrierError,
} from '../src/errors.js';
import { SymbolGatewayImpl, withTurnDeadline } from '../src/symbol-gateway.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';
import { harness, runContext, symbolEnvelope, turn } from './support.js';

describe('SPEC §12.3 response shape', () => {
  it('maps every Gateway error class to its code and status', () => {
    const cases: Array<[Error, number, string]> = [
      [new UnsupportedCarrierError('generative-tone'), 400, 'INVALID_REQUEST'],
      [new ShuffledBatchRequiredError(3), 400, 'INVALID_REQUEST'],
      [
        new InvalidControlArtifactError('free-text-present', 'oracle', 'detail'),
        400,
        'INVALID_REQUEST',
      ],
      [new InvalidSymbolInventoryError('too small'), 400, 'INVALID_REQUEST'],
      [new OracleRequiresControlArtifactError(), 403, 'FORBIDDEN'],
      [new ControlArtifactNotPermittedError('normal'), 403, 'FORBIDDEN'],
      [new TurnDeadlineExceededError(30_000), 422, 'CHANNEL_REJECTED'],
    ];

    for (const [error, status, code] of cases) {
      expect(isGatewayError(error)).toBe(true);
      const response = toGatewayError(error);
      expect(response.status).toBe(status);
      expect(response.error.code).toBe(code);
      expect(response.error.message.length).toBeGreaterThan(0);
    }
  });

  it('maps a schema failure to INVALID_REQUEST without echoing the payload', () => {
    let caught: unknown;
    try {
      RunConfigSchema.parse({ version: 1, runId: 'secret-run-name' });
    } catch (error) {
      caught = error;
    }
    const response = toGatewayError(caught);
    expect(response.status).toBe(400);
    expect(response.error.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(response)).not.toContain('secret-run-name');
  });

  it('maps an Evidence Writer error code to a conflict', async () => {
    const context = runContext();
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    // The run was never registered, so the writer refuses the commit.
    const gateway = new SymbolGatewayImpl(context, evidence);
    let caught: unknown;
    try {
      await gateway.submitProposal(turn(), symbolEnvelope(['S01']));
    } catch (error) {
      caught = error;
    }
    const response = toGatewayError(caught);
    expect(response.status).toBe(409);
    expect(response.error.code).toBe('CONFLICT');
    expect(response.error.details).toMatchObject({ evidenceCode: 'unknown-run' });
  });

  it('maps an unmapped failure to a conflict rather than a request error', () => {
    const response = toGatewayError(new Error('disk on fire'));
    expect(response.status).toBe(409);
    expect(response.error.details).toMatchObject({ unmapped: true });
    expect(response.error.message).not.toContain('disk on fire');
  });

  it('renders a committed rejection as CHANNEL_REJECTED with no content', async () => {
    const { gateway } = harness();
    const result = await gateway.submitProposal(
      turn(),
      symbolEnvelope(['not a symbol']),
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') {
      return;
    }
    const response = toGatewayRejectionResponse(result);
    expect(response.status).toBe(422);
    expect(response.error.code).toBe('CHANNEL_REJECTED');
    expect(response.error.details).toMatchObject({
      reasonCode: 'free-text-present',
      pauseRequested: false,
    });
    expect(JSON.stringify(response)).not.toContain('not a symbol');
  });
});

describe('SPEC §8.3 turn deadlines', () => {
  it('resolves a promise that beats the budget', async () => {
    await expect(withTurnDeadline(Promise.resolve('ok'), 1_000)).resolves.toBe(
      'ok',
    );
  });

  it('rejects when the budget elapses first', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTurnDeadline(never, 5)).rejects.toBeInstanceOf(
      TurnDeadlineExceededError,
    );
  });

  it('propagates the wrapped failure unchanged', async () => {
    const failure = new Error('adapter failed');
    await expect(withTurnDeadline(Promise.reject(failure), 1_000)).rejects.toBe(
      failure,
    );
  });

  it('rejects a non-positive budget immediately', async () => {
    await expect(
      withTurnDeadline(Promise.resolve('ok'), 0),
    ).rejects.toBeInstanceOf(TurnDeadlineExceededError);
  });

  it('defaults to the run turnResponseBudgetMs and commits the forfeited turn', async () => {
    const { gateway, evidence, context } = harness({
      turnResponseBudgetMs: 1_000,
    });
    await expect(
      gateway.withTurnDeadline(new Promise<string>(() => undefined), 5),
    ).rejects.toBeInstanceOf(TurnDeadlineExceededError);

    const rejection = await gateway.rejectForTimeout(turn({ turn: 4 }), 'baby-a');
    expect(rejection.reasonCode).toBe('timeout');
    const events = evidence.channelEvents(context.runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.reasonCode).toBe('timeout');
  });
});

describe('Evidence Writer boundary (SPEC §4.2, §8.2)', () => {
  it('submits one normalized TurnCommitRequest per accepted proposal', async () => {
    const { gateway, evidence, context } = harness();
    const seen: TurnCommitRequest[] = [];
    const original = evidence.commitTurn.bind(evidence);
    evidence.commitTurn = (request: TurnCommitRequest) => {
      seen.push(request);
      return original(request);
    };

    await gateway.submitProposal(
      turn({ turn: 6 }),
      symbolEnvelope(['S03', 'S03']),
    );

    expect(seen).toHaveLength(1);
    const request = seen[0] as TurnCommitRequest;
    expect(request.runId).toBe(context.runId);
    expect(request.turn).toBe(6);
    expect(request.sender).toBe('baby-a');
    expect(request.recipient).toBe('baby-b');
    expect(request.carrier).toBe('fixed-token');
    expect(request.communicationCondition).toBe('normal');
    expect(Object.keys(request.proposal).sort()).toEqual([
      'kind',
      'publicArtifact',
    ]);
    expect(request.proposal.publicArtifact).toEqual({ symbols: ['S03', 'S03'] });
    expect(request.intentionDraft.eventType).toBe('intention.recorded');
    expect(request.deliveredArtifact).toEqual({ symbols: ['S03', 'S03'] });
  });

  it('produces schema-valid, chained, verifiable events', async () => {
    const { gateway, evidence, context } = harness();
    for (const turnNumber of [1, 2, 3]) {
      await gateway.submitProposal(
        turn({ turn: turnNumber }),
        symbolEnvelope(['S01']),
      );
    }

    const channel = evidence.channelEvents(context.runId);
    const ledger = evidence.ledgerEvents(context.runId, 'A');
    expect(channel).toHaveLength(3);
    expect(ledger).toHaveLength(3);

    const keys = evidence.signerRegistry.publicKeys();
    const channelKey = keys.find((key) => key.domain === 'channel')?.publicKey ?? '';
    const ledgerKey =
      keys.find((key) => key.domain === 'baby-a-ledger')?.publicKey ?? '';

    channel.forEach((event, index) => {
      const parsed = ChannelEventSchema.parse(event);
      expect(parsed.sequence).toBe(index + 1);
      expect(parsed.entryHash).toBe(computeEntryHash('channel', parsed));
      expect(
        verifyHashSignature(parsed.entryHash, parsed.writerSignature, channelKey),
      ).toBe(true);
    });
    ledger.forEach((event, index) => {
      const parsed = LedgerEventSchema.parse(event);
      expect(parsed.sequence).toBe(index + 1);
      expect(parsed.entryHash).toBe(computeEntryHash('baby-a-ledger', parsed));
      expect(
        verifyHashSignature(parsed.entryHash, parsed.writerSignature, ledgerKey),
      ).toBe(true);
    });

    const recovery = await evidence.recover(context.runId);
    expect(recovery.ok).toBe(true);
    expect(recovery.chainViolations).toEqual([]);
    expect(recovery.forks).toEqual([]);
    expect(evidence.chainHead(context.runId, 'channel').size).toBe(3);
  });

  it('registers a run once and reports its configuration hash', () => {
    const context = runContext();
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    const { configurationHash } = evidence.registerRun(context.config);
    expect(configurationHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.listRuns()).toEqual([context.runId]);
    expect(() => evidence.registerRun(context.config)).toThrow(
      /already registered/u,
    );
  });

  it('refuses an interpretation ledger append with no delivery binding', () => {
    const { evidence, context } = harness();
    expect(() =>
      evidence.appendLedgerEvent({
        runId: context.runId,
        babyId: 'B',
        turn: 1,
        draft: {
          eventType: 'interpretation.recorded',
          contentSchema: 'agent-native-ledger',
          subjectId: 'subject',
          content: { artifactRef: 'a' },
          blindingNonce: 'nonce',
          evidenceRefs: [],
        },
      }),
    ).toThrow(/channelEventHash/u);
  });
});

describe('symbol inventory validation (SPEC §9.1)', () => {
  it('refuses an inventory the protocol cannot use', () => {
    const context = runContext();
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    evidence.registerRun(context.config);

    for (const inventory of [['S01'], ['S01', 'S01'], ['S01', 'S 02'], ['S01', '']]) {
      expect(
        () =>
          new SymbolGatewayImpl(
            { ...context, symbolInventory: inventory },
            evidence,
          ),
      ).toThrow(InvalidSymbolInventoryError);
    }
  });

  it('refuses a non-positive maxSymbolRepeats', () => {
    const context = runContext();
    const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    evidence.registerRun(context.config);
    expect(
      () => new SymbolGatewayImpl(context, evidence, { maxSymbolRepeats: 0 }),
    ).toThrow(InvalidSymbolInventoryError);
  });

  it('accepts a run-configured inventory of any size without a code change', async () => {
    const { gateway } = harness({ symbolInventorySize: 4, maxSymbolsPerMessage: 2 });
    const accepted = await gateway.submitProposal(turn(), symbolEnvelope(['S04']));
    expect(accepted.kind).toBe('accepted');
    const rejected = await gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(['S05']),
    );
    expect(rejected.kind === 'rejected' && rejected.reasonCode).toBe(
      'symbol-not-in-inventory',
    );
    const tooLong = await gateway.submitProposal(
      turn({ turn: 3 }),
      symbolEnvelope(['S01', 'S02', 'S03']),
    );
    expect(tooLong.kind === 'rejected' && tooLong.reasonCode).toBe(
      'message-too-long',
    );
  });
});
