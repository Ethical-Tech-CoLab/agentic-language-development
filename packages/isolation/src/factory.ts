/**
 * `LearnerAdapterFactory` for an isolated learner (SPEC §5.2, §5.3; ALD-053
 * support, ALD-055).
 *
 * The Nursery runtime already has the seam this plugs into: its
 * `adapterFactoryFor(config, role)` option decides how each Baby's adapter is
 * built, and `LearnerAdapterFactory.isolation` is what a Mode R run is checked
 * against. So Mode R needs no new runtime concept — it needs a factory whose
 * `isolation` is `separate-process` or `separate-container` and whose
 * `create()` returns a proxy. Both are here.
 *
 * One factory is one Baby: a container factory carries one endpoint, and the
 * runtime asks for one factory per role. `dispose()` exists because a factory
 * that spawns processes owns them, and a test or an aborted run must be able
 * to reclaim them deterministically.
 */
import {
  type LearnerAdapterFactory,
  type LearnerTrackId,
} from '@ald/types';

import { IsolationError } from './errors.js';
import {
  ProcessHostChannel,
  type ProcessTransportOptions,
} from './process-transport.js';
import {
  RemoteLearnerAdapter,
  type HostTransport,
  type RemoteLearnerAdapterOptions,
} from './remote-adapter.js';
import {
  connectTcpFrameChannel,
  type TcpConnectOptions,
  type TcpFrameChannel,
} from './tcp-transport.js';
import type { FrameChannel } from './channel.js';
import { canonicalPayload } from './frames.js';

/** A learner host in its own OS process, spawned on construction. */
export class ProcessHostTransport implements HostTransport {
  readonly boundary = 'separate-process' as const;

  readonly hostLabel: string | undefined;

  private readonly channel: ProcessHostChannel;

  constructor(options: ProcessTransportOptions = {}) {
    this.hostLabel = options.hostLabel;
    // Spawned eagerly so `IsolationDescriptor.processId` is available before
    // `init` — ALD-055 criterion 1 compares process ids, and a descriptor
    // that only appears after a handshake is harder to audit.
    this.channel = new ProcessHostChannel(options);
  }

  current(): FrameChannel {
    return this.channel;
  }

  open(): Promise<FrameChannel> {
    return Promise.resolve(this.channel);
  }

  /** Counters (stderr bytes/lines, exit code); never stderr content. */
  get diagnostics(): ProcessHostChannel['diagnostics'] {
    return this.channel.diagnostics;
  }

  get alive(): boolean {
    return this.channel.alive;
  }

  async terminate(): Promise<void> {
    this.channel.kill();
    await this.channel.waitForExit();
    this.channel.close();
  }
}

/** A learner host in another container, reached over the internal network. */
export class ContainerHostTransport implements HostTransport {
  readonly boundary = 'separate-container' as const;

  readonly hostLabel: string | undefined;

  private channel: TcpFrameChannel | undefined;

  constructor(private readonly options: TcpConnectOptions & { hostLabel?: string }) {
    this.hostLabel = options.hostLabel ?? `${options.host}:${String(options.port)}`;
  }

  current(): FrameChannel | undefined {
    return this.channel;
  }

  async open(): Promise<FrameChannel> {
    this.channel ??= await connectTcpFrameChannel(this.options);
    return this.channel;
  }

  async terminate(): Promise<void> {
    this.channel?.close();
    return Promise.resolve();
  }
}

export interface IsolatedAdapterFactoryOptions
  extends Omit<RemoteLearnerAdapterOptions, 'transport' | 'track'> {
  track: LearnerTrackId;
  /** `process` spawns a child; `container` connects to one (SPEC §5.3). */
  transport?: 'process' | 'container';
  /** Process transport knobs (permission model, entry, env, cwd, stderr). */
  process?: ProcessTransportOptions;
  /** Container endpoint. Required when `transport` is `container`. */
  endpoint?: TcpConnectOptions & { hostLabel?: string };
}

export interface IsolatedAdapterFactory extends LearnerAdapterFactory {
  readonly isolation: 'separate-process' | 'separate-container';
  create(): RemoteLearnerAdapter;
  /** Every adapter this factory has created, in creation order. */
  readonly adapters: readonly RemoteLearnerAdapter[];
  /** Dispose every adapter (and therefore every host) this factory created. */
  dispose(): Promise<void>;
}

/**
 * Build an isolated factory for one Baby.
 *
 * `learnerOptions` must be JSON-safe: it is serialized into the host's `init`
 * frame so the host can call `createLearnerAdapterFactory(track, options)`
 * itself. That is checked here rather than at the first call, because a track
 * whose options carry a live object (a model client, a file handle) cannot be
 * configured *by value* across a boundary — such a host has to build the
 * object from its own environment, and finding that out at run start is much
 * better than finding it out on turn one.
 */
export function createIsolatedAdapterFactory(
  options: IsolatedAdapterFactoryOptions,
): IsolatedAdapterFactory {
  const transportKind = options.transport ?? 'process';
  if (transportKind === 'container' && options.endpoint === undefined) {
    throw new IsolationError('configuration');
  }
  if (options.learnerOptions !== undefined) {
    canonicalPayload(options.learnerOptions, 'learnerOptions');
  }

  const adapters: RemoteLearnerAdapter[] = [];
  const isolation =
    transportKind === 'process'
      ? ('separate-process' as const)
      : ('separate-container' as const);

  return {
    track: options.track,
    isolation,
    adapters,
    create(): RemoteLearnerAdapter {
      const transport: HostTransport =
        transportKind === 'process'
          ? new ProcessHostTransport({
              ...options.process,
              // The host is pinned to this track unless the caller passed its
              // own arguments: a host built for one Baby's track must refuse
              // an `init` that names another (`invalid-params`).
              hostArgs: options.process?.hostArgs ?? [`--track=${options.track}`],
            })
          : new ContainerHostTransport(
              options.endpoint as TcpConnectOptions & { hostLabel?: string },
            );
      const adapter = new RemoteLearnerAdapter({
        track: options.track,
        transport,
        ...(options.learnerOptions === undefined
          ? {}
          : { learnerOptions: options.learnerOptions }),
        ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
        ...(options.maxPayloadBytes === undefined
          ? {}
          : { maxPayloadBytes: options.maxPayloadBytes }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
        ...(options.deadlineMs === undefined
          ? {}
          : { deadlineMs: options.deadlineMs }),
        ...(options.timer === undefined ? {} : { timer: options.timer }),
      });
      adapters.push(adapter);
      return adapter;
    },
    async dispose(): Promise<void> {
      const pending = adapters.map(async (adapter) => {
        try {
          await adapter.dispose();
        } catch {
          // Teardown is best-effort: a host that already died is disposed.
        }
      });
      await Promise.all(pending);
      adapters.length = 0;
    },
  };
}
