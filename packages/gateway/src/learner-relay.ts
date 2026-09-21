/**
 * Run- and role-bound Gateway relay between the Controller and one Baby.
 *
 * The Controller may drive the ordinary learner-host protocol, but it never
 * receives the Baby's reverse `ledger_append` request. That capability ends
 * here, inside the Gateway trust zone, where the relay supplies the fixed run,
 * Baby identity, and active turn to the narrow Gateway Evidence Writer port.
 * The downstream channel is supplied at construction, so no wire request can
 * select another Baby or destination.
 */
import { z } from 'zod';

import {
  FrameConnection,
  HOST_METHODS,
  HOST_PARAM_SCHEMAS,
  HostProtocolError,
  IsolationError,
  LedgerAppendParamsSchema,
  CheckpointResultSchema,
  EnvelopeResultSchema,
  ExportPolicyResultSchema,
  InitResultSchema,
  IsolationDescriptorSchema,
  IsolationProbeResultSchema,
  MeasureAffectResultSchema,
  PolicyStateResultSchema,
  ProvenanceResultSchema,
  LedgerAppendResultSchema,
  type FrameChannel,
  type HostErrorCode,
  type HostMethod,
  type InitParams,
} from '@ald/isolation';
import type { BabyId, BabyRole } from '@ald/types';

import type { GatewayEvidencePort } from './evidence-port.js';

const HOST_METHOD_SET: ReadonlySet<string> = new Set(HOST_METHODS);
const EmptyResultSchema = z.strictObject({});

const RESULT_SCHEMAS = {
  init: InitResultSchema,
  observe: PolicyStateResultSchema,
  act: EnvelopeResultSchema,
  preview_act: EnvelopeResultSchema,
  receive: EnvelopeResultSchema,
  on_outcome: PolicyStateResultSchema,
  update_policy: CheckpointResultSchema,
  measure_affect: MeasureAffectResultSchema,
  apply_curriculum_stage: PolicyStateResultSchema,
  describe_provenance: ProvenanceResultSchema,
  export_policy: ExportPolicyResultSchema,
  describe_isolation: IsolationDescriptorSchema,
  isolation_probe: IsolationProbeResultSchema,
  shutdown: EmptyResultSchema,
} as const satisfies Record<HostMethod, z.ZodType>;

export interface GatewayLearnerRelayOptions {
  controllerChannel: FrameChannel;
  babyChannel: FrameChannel;
  writer: Pick<GatewayEvidencePort, 'appendLedgerEvent'>;
  runId: string;
  role: BabyRole;
  babyId: BabyId;
  /** Bounded non-turn/downstream call deadline. No call is retried. */
  deadlineMs?: number;
  frameSize?: number;
  maxPayloadBytes?: number;
}

export interface GatewayLearnerRelayDiagnostics {
  forwardedCalls: number;
  ledgerAppends: number;
  rejectedRequests: number;
  quarantined: boolean;
  lastMethod: HostMethod | null;
  currentTurn: number;
}

/**
 * Strict one-request-at-a-time relay. A channel close, deadline, malformed
 * downstream result, or uncertain writer call makes both boundaries terminal.
 */
export class GatewayLearnerRelay {
  readonly diagnostics: GatewayLearnerRelayDiagnostics = {
    forwardedCalls: 0,
    ledgerAppends: 0,
    rejectedRequests: 0,
    quarantined: false,
    lastMethod: null,
    currentTurn: 0,
  };

  private readonly options: GatewayLearnerRelayOptions;
  private readonly controller: FrameConnection;
  private readonly baby: FrameConnection;
  private initialized = false;
  private active: { method: HostMethod; turn: number } | undefined;
  private closed = false;
  private lastWriterFailure: unknown;

