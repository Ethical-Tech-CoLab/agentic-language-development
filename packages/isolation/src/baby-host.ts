/**
 * A Baby process that owns the learner-facing boundary while delegating model
 * execution to a second, locked-down learner-host process.
 *
 * The outer {@link LearnerHost} owns the fixed turn schedule and the private
 * ledger capability. The inner {@link RemoteLearnerAdapter} is deliberately
 * immediate and delegates turn deadlines upstream, so there is one deadline
 * decision rather than two timers racing at the same tick.
 */
import type {
  LearnerAdapterFactory,
  LearnerTrackId,
} from '@ald/types';

import { createIsolatedAdapterFactory, type IsolatedAdapterFactory } from './factory.js';
import { LearnerHost, StdioFrameChannel } from './host.js';
import { createTcpFrameServer, type TcpFrameServer } from './tcp-transport.js';

export interface BabyHostCliOptions {
  transport: 'process' | 'tcp';
  port?: number;
  bindHost?: string;
  track?: LearnerTrackId;
  frameSize?: number;
  hostLabel?: string;
  modelHostLabel?: string;
  modelHost?: string;
  modelPort?: number;
}

/** Parse the Baby host's deliberately small process-mode CLI. */
export function parseBabyHostCliOptions(argv: readonly string[]): BabyHostCliOptions {
  const options: BabyHostCliOptions = { transport: 'process' };
  for (const argument of argv) {
    const [flag, rawValue] = splitFlag(argument);
    switch (flag) {
      case '--transport':
        options.transport = rawValue === 'tcp' ? 'tcp' : 'process';
        break;
      case '--port':
        options.port = Number(rawValue);
        break;
      case '--bind':
        options.bindHost = rawValue;
        break;
      case '--track':
        options.track = rawValue as LearnerTrackId;
        break;
      case '--frame-size':
        options.frameSize = Number(rawValue);
        break;
      case '--host-label':
        options.hostLabel = rawValue;
        break;
      case '--model-host-label':
        options.modelHostLabel = rawValue;
        break;
      case '--model-host':
        options.modelHost = rawValue;
        break;
      case '--model-port':
        options.modelPort = Number(rawValue);
        break;
      default:
        throw new Error(`unknown baby-host flag: ${flag}`);
    }
  }
  return options;
}

function splitFlag(argument: string): [string, string | undefined] {
  const equals = argument.indexOf('=');
  return equals < 0
    ? [argument, undefined]
    : [argument.slice(0, equals), argument.slice(equals + 1)];
}

/** Entry point used by `bin/ald-baby-host.js`. */
export async function runBabyHostCli(argv: readonly string[]): Promise<void> {
  const options = parseBabyHostCliOptions(argv);
  const factories = new Set<IsolatedAdapterFactory>();
  let stopping = false;

  const createFactory = (
    track: LearnerTrackId,
    learnerOptions: Record<string, unknown>,
  ): LearnerAdapterFactory => {
    if (options.track !== undefined && track !== options.track) {
      throw new Error('baby host track mismatch');
    }
    const modelEndpoint = options.modelHost !== undefined && options.modelPort !== undefined
      ? {
          host: options.modelHost,
          port: options.modelPort,
          attempts: 20,
          retryDelayMs: 50,
          hostLabel: options.modelHostLabel ?? `model-adapter-${track}`,
        }
      : undefined;
    const factory = createIsolatedAdapterFactory({
      track,
      learnerOptions,
      timing: 'immediate',
      turnDeadlineAuthority: 'upstream',
      ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
      ...(modelEndpoint === undefined
        ? {
            process: {
              hostLabel: options.modelHostLabel ?? `model-adapter-${track}`,
            },
          }
        : { transport: 'container', endpoint: modelEndpoint }),
    });
    factories.add(factory);
    return factory;
  };

  const serverState: { value?: TcpFrameServer } = {};
  const stop = async (host: LearnerHost): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.all([...factories].map((factory) => factory.dispose()));
    await host.close();
    await serverState.value?.close();
    process.exit(0);
  };

  const shared = {
    ...(options.track === undefined ? {} : { track: options.track }),
    ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
    ...(options.hostLabel === undefined ? {} : { hostLabel: options.hostLabel }),
    createFactory,
  };
  if (options.transport === 'process') {
    if (options.modelHost !== undefined || options.modelPort !== undefined) {
      throw new Error('process Baby host cannot use a container model endpoint');
    }
    const channel = new StdioFrameChannel();
    const host = new LearnerHost({
      ...shared,
      channel,
      boundary: 'separate-process',
      onShutdown: () => {
        void stop(host);
      },
    });
    channel.onClose(() => {
      void stop(host);
    });
    await new Promise<void>(() => {
      // Runs until stdin closes or `shutdown` arrives.
    });
    return;
  }

  if (options.port === undefined || !Number.isInteger(options.port) ||
      options.modelHost === undefined || options.modelPort === undefined ||
      !Number.isInteger(options.modelPort)) {
    throw new Error(
      '--port, --model-host, and --model-port are required for --transport=tcp',
    );
  }
  serverState.value = await createTcpFrameServer({
    port: options.port,
    ...(options.bindHost === undefined ? {} : { host: options.bindHost }),
    maxConnections: 1,
    onChannel: (channel) => {
      const host = new LearnerHost({
        ...shared,
        channel,
        boundary: 'separate-container',
        onShutdown: () => {
          void stop(host);
        },
      });
      channel.onClose(() => {
        void stop(host);
      });
    },
  });
  await new Promise<void>(() => {
    // Runs until the single Controller connection closes or shutdown arrives.
  });
}
