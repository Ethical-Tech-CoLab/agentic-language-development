import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EvidenceWriteUncertainError,
  GatewayWriteIntentJournal,
  SymbolGatewayImpl,
  type GatewayEvidencePort,
} from '../src/index.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';
import { runContext, symbolEnvelope, turn } from './support.js';

describe('durable Gateway write-intent journal', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ald-gateway-write-journal-'));
    roots.push(root);
    const context = runContext();
    const writer = FakeEvidenceWriter.forRun(context.runId, new StepClock());
    writer.registerRun(context.config);
    const directory = join(root, 'journal');
    const delegate: GatewayEvidencePort = {
      commitTurn: (request) => writer.commitTurn(request),
      commitRejection: (request) => writer.commitRejection(request),
      commitControlArtifact: (request) => writer.commitControlArtifact(request),
      appendLedgerEvent: (request) => writer.appendLedgerEvent(request),
      appendInterventionEvent: (request) => writer.appendInterventionEvent(request),
      appendAffectEvent: (request) => writer.appendAffectEvent(request),
    };
    return { context, writer, directory, delegate };
  }

  it('records hashes rather than drafts and permits a confirmed next request after restart', async () => {
    const { context, writer, directory, delegate } = await fixture();
    const journal = new GatewayWriteIntentJournal(directory, context.runId);
    const gateway = new SymbolGatewayImpl(context, await journal.openPort(delegate));
    const result = await gateway.submitProposal(turn(), symbolEnvelope(['S01']));
    expect(result.kind).toBe('accepted');
    expect(await journal.unresolvedIntents()).toEqual([]);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    const intent = await readFile(join(directory, files.find((file) => file.endsWith('.intent.json'))!), 'utf8');
    expect(intent).toContain('requestHash');
    expect(intent).not.toContain('intention.recorded');

    const restarted = new GatewayWriteIntentJournal(directory, context.runId);
    const nextGateway = new SymbolGatewayImpl(context, await restarted.openPort(delegate));
    const next = await nextGateway.submitProposal(turn({ turn: 1 }), symbolEnvelope(['S02']));
    expect(next.kind).toBe('accepted');
    expect(writer.channelEvents(context.runId)).toHaveLength(2);
  });

  it('refuses recovery after a request with no committed event or reply', async () => {
    const { context, writer, directory, delegate } = await fixture();
    const journal = new GatewayWriteIntentJournal(directory, context.runId);
    const port = await journal.openPort({
      ...delegate,
      commitTurn: async () => { throw new Error('reply lost before commit'); },
    });
    const gateway = new SymbolGatewayImpl(context, port);
    await expect(gateway.submitProposal(turn(), symbolEnvelope(['S01'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    expect(writer.channelEvents(context.runId)).toHaveLength(0);
    expect(await journal.unresolvedIntents()).toHaveLength(1);

    const restarted = new GatewayWriteIntentJournal(directory, context.runId);
    const recovered = new SymbolGatewayImpl(context, await restarted.openPort(delegate));
    expect(restarted.isQuarantined()).toBe(true);
    await expect(recovered.submitProposal(turn(), symbolEnvelope(['S01'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    expect(writer.channelEvents(context.runId)).toHaveLength(0);
  });

  it('refuses later requests even when the timed-out write commits late', async () => {
    const { context, writer, directory, delegate } = await fixture();
    let finishLate!: () => void;
    const lateCommit = new Promise<void>((resolve) => { finishLate = resolve; });
    const journal = new GatewayWriteIntentJournal(directory, context.runId);
    const port = await journal.openPort({
      ...delegate,
      commitTurn: async (request) => {
        queueMicrotask(() => {
          void writer.commitTurn(request).then(() => finishLate());
        });
        throw new Error('timeout before late commit');
      },
    });
    const gateway = new SymbolGatewayImpl(context, port);
    await expect(gateway.submitProposal(turn(), symbolEnvelope(['S01'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    await lateCommit;
    expect(writer.channelEvents(context.runId)).toHaveLength(1);
    await expect(gateway.submitProposal(turn({ turn: 1 }), symbolEnvelope(['S02'])))
      .rejects.toBeInstanceOf(EvidenceWriteUncertainError);
    expect(writer.channelEvents(context.runId)).toHaveLength(1);
    expect(await journal.unresolvedIntents()).toHaveLength(1);
  });
});
