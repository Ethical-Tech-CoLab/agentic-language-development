import type { Server } from 'node:net';

import { connectEvidenceRpc, createEvidenceRpcServer } from '@ald/evidence';
import {
  CheckpointManifestSchema,
  CheckpointReasonSchema,
  ConsistencyProofSchema,
  EVENT_STREAMS,
  InclusionProofSchema,
  type CheckpointService,
  type EventStream,
} from '@ald/types';

const PROTOCOL = 'checkpoint-service-v1';
const METHODS = [
  'createCheckpoint',
  'inclusionProof',
  'consistencyProof',
] as const;
type Method = (typeof METHODS)[number];

function integer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function validArgs(runId: string, method: string, args: unknown[]): boolean {
  if (!METHODS.includes(method as Method) || args[0] !== runId) return false;
  if (method === 'createCheckpoint') {
    return args.length === 2 && CheckpointReasonSchema.safeParse(args[1]).success;
  }
  if (method === 'inclusionProof') {
    return args.length === 4 && EVENT_STREAMS.includes(args[1] as EventStream) &&
      integer(args[2], 1) && integer(args[3], 0);
  }
  return args.length === 4 && EVENT_STREAMS.includes(args[1] as EventStream) &&
    integer(args[2], 0) && integer(args[3], 0);
}

/** Run-bound Checkpoint Service endpoint; calls are never retried. */
export function createCheckpointServiceRpcServer(
  socketPath: string,
  runId: string,
  service: CheckpointService,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath,
    runId,
    PROTOCOL,
    METHODS,
    (method, args) => validArgs(runId, method, args),
    async (method, args) => {
      switch (method as Method) {
        case 'createCheckpoint':
          return service.createCheckpoint(
            runId,
            CheckpointReasonSchema.parse(args[1]),
          );
        case 'inclusionProof':
          return service.inclusionProof(
            runId,
            args[1] as EventStream,
            Number(args[2]),
            Number(args[3]),
          );
        case 'consistencyProof':
          return service.consistencyProof(
            runId,
            args[1] as EventStream,
            Number(args[2]),
            Number(args[3]),
          );
      }
    },
  );
}

/** Connect the Controller to one run's separate Checkpoint Service. */
export async function connectCheckpointServiceRpc(
  socketPath: string,
  runId: string,
): Promise<{ service: CheckpointService; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  return {
    processId: connection.processId,
    service: {
      createCheckpoint: async (requestedRunId, reason) => {
        if (requestedRunId !== runId) throw new Error('checkpoint run ID mismatch');
        return CheckpointManifestSchema.parse(
          await connection.call('createCheckpoint', [runId, reason]),
        );
      },
      inclusionProof: async (
        requestedRunId,
        stream,
        sequence,
        checkpointSequence,
      ) => {
        if (requestedRunId !== runId) throw new Error('checkpoint run ID mismatch');
        return InclusionProofSchema.parse(await connection.call('inclusionProof', [
          runId,
          stream,
          sequence,
          checkpointSequence,
        ]));
      },
      consistencyProof: async (
        requestedRunId,
        stream,
        fromCheckpointSequence,
        toCheckpointSequence,
      ) => {
        if (requestedRunId !== runId) throw new Error('checkpoint run ID mismatch');
        return ConsistencyProofSchema.parse(await connection.call('consistencyProof', [
          runId,
          stream,
          fromCheckpointSequence,
          toCheckpointSequence,
        ]));
      },
    },
  };
}
