import type { Server } from 'node:net';

import {
  connectEvidenceRpc,
  createEvidenceRpcServer,
  isRpcRecord,
} from '@ald/evidence';
import {
  AnchorReceiptSchema,
  CheckpointManifestSchema,
  type AnchorPublisher,
} from '@ald/types';

const PROTOCOL = 'anchor-service-v1';
const METHODS = ['describe', 'submit', 'awaitConfirmation'] as const;

/** Run-bound simulated/public Anchor publisher endpoint; never retries RPC. */
export function createAnchorServiceRpcServer(
  socketPath: string,
  runId: string,
  publisher: AnchorPublisher,
): Promise<Server> {
  return createEvidenceRpcServer(
    socketPath,
    runId,
    PROTOCOL,
    METHODS,
    (method, args) => method === 'describe'
      ? args.length === 0
      : args.length === 1,
    async (method, args) => {
      if (method === 'describe') {
        return {
          anchorClass: publisher.anchorClass,
          network: publisher.network,
        };
      }
      if (method === 'submit') {
        return publisher.submit(CheckpointManifestSchema.parse(args[0]));
      }
      return publisher.awaitConfirmation(AnchorReceiptSchema.parse(args[0]));
    },
  );
}

/** Connect the Controller to one run's separate Anchor publisher. */
export async function connectAnchorServiceRpc(
  socketPath: string,
  runId: string,
  expected: Pick<AnchorPublisher, 'anchorClass' | 'network'>,
): Promise<{ publisher: AnchorPublisher; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, runId, PROTOCOL);
  const described = await connection.call('describe', []);
  if (!isRpcRecord(described) || described['anchorClass'] !== expected.anchorClass ||
      described['network'] !== expected.network ||
      Object.keys(described).sort().join(',') !== 'anchorClass,network') {
    throw new Error('Anchor Service identity does not match');
  }
  return {
    processId: connection.processId,
    publisher: {
      anchorClass: expected.anchorClass,
      network: expected.network,
      submit: async (manifest) => AnchorReceiptSchema.parse(
        await connection.call('submit', [manifest]),
      ),
      awaitConfirmation: async (receipt) => AnchorReceiptSchema.parse(
        await connection.call('awaitConfirmation', [receipt]),
      ),
    },
  };
}
