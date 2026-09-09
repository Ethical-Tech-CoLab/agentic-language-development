/**
 * The learner host: the child process (or container) side of the boundary
 * (SPEC §4.1 item 5, §5.2, §6.2, §6.3, §10.3; ALD-055, ALD-056).
 *
 * A host holds exactly one `LearnerAdapter` and one duplex frame channel. It
 * has no Evidence Store handle, no signer, no scenario bundle, no run
 * registry, and no address for the other Baby: its only outbound capability
 * is the `ledger_append` reverse RPC, which the runtime binds to this Baby's
 * authenticated identity and current turn (SPEC §4.2, §12.7). That is the
 * whole point of ALD-056 — a training update can only read what this process
 * itself accumulated, because nothing else is reachable from here.
 *
 * Nothing in this file writes to stdout except frames, and nothing writes a
 * message to the wire: a failure becomes one {@link HostErrorCode} and the
 * adapter's own text stays inside this process (SPEC §10.3).
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import {
  HASH_DOMAINS,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LearnerContract,
  type LearnerInitContext,
  type LearnerProvenance,
  type LearnerTrackId,
  type LearnerVisibleRunConfig,
  type LedgerEvent,
  type LedgerEventDraft,
  type OutcomeEvent,
  type PrivateLedgerClient,
  type Sha256Hash,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { createLearnerAdapterFactory } from '@ald/learners';

import { FrameConnection, type FrameChannel } from './channel.js';
import {
  HostProtocolError,
  isHostProtocolError,
  type HostErrorCode,
} from './errors.js';
import { DEFAULT_FRAME_SIZE } from './frames.js';
import {
  HOST_CAPABILITIES,
  HOST_METHODS,
  HOST_PARAM_SCHEMAS,
  LedgerAppendResultSchema,
  type HostCapability,
  type HostMethod,
  type InitParams,
  type ProbeOutcome,
} from './protocol.js';
import { createTcpFrameServer } from './tcp-transport.js';

const HOST_METHOD_SET: ReadonlySet<string> = new Set(HOST_METHODS);

/** Error text a withheld reward raises *inside the host*, never on the wire. */
const WITHHELD_REWARD_MESSAGE =
  'outcome.reward was read under a reward-free learning signal';

export interface LearnerHostOptions {
  channel: FrameChannel;
  /**
   * Boundary this host reports. A process host says `separate-process`; a
   * container host says `separate-container` (SPEC §5.3).
   */
  boundary?: 'separate-process' | 'separate-container';
  /**
   * Pin the host to one track. When set, an `init` naming a different track
   * is `invalid-params`: a container built for `baby-a`'s track cannot be
   * repurposed mid-run.
   */
  track?: LearnerTrackId;
  frameSize?: number;
  maxPayloadBytes?: number;
  /** Deadline for the `ledger_append` reverse RPC. */
  ledgerDeadlineMs?: number;
  /** Operator label (compose service name). Never Baby-visible. */
  hostLabel?: string;
  /** Seam for tests: build the adapter factory without `@ald/learners`. */
  createFactory?: (
    track: LearnerTrackId,
    options: Record<string, unknown>,
  ) => LearnerAdapterFactory;
  /** Called after a `shutdown` request has been answered. */
  onShutdown?: () => void;
}

/** Container id when this host can tell it is in one, else `undefined`. */
export function detectContainerId(assumeContainer = false): string | undefined {
  const declared = process.env.ALD_CONTAINER_ID;
  if (declared !== undefined && declared.length > 0) {
    return declared;
  }
  if (assumeContainer) {
    const name = hostname();
    return name.length > 0 ? name : undefined;
  }
  try {
    // Docker's default hostname is the short container id. Reading
    // `/.dockerenv` is refused under the permission model, which is itself
    // the answer: a process host reports no container id at all.
    readFileSync('/.dockerenv');
  } catch {
    return undefined;
  }
  const name = hostname();
  return name.length > 0 ? name : undefined;
}

/**
 * One hosted adapter behind the {@link FrameConnection}.
 *
 * Method dispatch validates parameters against `HOST_PARAM_SCHEMAS` *before*
 * the adapter is touched, so a malformed or over-wide request never reaches
 * learner code.
 */
export class LearnerHost {
  readonly connection: FrameConnection;

  private readonly options: LearnerHostOptions;
  private adapter: LearnerAdapter | undefined;
  private ledger: PrivateLedgerClient | undefined;

  constructor(options: LearnerHostOptions) {
    this.options = options;
    this.connection = new FrameConnection({
      channel: options.channel,
      originator: 'h',
      frameSize: options.frameSize ?? DEFAULT_FRAME_SIZE,
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
      handler: (method, params) => this.dispatch(method, params),
      errorCodeFor: (error) => wireCodeFor(error),
    });
  }

