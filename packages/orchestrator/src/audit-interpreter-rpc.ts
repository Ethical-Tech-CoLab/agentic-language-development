import type { Server } from 'node:net';

import {
  connectEvidenceRpc,
  createEvidenceRpcServer,
  isRpcRecord,
} from '@ald/evidence';
import {
  AuditLedgerEntrySchema,
  UnsignedAuditLedgerEntrySchema,
  type AuditInterpretationBatchRequest,
} from '@ald/types';

import type { AuditInterpreterService } from './audit-interpreter.js';

const PROTOCOL = 'audit-interpreter-v1';
const METHODS = ['appendBatch'] as const;
const HASH = /^sha256:[0-9a-f]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validRequest(value: unknown, runId: string): value is AuditInterpretationBatchRequest {
  if (!isRpcRecord(value) || !exactKeys(value, ['runId', 'interpreterVersion', 'entries']) ||
      value['runId'] !== runId || typeof value['interpreterVersion'] !== 'string' ||
      !Array.isArray(value['entries'])) return false;
  return value['entries'].every((entry) => isRpcRecord(entry) &&
    exactKeys(entry, ['babyId', 'sourceEntryHash', 'content']) &&
    (entry['babyId'] === 'A' || entry['babyId'] === 'B') &&
    typeof entry['sourceEntryHash'] === 'string' && HASH.test(entry['sourceEntryHash']) &&
    UnsignedAuditLedgerEntrySchema.shape.content.safeParse(entry['content']).success);
}

/** Separate delayed interpreter endpoint with no Gateway or Baby methods. */
export function createAuditInterpreterRpcServer(
  socketPath: string,
  runId: string,
  interpreter: AuditInterpreterService,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath,
    runId,
    PROTOCOL,
    METHODS,
    (method, args) => method === 'appendBatch' && args.length === 2 &&
      validRequest(args[0], runId) && Number.isSafeInteger(args[1]) && Number(args[1]) >= 0,
    (method, args) => interpreter.appendBatch(
      args[0] as AuditInterpretationBatchRequest,
      Number(args[1]),
    ),
  );
}

/** Controller client for one run's delayed Audit Interpreter. */
export async function connectAuditInterpreterRpc(
  socketPath: string,
  runId: string,
): Promise<{ interpreter: AuditInterpreterService; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  return {
    processId: connection.processId,
    interpreter: {
      appendBatch: async (request, nextTurn) => {
        if (request.runId !== runId) throw new Error('audit interpreter run ID mismatch');
        const result = await connection.call('appendBatch', [request, nextTurn]);
        if (!Array.isArray(result)) throw new Error('audit interpreter result is malformed');
        return result.map((entry) => AuditLedgerEntrySchema.parse(entry));
      },
    },
  };
}
