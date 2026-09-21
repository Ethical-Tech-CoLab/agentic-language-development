/** Runtime-side factory for a distinct Baby process and model-adapter process. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  LearnerAdapterFactory,
  LearnerTrackId,
} from '@ald/types';

import { IsolationError } from './errors.js';
import { canonicalPayload } from './frames.js';
import { isolationPackageRoot, type ProcessTransportOptions } from './process-transport.js';
import { ProcessHostTransport } from './factory.js';
import { ContainerHostTransport } from './factory.js';
import type { TcpConnectOptions } from './tcp-transport.js';
import {
  RemoteLearnerAdapter,
  type RemoteLearnerAdapterOptions,
} from './remote-adapter.js';

/** Built entry point for the outer Baby process. */
export function defaultBabyHostEntry(): string {
  return join(isolationPackageRoot(), 'bin', 'ald-baby-host.js');
}

export interface BabyProcessAdapterFactoryOptions
  extends Omit<
    RemoteLearnerAdapterOptions,
    'transport' | 'track' | 'turnDeadlineAuthority'
  > {
  track: LearnerTrackId;
  /** Launch controls for the outer Baby process. */
  process?: ProcessTransportOptions;
  /** Operator label for the inner model-adapter process. */
  modelHostLabel?: string;
}

export interface BabyProcessAdapterFactory extends LearnerAdapterFactory {
  readonly isolation: 'separate-process';
  create(): RemoteLearnerAdapter;
  readonly adapters: readonly RemoteLearnerAdapter[];
  dispose(): Promise<void>;
}

export interface BabyContainerAdapterFactoryOptions
  extends Omit<
    RemoteLearnerAdapterOptions,
    'transport' | 'track' | 'turnDeadlineAuthority'
  > {
  track: LearnerTrackId;
  endpoint: TcpConnectOptions & { hostLabel?: string };
}

export interface BabyContainerAdapterFactory extends LearnerAdapterFactory {
  readonly isolation: 'separate-container';
  create(): RemoteLearnerAdapter;
  readonly adapters: readonly RemoteLearnerAdapter[];
  dispose(): Promise<void>;
}

/**
 * Build one outer Baby process per adapter. Each Baby starts exactly one inner
 * learner host for its model adapter. This is the process-development shape;
 * the selected Mode R topology still requires container-route qualification.
 */
export function createBabyProcessAdapterFactory(
  options: BabyProcessAdapterFactoryOptions,
): BabyProcessAdapterFactory {
  if (options.learnerOptions !== undefined) {
    canonicalPayload(options.learnerOptions, 'learnerOptions');
  }
  const hostEntry = options.process?.hostEntry ?? defaultBabyHostEntry();
  if (!existsSync(hostEntry)) {
    throw new IsolationError('configuration');
  }
  const adapters: RemoteLearnerAdapter[] = [];

  return {
    track: options.track,
    isolation: 'separate-process',
    adapters,
    create(): RemoteLearnerAdapter {
      const inheritedArgs = options.process?.hostArgs ?? [];
      const transport = new ProcessHostTransport({
        ...options.process,
        hostEntry,
        // The outer process must be able to start its one inner model process.
        // This mode is development-only; selected isolation comes from the
        // prospectively qualified container graph.
        permissionModel: false,
        hostArgs: [
          `--track=${options.track}`,
          ...(options.frameSize === undefined
            ? []
            : [`--frame-size=${String(options.frameSize)}`]),
          `--host-label=${options.process?.hostLabel ?? `baby-${options.track}`}`,
          `--model-host-label=${options.modelHostLabel ?? `model-adapter-${options.track}`}`,
          ...inheritedArgs,
        ],
      });
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
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.timer === undefined ? {} : { timer: options.timer }),
      });
      adapters.push(adapter);
      return adapter;
    },
    async dispose(): Promise<void> {
      await Promise.all(
        adapters.map(async (adapter) => {
          try {
            await adapter.dispose();
          } catch {
            // A dead outer Baby has already made its inner model unreachable.
          }
        }),
      );
      adapters.length = 0;
    },
  };
}

/** Connect the Controller-side learner contract to one Baby container. */
export function createBabyContainerAdapterFactory(
  options: BabyContainerAdapterFactoryOptions,
): BabyContainerAdapterFactory {
  if (options.learnerOptions !== undefined) {
    canonicalPayload(options.learnerOptions, 'learnerOptions');
  }
  const adapters: RemoteLearnerAdapter[] = [];
  return {
    track: options.track,
    isolation: 'separate-container',
    adapters,
    create(): RemoteLearnerAdapter {
      const adapter = new RemoteLearnerAdapter({
        track: options.track,
        transport: new ContainerHostTransport(options.endpoint),
        ...(options.learnerOptions === undefined
          ? {}
          : { learnerOptions: options.learnerOptions }),
        ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
        ...(options.maxPayloadBytes === undefined
          ? {}
          : { maxPayloadBytes: options.maxPayloadBytes }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.timer === undefined ? {} : { timer: options.timer }),
      });
      adapters.push(adapter);
      return adapter;
    },
    async dispose(): Promise<void> {
      await Promise.all(adapters.map(async (adapter) => {
        try {
          await adapter.dispose();
        } catch {
          // A stopped Baby container has already disposed its model endpoint.
        }
      }));
      adapters.length = 0;
    },
  };
}