  async close(): Promise<void> {
    this.connection.close();
    return Promise.resolve();
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!HOST_METHOD_SET.has(method)) {
      throw new HostProtocolError('unknown-method');
    }
    const name = method as HostMethod;
    const parsed = HOST_PARAM_SCHEMAS[name].safeParse(params ?? {});
    if (!parsed.success) {
      throw new HostProtocolError('invalid-params');
    }

    switch (name) {
      case 'init':
        return this.handleInit(parsed.data as InitParams);
      case 'observe': {
        const adapter = this.requireAdapter();
        await adapter.observe(parsed.data as Parameters<LearnerAdapter['observe']>[0]);
        return { policyDigest: this.policyDigest() };
      }
      case 'act': {
        const adapter = this.requireAdapter();
        const envelope = await adapter.act(
          parsed.data as Parameters<LearnerAdapter['act']>[0],
        );
        return { envelope, policyDigest: this.policyDigest() };
      }
      case 'receive': {
        const adapter = this.requireAdapter();
        const envelope = await adapter.receive(
          parsed.data as Parameters<LearnerAdapter['receive']>[0],
        );
        return { envelope, policyDigest: this.policyDigest() };
      }
      case 'on_outcome': {
        const adapter = this.requireAdapter();
        await adapter.onOutcome(
          outcomeFromWire(parsed.data as Record<string, unknown>),
        );
        return { policyDigest: this.policyDigest() };
      }
      case 'update_policy': {
        const adapter = this.requireAdapter();
        if (adapter.updatePolicy === undefined) {
          throw new HostProtocolError('unsupported-method');
        }
        const checkpoint = await adapter.updatePolicy(
          parsed.data as Parameters<NonNullable<LearnerAdapter['updatePolicy']>>[0],
        );
        return { checkpoint, policyDigest: this.policyDigest() };
      }
      case 'measure_affect': {
        const adapter = this.requireAdapter();
        if (adapter.measureAffect === undefined) {
          throw new HostProtocolError('unsupported-method');
        }
        const measurement = await adapter.measureAffect();
        return { measurement, policyDigest: this.policyDigest() };
      }
      case 'apply_curriculum_stage': {
        const adapter = this.requireAdapter();
        if (adapter.applyCurriculumStage === undefined) {
          throw new HostProtocolError('unsupported-method');
        }
        const { stage } = parsed.data as {
          stage: Parameters<NonNullable<LearnerAdapter['applyCurriculumStage']>>[0];
        };
        await adapter.applyCurriculumStage(stage);
        return { policyDigest: this.policyDigest() };
      }
      case 'describe_provenance': {
        const adapter = this.requireAdapter();
        if (adapter.describeProvenance === undefined) {
          throw new HostProtocolError('unsupported-method');
        }
        return { provenance: adapter.describeProvenance() };
      }
      case 'export_policy': {
        const adapter = this.requireAdapter();
        const policy = adapter.exportPolicy();
        return { policy, policyDigest: policyDigestOf(policy) };
      }
      case 'describe_isolation':
        return this.describeIsolation();
      case 'isolation_probe':
        return isolationProbe(
          parsed.data as {
            readPath?: string;
            connect?: { host: string; port: number; timeoutMs: number };
          },
        );
      case 'shutdown':
        setImmediate(() => {
          this.options.onShutdown?.();
        });
        return {};
      default: {
        const exhaustive: never = name;
        throw new HostProtocolError(exhaustive);
      }
    }
  }

  private async handleInit(params: InitParams): Promise<unknown> {
    if (this.adapter !== undefined) {
      throw new HostProtocolError('already-initialized');
    }
    if (this.options.track !== undefined && this.options.track !== params.track) {
      throw new HostProtocolError('invalid-params');
    }

    const build =
      this.options.createFactory ??
      ((track: LearnerTrackId, options: Record<string, unknown>) =>
        createLearnerAdapterFactory(track, options));
    const factory = build(params.track, params.learnerOptions ?? {});
    const adapter = factory.create();
    const ledger = new HostLedgerClient(
      this.connection,
      this.options.ledgerDeadlineMs ?? 30_000,
    );

    const context: LearnerInitContext = {
      runId: params.runId,
      role: params.role,
      babyId: params.babyId,
      config: params.config as LearnerVisibleRunConfig,
      learnerContract: params.learnerContract as LearnerContract,
      seed: params.seed,
      symbolInventory: params.symbolInventory,
      ledger,
      ...(params.initialPolicy === undefined
        ? {}
        : { initialPolicy: params.initialPolicy }),
    };
    await adapter.init(context);
    this.adapter = adapter;
    this.ledger = ledger;

    const capabilities: HostCapability[] = HOST_CAPABILITIES.filter(
      (capability) => adapter[capability] !== undefined,
    );
    let provenance: LearnerProvenance | undefined;
    if (adapter.describeProvenance !== undefined) {
      provenance = adapter.describeProvenance();
    }
    return {
      capabilities,
      isolation: this.describeIsolation(),
      policyDigest: this.policyDigest(),
      protocolVersion: 1,
      ...(provenance === undefined ? {} : { provenance }),
    };
  }

  private describeIsolation(): Record<string, unknown> {
    const boundary = this.options.boundary ?? 'separate-process';
    const containerId = detectContainerId(boundary === 'separate-container');
    return {
      boundary,
      processId: process.pid,
      ...(containerId === undefined ? {} : { containerId }),
      ...(this.options.hostLabel === undefined
        ? {}
        : { hostLabel: this.options.hostLabel }),
    };
  }

  private requireAdapter(): LearnerAdapter {
    if (this.adapter === undefined || this.ledger === undefined) {
      throw new HostProtocolError('not-initialized');
    }
    return this.adapter;
  }

  private policyDigest(): Sha256Hash {
    return policyDigestOf(this.requireAdapter().exportPolicy());
  }
}

