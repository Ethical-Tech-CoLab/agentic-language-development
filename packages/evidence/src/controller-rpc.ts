import type { Server } from 'node:net';

import {
  AnchorReceiptSchema,
  CheckpointManifestSchema,
  ExperimentRecordSchema,
  InterventionEventSchema,
  SignerPublicKeyRecordSchema,
  TurnRecordSchema,
  type EvidenceWriter,
} from '@ald/types';

import type { SqliteEvidenceWriter } from './writer.js';
import { connectEvidenceRpc, createEvidenceRpcServer, record } from './rpc-wire.js';

const METHODS = [
  'registerRun', 'readRunMetadata', 'chainHead', 'readEvents',
  'readCheckpoints', 'readAnchorReceipts', 'readExperimentRecords',
  'readAnalysisAttachments', 'readRunSigners', 'readForkArtifacts',
  'appendTurnRecord', 'appendInterventionEvent', 'appendAnalysisAttachment',
  'appendExperimentRecord', 'recover',
] as const;
type ControllerMethod = (typeof METHODS)[number];
type WriterMethods = EvidenceWriter & Pick<SqliteEvidenceWriter, 'readForkArtifacts'>;
type AsyncMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>> : never;

export type ControllerEvidencePort = {
  [K in ControllerMethod]: AsyncMethod<WriterMethods[K]>;
};

const PROTOCOL = 'controller-evidence-v1';

function callRunId(method: ControllerMethod, args: unknown[]): unknown {
  const first = args[0];
  return method === 'registerRun' || method.startsWith('append')
    ? record(first) ? first['runId'] : undefined
    : first;
}

function validHash(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function resultFor(method: ControllerMethod, result: unknown, runId: string): unknown {
  if (method === 'registerRun') {
    if (!record(result) || !validHash(result['configurationHash'])) {
      throw new Error('controller evidence registration result is malformed');
    }
    return result;
  }
  if (method === 'appendTurnRecord') return TurnRecordSchema.parse(result);
  if (method === 'appendInterventionEvent') return InterventionEventSchema.parse(result);
  if (method === 'appendExperimentRecord') {
    if (result !== null) throw new Error('controller evidence append result is malformed');
    return undefined;
  }
  if (method === 'readRunMetadata') {
    if (result === null) return undefined;
    if (!record(result) || result['runId'] !== runId ||
        !validHash(result['configurationHash'])) {
      throw new Error('controller evidence metadata is malformed');
    }
    return result;
  }
  if (method === 'chainHead') {
    if (!record(result) || typeof result['stream'] !== 'string' ||
        !Number.isSafeInteger(result['size']) || Number(result['size']) < 0 ||
        !validHash(result['lastEntryHash'])) {
      throw new Error('controller evidence chain head is malformed');
    }
    return result;
  }
  if (method === 'appendAnalysisAttachment') {
    if (!record(result) || !record(result['descriptor']) ||
        typeof result['canonicalJson'] !== 'string') {
      throw new Error('controller evidence attachment result is malformed');
    }
    return result;
  }
  if (method === 'recover') {
    if (!record(result) || result['runId'] !== runId ||
        typeof result['ok'] !== 'boolean' || !Array.isArray(result['heads']) ||
        !Array.isArray(result['forks']) || !Array.isArray(result['chainViolations'])) {
      throw new Error('controller evidence recovery result is malformed');
    }
    return result;
  }
  if (!Array.isArray(result)) throw new Error('controller evidence read result is malformed');
  if (method === 'readCheckpoints') return result.map((row) => CheckpointManifestSchema.parse(row));
  if (method === 'readAnchorReceipts') return result.map((row) => AnchorReceiptSchema.parse(row));
  if (method === 'readExperimentRecords') return result.map((row) => ExperimentRecordSchema.parse(row));
  if (method === 'readRunSigners') return result.map((row) => SignerPublicKeyRecordSchema.parse(row));
  if (method === 'readEvents' && result.some((row) => !record(row) ||
      !validHash(row['entryHash']) || typeof row['canonicalJson'] !== 'string')) {
    throw new Error('controller evidence event read is malformed');
  }
  return result;
}

/**
 * Gives the in-process runtime the same asynchronous, run-bound capability as
 * the socket client. Keeping this adapter exact lets Nursery migrate call
 * sites before selecting whether the endpoint is local or remote.
 */
export function controllerEvidencePortForWriter(
  runId: string,
  writer: SqliteEvidenceWriter,
): ControllerEvidencePort {
  return Object.fromEntries(METHODS.map((method) => [method,
    async (...args: unknown[]) => {
      if (callRunId(method, args) !== runId) {
        throw new Error('controller evidence request run ID does not match');
      }
      const operation = writer[method] as (...values: unknown[]) => unknown;
      const result = await operation.apply(writer, args);
      return resultFor(method, result === undefined ? null : result, runId);
    },
  ])) as ControllerEvidencePort;
}

/** A caller-exclusive socket mount is required; this component alone is not B12. */
export async function createControllerEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: SqliteEvidenceWriter,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath, runId, PROTOCOL, METHODS,
    (method, args) => callRunId(method as ControllerMethod, args) === runId,
    (method, args) => {
      const operation = writer[method as ControllerMethod] as (...values: unknown[]) => unknown;
      return operation.apply(writer, args);
    },
  );
}

/** No request is retried after an uncertain response. */
export async function connectControllerEvidenceRpc(
  socketPath: string,
  runId: string,
): Promise<{ port: ControllerEvidencePort; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  const port = Object.fromEntries(METHODS.map((method) => [method,
    async (...args: unknown[]) => {
      if (callRunId(method, args) !== runId) {
        throw new Error('controller evidence request run ID does not match');
      }
      return resultFor(method, await connection.call(method, args), runId);
    },
  ])) as ControllerEvidencePort;
  return { port, processId: connection.processId };
}
