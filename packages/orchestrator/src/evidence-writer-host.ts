import type { Server } from 'node:net';

import {
  createAnchorEvidenceRpcServer,
  createAuditEvidenceRpcServer,
  createCheckpointEvidenceRpcServer,
  createControllerEvidenceRpcServer,
  type SqliteEvidenceWriter,
} from '@ald/evidence';
import {
  createGatewayEvidenceRpcServer,
  type GatewayEvidenceRpcServerOptions,
} from '@ald/gateway';

export interface EvidenceWriterCapabilitySockets {
  controller: string;
  gateway: string;
  checkpoint: string;
  anchor: string;
  audit: string;
}

export interface EvidenceWriterRpcHost {
  readonly processId: number;
  readonly sockets: EvidenceWriterCapabilitySockets;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/**
 * Opens the five v2 caller capabilities over one SQLite transaction owner.
 * Caller-exclusive mounts and process/network qualification remain deployment
 * responsibilities; this host only prevents a second writer object.
 */
export async function createEvidenceWriterRpcHost(
  runId: string,
  writer: SqliteEvidenceWriter,
  sockets: EvidenceWriterCapabilitySockets,
  options: { gateway?: GatewayEvidenceRpcServerOptions } = {},
): Promise<EvidenceWriterRpcHost> {
  if (runId.length === 0) throw new Error('evidence writer host run ID is required');
  if (new Set(Object.values(sockets)).size !== Object.keys(sockets).length) {
    throw new Error('evidence writer capabilities require distinct socket paths');
  }
  const servers: Server[] = [];
  try {
    servers.push(await createControllerEvidenceRpcServer(sockets.controller, runId, writer));
    servers.push(await createGatewayEvidenceRpcServer(
      sockets.gateway, runId, writer, options.gateway));
    servers.push(await createCheckpointEvidenceRpcServer(sockets.checkpoint, runId, writer));
    servers.push(await createAnchorEvidenceRpcServer(sockets.anchor, runId, writer));
    servers.push(await createAuditEvidenceRpcServer(sockets.audit, runId, writer));
  } catch (error) {
    await Promise.allSettled(servers.reverse().map(closeServer));
    throw error;
  }
  let closed = false;
  return {
    processId: process.pid,
    sockets: { ...sockets },
    close: async () => {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled(servers.reverse().map(closeServer));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}
