import type { Server } from 'node:net';

import {
  AuditLedgerEntrySchema,
  LedgerEventSchema,
  type AuditLedgerAppendRequest,
  type AuditLedgerEntry,
  type EvidenceWriter,
  type StoredEvent,
} from '@ald/types';

import { connectEvidenceRpc, createEvidenceRpcServer, record } from './rpc-wire.js';

const METHODS = ['readEvents', 'appendAuditLedgerEntry'] as const;
const PROTOCOL = 'audit-evidence-v1';
type LedgerStream = 'baby-a-ledger' | 'baby-b-ledger';

export interface AuditEvidencePort {
  readEvents(runId: string, stream: LedgerStream): Promise<StoredEvent[]>;
  appendAuditLedgerEntry(request: AuditLedgerAppendRequest): Promise<AuditLedgerEntry>;
}

function ledgerStream(value: unknown): value is LedgerStream {
  return value === 'baby-a-ledger' || value === 'baby-b-ledger';
}

/** Only the delayed interpreter's two writer calls, on its own private mount. */
export function createAuditEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: EvidenceWriter,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath, runId, PROTOCOL, METHODS,
    (method, args) => method === 'readEvents'
      ? args.length === 2 && args[0] === runId && ledgerStream(args[1])
      : args.length === 1 && record(args[0]) && args[0]['runId'] === runId,
    (method, args) => method === 'readEvents'
      ? writer.readEvents(runId, args[1] as LedgerStream)
      : writer.appendAuditLedgerEntry(args[0] as AuditLedgerAppendRequest),
  );
}

/** The client never retries a possibly committed audit append. */
export async function connectAuditEvidenceRpc(
  socketPath: string,
  runId: string,
): Promise<{ port: AuditEvidencePort; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  return {
    processId: connection.processId,
    port: {
      readEvents: async (requestedRunId, stream) => {
        if (requestedRunId !== runId || !ledgerStream(stream)) {
          throw new Error('audit evidence read scope does not match');
        }
        const result = await connection.call('readEvents', [runId, stream]);
        if (!Array.isArray(result)) throw new Error('audit evidence read is malformed');
        return result.map((row: unknown) => {
          if (!record(row) || row['stream'] !== stream ||
              typeof row['canonicalJson'] !== 'string') {
            throw new Error('audit evidence event is malformed');
          }
          const event = LedgerEventSchema.parse(JSON.parse(row['canonicalJson']));
          if (event.runId !== runId || event.entryHash !== row['entryHash'] ||
              event.sequence !== row['sequence'] ||
              event.babyId !== (stream === 'baby-a-ledger' ? 'A' : 'B')) {
            throw new Error('audit evidence event identity does not match');
          }
          return row as unknown as StoredEvent;
        });
      },
      appendAuditLedgerEntry: async (request) => {
        if (request.runId !== runId) throw new Error('audit evidence write run ID does not match');
        const result = AuditLedgerEntrySchema.parse(
          await connection.call('appendAuditLedgerEntry', [request]));
        if (result.runId !== runId || result.babyId !== request.babyId ||
            result.sourceEntryHash !== request.sourceEntryHash ||
            result.interpreterVersion !== request.interpreterVersion) {
          throw new Error('audit evidence append identity does not match');
        }
        return result;
      },
    },
  };
}