/** `PrivateLedgerClient` implemented as the one reverse RPC (SPEC §6.3). */
class HostLedgerClient implements PrivateLedgerClient {
  constructor(
    private readonly connection: FrameConnection,
    private readonly deadlineMs: number,
  ) {}

  async append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent> {
    const result = await this.connection.request(
      'ledger_append',
      {
        draft,
        ...(options?.channelEventHash === undefined
          ? {}
          : { channelEventHash: options.channelEventHash }),
      },
      this.deadlineMs,
    );
    return LedgerAppendResultSchema.parse(result).event;
  }
}

export function policyDigestOf(policy: unknown): Sha256Hash {
  return hashCanonical(HASH_DOMAINS.policyCheckpoint, policy);
}

/**
 * Rebuild the `OutcomeEvent` the runtime described.
 *
 * `rewardWithheld` reinstalls a *throwing* accessor rather than a value, so a
 * reward-free track that peeks at `reward` fails inside the hosted adapter
 * exactly as it does in-process (SPEC §6.1, §11.1 `learningSignal`).
 */
export function outcomeFromWire(wire: Record<string, unknown>): OutcomeEvent {
  const { rewardWithheld, ...rest } = wire;
  const outcome = { ...rest } as Record<string, unknown>;
  if (rewardWithheld === true) {
    delete outcome.reward;
    Object.defineProperty(outcome, 'reward', {
      enumerable: true,
      configurable: true,
      get(): never {
        throw new Error(WITHHELD_REWARD_MESSAGE);
      },
    });
  } else if (outcome.reward === undefined) {
    outcome.reward = null;
  }
  return outcome as unknown as OutcomeEvent;
}

function wireCodeFor(error: unknown): HostErrorCode {
  return isHostProtocolError(error) ? error.code : 'adapter-error';
}

interface IsolationProbeRequest {
  readPath?: string;
  connect?: { host: string; port: number; timeoutMs: number };
}

/**
 * Attempt each access SPEC §10.3 claims a Baby process does not have, and
 * report only an outcome code per attempt.
 *
 * This is the inside-the-Baby half of E01's "attempt filesystem, clipboard,
 * environment, and process access" categories. It returns no file content, no
 * error message, and no path.
 */
export async function isolationProbe(
  request: IsolationProbeRequest = {},
): Promise<Record<string, unknown>> {
  const permissionModel = hasPermissionModel();
  return {
    permissionModel,
    fsRead: probeFsRead(request.readPath),
    childProcess: await probeChildProcess(),
    worker: await probeWorker(),
    network: await probeNetwork(request.connect),
    envKeys: Object.keys(process.env).sort(),
    argvCount: process.argv.length,
    processId: process.pid,
  };
}

function hasPermissionModel(): boolean {
  const permission = (
    process as unknown as { permission?: { has?: (scope: string) => boolean } }
  ).permission;
  if (permission?.has === undefined) {
    return false;
  }
  // `fs.read` is granted only for the module graph, so the unrestricted
  // capability is absent whenever the model is on.
  return permission.has('fs.write') === false;
}

function classify(error: unknown): ProbeOutcome {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'ERR_ACCESS_DENIED' ? 'denied' : 'refused';
}