  constructor(options: GatewayLearnerRelayOptions) {
    if (options.runId.length === 0 ||
        (options.deadlineMs !== undefined &&
          (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0)) ||
        (options.role === 'baby-a') !== (options.babyId === 'A')) {
      throw new IsolationError('configuration');
    }
    this.options = options;
    const shared = {
      ...(options.frameSize === undefined ? {} : { frameSize: options.frameSize }),
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
    };
    this.controller = new FrameConnection({
      channel: options.controllerChannel,
      originator: 'h',
      ...shared,
      handler: (method, params) => this.forward(method, params),
      errorCodeFor: relayWireCodeFor,
      onClosed: (error) => this.boundaryClosed(error),
    });
    this.baby = new FrameConnection({
      channel: options.babyChannel,
      originator: 'r',
      ...shared,
      handler: (method, params) => this.handleBabyRequest(method, params),
      errorCodeFor: relayWireCodeFor,
      onClosed: (error) => this.boundaryClosed(error),
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get writerFailure(): unknown {
    return this.lastWriterFailure;
  }

  /** Operator teardown. This is a clean close, not a failed qualification. */
  close(): void {
    this.closeBoth(false);
  }

  private async forward(method: string, params: unknown): Promise<unknown> {
    if (!HOST_METHOD_SET.has(method)) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('unknown-method');
    }
    const name = method as HostMethod;
    const parsed = HOST_PARAM_SCHEMAS[name].safeParse(params ?? {});
    if (!parsed.success) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('invalid-params');
    }
    if (this.active !== undefined) {
      this.diagnostics.rejectedRequests += 1;
      this.scheduleQuarantine();
      throw new HostProtocolError('internal');
    }
    if (name === 'init') {
      if (this.initialized) throw new HostProtocolError('already-initialized');
      this.assertInitIdentity(parsed.data as InitParams);
    } else if (!this.initialized) {
      throw new HostProtocolError('not-initialized');
    } else {
      this.assertRequestIdentity(name, parsed.data);
    }

    const turn = turnFor(name, parsed.data, this.diagnostics.currentTurn);
    this.active = { method: name, turn };
    this.diagnostics.lastMethod = name;
    try {
      const raw = await this.baby.request(
        name,
        parsed.data,
        this.options.deadlineMs,
      );
      const result = RESULT_SCHEMAS[name].safeParse(raw);
      if (!result.success) {
        const error = new IsolationError('protocol-violation', {
          method: name,
          cause: result.error,
        });
        this.closeBoth(true, error);
        throw error;
      }
      this.diagnostics.forwardedCalls += 1;
      this.diagnostics.currentTurn = turn;
      if (name === 'init') this.initialized = true;
      if (name === 'shutdown') setImmediate(() => this.close());
      return result.data;
    } catch (error) {
      if (mustQuarantine(error)) this.closeBoth(true, isolationCause(error, name));
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  private async handleBabyRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'ledger_append') {
      this.diagnostics.rejectedRequests += 1;
      this.scheduleQuarantine();
      throw new HostProtocolError('unknown-method');
    }
    const parsed = LedgerAppendParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.diagnostics.rejectedRequests += 1;
      this.scheduleQuarantine();
      throw new HostProtocolError('invalid-params');
    }
    const active = this.active;
    if (active === undefined) {
      this.diagnostics.rejectedRequests += 1;
      this.scheduleQuarantine();
      throw new HostProtocolError('internal');
    }
    try {
      const event = await this.options.writer.appendLedgerEvent({
        runId: this.options.runId,
        babyId: this.options.babyId,
        turn: active.turn,
        draft: parsed.data.draft,
        ...(parsed.data.channelEventHash === undefined
          ? {}
          : { channelEventHash: parsed.data.channelEventHash }),
      });
      const result = LedgerAppendResultSchema.parse({ event });
      if (result.event.runId !== this.options.runId ||
          result.event.babyId !== this.options.babyId ||
          result.event.turn !== active.turn ||
          result.event.channelEventHash !== parsed.data.channelEventHash) {
        throw new IsolationError('protocol-violation', {
          method: 'ledger_append',
        });
      }
      this.diagnostics.ledgerAppends += 1;
      return result;
    } catch (error) {
      // The write may have committed. Give the Baby one constant-shape error,
      // then make both channels terminal before another call can start.
      this.lastWriterFailure = error;
      this.scheduleQuarantine();
      throw error;
    }
  }

  private assertInitIdentity(params: InitParams): void {
    if (params.runId !== this.options.runId ||
        params.config.runId !== this.options.runId ||
        params.role !== this.options.role || params.babyId !== this.options.babyId) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('invalid-params');
    }
  }

  private assertRequestIdentity(method: HostMethod, params: unknown): void {
    const value = params as Record<string, unknown>;
    if ('runId' in value && value['runId'] !== this.options.runId) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('invalid-params');
    }
    if (method === 'observe' && value['recipient'] !== this.options.role) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('invalid-params');
    }
    if (method === 'preview_act') {
      const observation = value['observation'] as Record<string, unknown> | undefined;
      if (observation?.['recipient'] !== this.options.role) {
        this.diagnostics.rejectedRequests += 1;
        throw new HostProtocolError('invalid-params');
      }
    }
    if (method === 'receive' && value['logicalSender'] === this.options.role) {
      this.diagnostics.rejectedRequests += 1;
      throw new HostProtocolError('invalid-params');
    }
  }

  private scheduleQuarantine(): void {
    // The first turn lets FrameConnection encode and write the constant-shape
    // error response. The second makes the boundary terminal before any later
    // Controller call can be admitted.
    setImmediate(() => setImmediate(() => this.closeBoth(true)));
  }

  private boundaryClosed(error: IsolationError): void {
    if (!this.closed) this.closeBoth(true, error);
  }

  private closeBoth(
    quarantined: boolean,
    reason = new IsolationError('host-unavailable'),
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.diagnostics.quarantined = quarantined;
    this.controller.close(reason);
    this.baby.close(reason);
  }
}

function turnFor(method: HostMethod, params: unknown, current: number): number {
  const value = params as Record<string, unknown>;
  if (typeof value['turn'] === 'number') return value['turn'];
  if (method === 'update_policy' && Array.isArray(value['turns'])) {
    const turns = value['turns'].filter((turn): turn is number => typeof turn === 'number');
    return turns.length === 0 ? current : Math.max(...turns);
  }
  if (method === 'apply_curriculum_stage') {
    const stage = value['stage'] as { startTurn?: unknown };
    if (typeof stage.startTurn === 'number') return stage.startTurn;
  }
  return current;
}

function relayWireCodeFor(error: unknown): HostErrorCode {
  if (error instanceof HostProtocolError) return error.code;
  if (error instanceof IsolationError && error.code === 'host-error' &&
      error.hostCode !== undefined) {
    return error.hostCode;
  }
  return 'internal';
}

function mustQuarantine(error: unknown): boolean {
  return error instanceof IsolationError && error.code !== 'host-error';
}

function isolationCause(error: unknown, method: HostMethod): IsolationError {
  return error instanceof IsolationError
    ? error
    : new IsolationError('protocol-violation', { method, cause: error });
}
