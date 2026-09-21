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

export interface BabyHostCliOptions {
  track?: LearnerTrackId;
  frameSize?: number;
  hostLabel?: string;
  modelHostLabel?: string;
}

/** Parse the Baby host's deliberately small process-mode CLI. */
export function parseBabyHostCliOptions(argv: readonly string[]): BabyHostCliOptions {
  const options: BabyHostCliOptions = {};
  for (const argument of argv) {
    const [flag, rawValue] = splitFlag(argument);
    switch (flag) {
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
  const channel = new StdioFrameChannel();
  let stopping = false;

  const createFactory = (
    track: LearnerTrackId,
    learnerOptions: Record<string, unknown>,
  ): LearnerAdapterFactory => {
    if (options.track !== undefined && track !== options.track) {
      throw new Error('baby host track mismatch');
    }
    const factory = createIsolatedAdapterFactory({
      track,
      learnerOptions,
      timing: 'immediate',
      turnDeadlineAuthority: 'upstream',
      ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
      process: {
        hostLabel: options.modelHostLabel ?? `model-adapter-${track}`,
      },
    });
    factories.add(factory);
    return factory;
  };

  const stop = async (host: LearnerHost): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await Promise.all([...factories].map((factory) => factory.dispose()));
    await host.close();
    process.exit(0);
  };

  const host = new LearnerHost({
    channel,
    boundary: 'separate-process',
    ...(options.track === undefined ? {} : { track: options.track }),
    ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
    ...(options.hostLabel === undefined ? {} : { hostLabel: options.hostLabel }),
    createFactory,
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
}