function probeFsRead(path: string | undefined): ProbeOutcome {
  if (path === undefined) {
    return 'skipped';
  }
  try {
    readFileSync(path);
    return 'allowed';
  } catch (error) {
    return classify(error);
  }
}

async function probeChildProcess(): Promise<ProbeOutcome> {
  try {
    const childProcess = await import('node:child_process');
    const result = childProcess.spawnSync(process.execPath, ['--version']);
    if (result.error !== undefined) {
      return classify(result.error);
    }
    return result.status === null ? 'refused' : 'allowed';
  } catch (error) {
    return classify(error);
  }
}

async function probeWorker(): Promise<ProbeOutcome> {
  try {
    const workers = await import('node:worker_threads');
    const worker = new workers.Worker(new URL('data:text/javascript,'));
    await worker.terminate();
    return 'allowed';
  } catch (error) {
    return classify(error);
  }
}

async function probeNetwork(
  target: { host: string; port: number; timeoutMs: number } | undefined,
): Promise<ProbeOutcome> {
  if (target === undefined) {
    return 'skipped';
  }
  try {
    const net = await import('node:net');
    return await new Promise<ProbeOutcome>((resolve) => {
      const socket = new net.Socket();
      const finish = (outcome: ProbeOutcome): void => {
        socket.destroy();
        resolve(outcome);
      };
      socket.setTimeout(target.timeoutMs, () => {
        finish('refused');
      });
      socket.once('error', (error: unknown) => {
        finish(classify(error));
      });
      socket.connect(target.port, target.host, () => {
        finish('allowed');
      });
    });
  } catch (error) {
    return classify(error);
  }
}

/** Frame channel over this process's own stdio (the process transport). */
export class StdioFrameChannel implements FrameChannel {
  readonly kind = 'process' as const;

  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => {
      this.lineHandler?.(chunk);
    });
    this.input.on('end', () => {
      this.settle();
    });
    this.input.on('error', () => {
      this.settle();
    });
  }

  get processId(): number {
    return process.pid;
  }

  write(lines: readonly string[]): void {
    for (const line of lines) {
      this.output.write(line);
    }
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) {
      handler();
    }
  }

  close(): void {
    this.settle();
  }

  private settle(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.();
  }
}

export interface HostCliOptions {
  transport: 'process' | 'tcp';
  port?: number;
  bindHost?: string;
  track?: LearnerTrackId;
  frameSize?: number;
  hostLabel?: string;
  maxConnections?: number;
}

/** Parse the host's own argv. Unknown flags are a configuration failure. */
export function parseHostCliOptions(argv: readonly string[]): HostCliOptions {
  const options: HostCliOptions = { transport: 'process' };
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
      case '--max-connections':
        options.maxConnections = Number(rawValue);
        break;
      default:
        throw new Error(`unknown learner-host flag: ${flag}`);
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

/**
 * Entry point used by `bin/ald-learner-host.js`.
 *
 * The process transport exits when its stdin closes: when the runtime goes
 * away, so does the Baby.
 */
export async function runLearnerHostCli(argv: readonly string[]): Promise<void> {
  const options = parseHostCliOptions(argv);
  const shared = {
    ...(options.track === undefined ? {} : { track: options.track }),
    ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
    ...(options.hostLabel === undefined ? {} : { hostLabel: options.hostLabel }),
  };

  if (options.transport === 'process') {
    const channel = new StdioFrameChannel();
    const host = new LearnerHost({
      ...shared,
      channel,
      boundary: 'separate-process',
      onShutdown: () => {
        void host.close();
        process.exit(0);
      },
    });
    channel.onClose(() => {
      process.exit(0);
    });
    await new Promise<void>(() => {
      // Runs until stdin closes or `shutdown` arrives.
    });
    return;
  }

  if (options.port === undefined || !Number.isInteger(options.port)) {
    throw new Error('--port is required for --transport=tcp');
  }
  const hosts = new Set<LearnerHost>();
  const server = await createTcpFrameServer({
    port: options.port,
    ...(options.bindHost === undefined ? {} : { host: options.bindHost }),
    ...(options.maxConnections === undefined
      ? {}
      : { maxConnections: options.maxConnections }),
    onChannel: (channel) => {
      const host = new LearnerHost({
        ...shared,
        channel,
        boundary: 'separate-container',
        onShutdown: () => {
          void host.close();
          hosts.delete(host);
        },
      });
      hosts.add(host);
      channel.onClose(() => {
        hosts.delete(host);
      });
    },
  });
  const stop = (): void => {
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>(() => {
    // Runs until the container is stopped.
  });
}
