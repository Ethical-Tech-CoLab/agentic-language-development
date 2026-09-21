import type { Server } from 'node:net';

import { hashRunId } from '@ald/hashing';

import {
  CheckpointManifestSchema,
  EVENT_STREAMS,
  type CheckpointManifest,
  type EventRange,
  type EventStream,
  type EvidenceWriter,
  type RunMetadataRecord,
  type StoredEvent,
} from '@ald/types';

import { connectEvidenceRpc, createEvidenceRpcServer, record } from './rpc-wire.js';

const METHODS = [
  'readRunMetadata', 'readCheckpoints', 'readEvents', 'insertCheckpointManifest',
] as const;
const PROTOCOL = 'checkpoint-evidence-v1';

export interface CheckpointEvidencePort {
  readRunMetadata(runId: string): Promise<RunMetadataRecord | undefined>;
  readCheckpoints(runId: string): Promise<CheckpointManifest[]>;
  readEvents(runId: string, stream: EventStream, range?: EventRange): Promise<StoredEvent[]>;
  insertCheckpointManifest(manifest: CheckpointManifest): Promise<void>;
}

function validStream(value: unknown): value is EventStream {
  return typeof value === 'string' && EVENT_STREAMS.includes(value as EventStream);
}

function validRange(value: unknown): value is EventRange {
  if (!record(value) || Object.keys(value).some((key) =>
    key !== 'fromSequence' && key !== 'toSequence')) return false;
  return Object.values(value).every((sequence) =>
    Number.isSafeInteger(sequence) && Number(sequence) >= 1);
}

/** A distinct writer socket for the Checkpoint Service's four methods. */
export function createCheckpointEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: EvidenceWriter,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath, runId, PROTOCOL, METHODS,
    (method, args) => method === 'insertCheckpointManifest'
      ? args.length === 1 && record(args[0]) &&
        CheckpointManifestSchema.safeParse(args[0]).success &&
        args[0]['runIdHash'] === hashRunId(runId)
      : method === 'readEvents'
        ? (args.length === 2 || args.length === 3) && args[0] === runId &&
          validStream(args[1]) && (args.length === 2 || validRange(args[2]))
        : args.length === 1 && args[0] === runId,
    (method, args) => {
      if (method === 'insertCheckpointManifest') {
        return writer.insertCheckpointManifest(args[0] as CheckpointManifest);
      }
      if (method === 'readEvents') {
        return writer.readEvents(runId, args[1] as EventStream, args[2] as EventRange | undefined);
      }
      return method === 'readRunMetadata'
        ? writer.readRunMetadata(runId) : writer.readCheckpoints(runId);
    },
  );
}

/** A failed or missing insert confirmation is never retried by this client. */
export async function connectCheckpointEvidenceRpc(
  socketPath: string,
  runId: string,
): Promise<{ port: CheckpointEvidencePort; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  const sameRun = (requested: string) => {
    if (requested !== runId) throw new Error('checkpoint evidence run ID does not match');
  };
  return {
    processId: connection.processId,
    port: {
      readRunMetadata: async (requested) => {
        sameRun(requested);
        const result = await connection.call('readRunMetadata', [runId]);
        if (result === null) return undefined;
        if (!record(result) || result['runId'] !== runId ||
            typeof result['configurationJson'] !== 'string' ||
            typeof result['configurationHash'] !== 'string') {
          throw new Error('checkpoint evidence metadata is malformed');
        }
        return result as unknown as RunMetadataRecord;
      },
      readCheckpoints: async (requested) => {
        sameRun(requested);
        const result = await connection.call('readCheckpoints', [runId]);
        if (!Array.isArray(result)) throw new Error('checkpoint evidence chain is malformed');
        return result.map((manifest) => CheckpointManifestSchema.parse(manifest));
      },
      readEvents: async (requested, stream, range) => {
        sameRun(requested);
        if (!validStream(stream) || (range !== undefined && !validRange(range))) {
          throw new Error('checkpoint evidence read scope is invalid');
        }
        const args = range === undefined ? [runId, stream] : [runId, stream, range];
        const result = await connection.call('readEvents', args);
        if (!Array.isArray(result) || result.some((row) => !record(row) ||
            row['stream'] !== stream || !Number.isSafeInteger(row['sequence']) ||
            Number(row['sequence']) < 1 || typeof row['canonicalJson'] !== 'string' ||
            typeof row['entryHash'] !== 'string')) {
          throw new Error('checkpoint evidence event read is malformed');
        }
        return result as StoredEvent[];
      },
      insertCheckpointManifest: async (manifest) => {
        const parsed = CheckpointManifestSchema.parse(manifest);
        if (parsed.runIdHash !== hashRunId(runId)) {
          throw new Error('checkpoint evidence manifest run ID does not match');
        }
        const result = await connection.call('insertCheckpointManifest', [parsed]);
        if (result !== null) throw new Error('checkpoint evidence insert result is malformed');
      },
    },
  };
}
