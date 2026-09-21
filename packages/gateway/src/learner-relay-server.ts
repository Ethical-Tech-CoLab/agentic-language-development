/** Selected-shape Gateway learner relay listener and Controller factory. */
import type { LearnerAdapterFactory, LearnerTrackId } from '@ald/types';
import {
  RemoteLearnerAdapter,
  UnixHostTransport,
  connectTcpFrameChannel,
  createUnixFrameServer,
  type RemoteLearnerAdapterOptions,
  type TcpConnectOptions,
  type UnixFrameServer,
} from '@ald/isolation';

import {
  GatewayLearnerRelay,
  type GatewayLearnerRelayOptions,
} from './learner-relay.js';

export interface GatewayLearnerRelayServerOptions
  extends Pick<
    GatewayLearnerRelayOptions,
    'writer' | 'runId' | 'role' | 'babyId' | 'deadlineMs' | 'frameSize' |
      'maxPayloadBytes'
  > {
  socketPath: string;
  babyEndpoint: TcpConnectOptions;
}

export interface GatewayLearnerRelayServer {
  readonly socketPath: string;
  readonly server: UnixFrameServer;
  relay(): GatewayLearnerRelay | undefined;
  close(): Promise<void>;
}

/**
 * Open the Gateway's fixed Baby destination first, then admit one Controller
 * on the role-specific private socket. Neither peer can select the other.
 */
export async function createGatewayLearnerRelayServer(
  options: GatewayLearnerRelayServerOptions,
): Promise<GatewayLearnerRelayServer> {
  const babyChannel = await connectTcpFrameChannel(options.babyEndpoint);
  let relay: GatewayLearnerRelay | undefined;
  let server: UnixFrameServer;
  try {
    server = await createUnixFrameServer({
      socketPath: options.socketPath,
      onChannel: (controllerChannel) => {
        relay = new GatewayLearnerRelay({
          controllerChannel,
          babyChannel,
          writer: options.writer,
          runId: options.runId,
          role: options.role,
          babyId: options.babyId,
          ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
          ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
          ...(options.maxPayloadBytes === undefined
            ? {}
            : { maxPayloadBytes: options.maxPayloadBytes }),
        });
      },
    });
  } catch (error) {
    babyChannel.close();
    throw error;
  }
  return {
    socketPath: options.socketPath,
    server,
    relay: () => relay,
    async close(): Promise<void> {
      relay?.close();
      babyChannel.close();
      await server.close();
    },
  };
}

export interface GatewayRelayAdapterFactoryOptions
  extends Omit<RemoteLearnerAdapterOptions, 'transport' | 'track'> {
  track: LearnerTrackId;
  socketPath: string;
  hostLabel?: string;
}

export interface GatewayRelayAdapterFactory extends LearnerAdapterFactory {
  readonly adapters: readonly RemoteLearnerAdapter[];
  create(): RemoteLearnerAdapter;
  dispose(): Promise<void>;
}

/** Controller factory with no Baby address—only its fixed Gateway socket. */
export function createGatewayRelayAdapterFactory(
  options: GatewayRelayAdapterFactoryOptions,
): GatewayRelayAdapterFactory {
  const adapters: RemoteLearnerAdapter[] = [];
  return {
    track: options.track,
    adapters,
    create(): RemoteLearnerAdapter {
      const adapter = new RemoteLearnerAdapter({
        track: options.track,
        transport: new UnixHostTransport({
          socketPath: options.socketPath,
          ...(options.hostLabel === undefined ? {} : { hostLabel: options.hostLabel }),
        }),
        ...(options.learnerOptions === undefined
          ? {}
          : { learnerOptions: options.learnerOptions }),
        ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
        ...(options.maxPayloadBytes === undefined
          ? {}
          : { maxPayloadBytes: options.maxPayloadBytes }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
        ...(options.turnDeadlineAuthority === undefined
          ? {}
          : { turnDeadlineAuthority: options.turnDeadlineAuthority }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.timer === undefined ? {} : { timer: options.timer }),
      });
      adapters.push(adapter);
      return adapter;
    },
    async dispose(): Promise<void> {
      await Promise.all(adapters.map((adapter) => adapter.dispose().catch(() => undefined)));
      adapters.length = 0;
    },
  };
}
