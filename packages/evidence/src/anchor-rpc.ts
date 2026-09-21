import type { Server } from 'node:net';

import { hashRunId } from '@ald/hashing';
import {
  AnchorReceiptSchema,
  CheckpointManifestSchema,
  type AnchorReceipt,
  type CheckpointManifest,
  type EvidenceWriter,
} from '@ald/types';

import { connectEvidenceRpc, createEvidenceRpcServer } from './rpc-wire.js';

const METHODS = [
  'listRuns', 'readCheckpoints', 'readAnchorReceipts', 'insertAnchorReceipt',
] as const;
const PROTOCOL = 'anchor-evidence-v1';

export interface AnchorEvidencePort {
  listRuns(): Promise<string[]>;
  readCheckpoints(runId: string): Promise<CheckpointManifest[]>;
  readAnchorReceipts(runId: string): Promise<AnchorReceipt[]>;
  insertAnchorReceipt(receipt: AnchorReceipt): Promise<void>;
}

function validSimulatedReceipt(value: unknown, runId: string): value is AnchorReceipt {
  const parsed = AnchorReceiptSchema.safeParse(value);
  return parsed.success && parsed.data.runId === runId &&
    parsed.data.anchorClass === 'simulated' && parsed.data.network === 'base-sepolia' &&
    parsed.data.status !== 'submitted' &&
    parsed.data.inputData === `0x${parsed.data.checkpointHash.slice('sha256:'.length)}`;
}

/** The run-bound simulated Anchor may not read other run IDs or use public-chain receipts. */
export function createAnchorEvidenceRpcServer(
  socketPath: string,
  runId: string,
  writer: EvidenceWriter,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath, runId, PROTOCOL, METHODS,
    (method, args) => {
      if (method === 'listRuns') return args.length === 0;
      if (method === 'insertAnchorReceipt') {
        const receipt = args[0];
        return args.length === 1 && validSimulatedReceipt(receipt, runId) &&
          writer.readCheckpoints(runId).some((manifest) =>
            manifest.checkpointHash === receipt.checkpointHash);
      }
      return args.length === 1 && args[0] === runId;
    },
    (method, args) => {
      if (method === 'listRuns') {
        return writer.listRuns().includes(runId) ? [runId] : [];
      }
      if (method === 'readCheckpoints') return writer.readCheckpoints(runId);
      if (method === 'readAnchorReceipts') return writer.readAnchorReceipts(runId);
      return writer.insertAnchorReceipt(args[0] as AnchorReceipt);
    },
  );
}

/** A missing receipt-insert confirmation is not retried. */
export async function connectAnchorEvidenceRpc(
  socketPath: string,
  runId: string,
): Promise<{ port: AnchorEvidencePort; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  const sameRun = (requested: string) => {
    if (requested !== runId) throw new Error('anchor evidence run ID does not match');
  };
  return {
    processId: connection.processId,
    port: {
      listRuns: async () => {
        const result = await connection.call('listRuns', []);
        if (!Array.isArray(result) || (result.length !== 0 &&
            (result.length !== 1 || result[0] !== runId))) {
          throw new Error('anchor evidence run list is malformed');
        }
        return result as string[];
      },
      readCheckpoints: async (requested) => {
        sameRun(requested);
        const result = await connection.call('readCheckpoints', [runId]);
        if (!Array.isArray(result)) throw new Error('anchor evidence checkpoints are malformed');
        return result.map((value: unknown) => {
          const manifest = CheckpointManifestSchema.parse(value);
          if (manifest.runIdHash !== hashRunId(runId)) {
            throw new Error('anchor evidence checkpoint run ID does not match');
          }
          return manifest;
        });
      },
      readAnchorReceipts: async (requested) => {
        sameRun(requested);
        const result = await connection.call('readAnchorReceipts', [runId]);
        if (!Array.isArray(result)) throw new Error('anchor evidence receipts are malformed');
        return result.map((value: unknown) => {
          const receipt = AnchorReceiptSchema.parse(value);
          if (receipt.runId !== runId) {
            throw new Error('anchor evidence receipt run ID does not match');
          }
          return receipt;
        });
      },
      insertAnchorReceipt: async (receipt) => {
        if (!validSimulatedReceipt(receipt, runId)) {
          throw new Error('anchor evidence receipt scope is invalid');
        }
        const result = await connection.call('insertAnchorReceipt', [receipt]);
        if (result !== null) throw new Error('anchor evidence insert result is malformed');
      },
    },
  };
}
