import { describe, expect, it } from 'vitest';

import {
  EvidenceWriteUncertainError,
  SymbolGatewayImpl,
  type GatewayEvidencePort,
} from '../src/index.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';
import { runContext, symbolEnvelope, turn } from './support.js';

describe('Gateway evidence authority', () => {
  it('accepts and rejects through only its six permitted asynchronous writes', async () => {
    const context = runContext();
    const writer = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    writer.registerRun(context.config);
    const calls: string[] = [];
    const port: GatewayEvidencePort = {
      commitTurn: (request) => { calls.push('commitTurn'); return writer.commitTurn(request); },
      commitRejection: (request) => {
        calls.push('commitRejection'); return writer.commitRejection(request);
      },
      commitControlArtifact: (request) => writer.commitControlArtifact(request),
      appendLedgerEvent: (request) => writer.appendLedgerEvent(request),
      appendInterventionEvent: (request) => writer.appendInterventionEvent(request),
      appendAffectEvent: (request) => writer.appendAffectEvent(request),
    };
    expect(Object.keys(port).sort()).toEqual([
      'appendAffectEvent', 'appendInterventionEvent', 'appendLedgerEvent',
      'commitControlArtifact', 'commitRejection', 'commitTurn',
    ]);
    expect('registerRun' in port).toBe(false);
    expect('readCheckpoints' in port).toBe(false);
    expect('insertAnchorReceipt' in port).toBe(false);

    const gateway = new SymbolGatewayImpl(context, port);
    const accepted = await gateway.submitProposal(turn(), symbolEnvelope(['S01']));
    expect(accepted.kind).toBe('accepted');
    const rejected = await gateway.submitProposal(turn({ turn: 2 }),
      symbolEnvelope(['not-allowed']));
    expect(rejected.kind).toBe('rejected');
    expect(calls).toEqual(['commitTurn', 'commitRejection']);
  });

  it('quarantines a lost reply after a committed turn and never retries it', async () => {
    const context = runContext();
    const writer = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    writer.registerRun(context.config);
    let commitCalls = 0;
    const port: GatewayEvidencePort = {
      commitTurn: async (request) => {
        commitCalls += 1;
        await writer.commitTurn(request);
        throw new EvidenceWriteUncertainError();
      },
      commitRejection: (request) => writer.commitRejection(request),
      commitControlArtifact: (request) => writer.commitControlArtifact(request),
      appendLedgerEvent: (request) => writer.appendLedgerEvent(request),
      appendInterventionEvent: (request) => writer.appendInterventionEvent(request),
      appendAffectEvent: (request) => writer.appendAffectEvent(request),
    };
    const gateway = new SymbolGatewayImpl(context, port);
    await expect(gateway.submitProposal(turn(), symbolEnvelope(['S01'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    expect(gateway.isEvidenceWriteQuarantined()).toBe(true);
    expect(writer.channelEvents(context.runId)).toHaveLength(1);
    await expect(gateway.submitProposal(turn({ turn: 2 }), symbolEnvelope(['S02'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    expect(commitCalls).toBe(1);
    expect(writer.channelEvents(context.runId)).toHaveLength(1);
  });
});
