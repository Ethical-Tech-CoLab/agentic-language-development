import { describe, expect, it } from 'vitest';

import { SymbolGatewayImpl, type GatewayEvidencePort } from '../src/index.js';
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
});
