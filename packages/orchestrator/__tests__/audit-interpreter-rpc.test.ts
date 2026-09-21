import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type {
  AuditInterpretationBatchRequest,
  AuditLedgerEntry,
} from '@ald/types';

import {
  connectAuditInterpreterRpc,
  createAuditInterpreterRpcServer,
  type AuditInterpreterService,
} from '../src/index.js';

describe('Audit Interpreter RPC', () => {
  it('binds validated delayed batches to one run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ald-audit-interpreter-'));
    const socketPath = join(directory, 'audit-interpreter.sock');
    const runId = 'audit-interpreter-run';
    const calls: Array<{ request: AuditInterpretationBatchRequest; nextTurn: number }> = [];
    const fixture: AuditInterpreterService = {
      appendBatch: async (request, nextTurn) => {
        calls.push({ request, nextTurn });
        return [entry(runId, request)];
      },
    };
    const server = await createAuditInterpreterRpcServer(
      socketPath,
      runId,
      fixture,
    );
    try {
      const connected = await connectAuditInterpreterRpc(socketPath, runId);
      const request = batch(runId);
      expect(connected.processId).toBe(process.pid);
      await expect(connected.interpreter.appendBatch(request, 2))
        .resolves.toEqual([entry(runId, request)]);
      await expect(connected.interpreter.appendBatch(batch('wrong-run'), 2))
        .rejects.toThrow('run ID mismatch');
      expect(calls).toEqual([{ request, nextTurn: 2 }]);
      await expect(connectAuditInterpreterRpc(socketPath, 'wrong-run'))
        .rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const sha = `sha256:${'00'.repeat(32)}`;
const signature = `ed25519:${Buffer.alloc(64).toString('base64')}`;

function batch(runId: string): AuditInterpretationBatchRequest {
  return {
    runId,
    interpreterVersion: 'audit-interpreter-test-v1',
    entries: [{
      babyId: 'A',
      sourceEntryHash: sha,
      content: {
        term: 'test-term',
        hypothesis: 'test hypothesis',
        evidence: 'test evidence',
      },
    }],
  };
}

function entry(
  runId: string,
  request: AuditInterpretationBatchRequest,
): AuditLedgerEntry {
  const source = request.entries[0]!;
  return {
    version: 1,
    runId,
    sequence: 1,
    babyId: source.babyId,
    source: 'generated-analysis',
    sourceEntryHash: source.sourceEntryHash,
    interpreterVersion: request.interpreterVersion,
    content: source.content,
    previousEntryHash: sha,
    recordedAt: '2026-09-21T00:00:00.000Z',
    writerKeyId: 'audit-writer:test',
    entryHash: sha,
    writerSignature: signature,
  };
}
