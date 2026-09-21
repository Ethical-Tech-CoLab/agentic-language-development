import type { Server } from 'node:net';

import {
  AgentActionProposalSchema,
  AffectDisplayIdSchema,
  AffectEventSchema,
  ChannelEventSchema,
  DeliveredChannelArtifactSchema,
  LedgerEventSchema,
  type AffectSubmitResult,
  type ArtifactProbeApplication,
  type GatewaySubmitResult,
  type GatewayRunContext,
  type ShuffledPrepassResult,
  type SymbolGateway,
  HASH_DOMAINS,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import {
  connectEvidenceRpc,
  createEvidenceRpcServer,
  isRpcRecord,
} from '@ald/evidence';

const PROTOCOL = 'symbol-gateway-v1';
const METHODS = [
  'describe', 'submitProposal', 'beginShuffledBatch',
  'preflightShuffledProposal', 'sealShuffledBatch',
  'submitPreparedShuffledProposal', 'discardShuffledBatchAfterRecovery',
  'rejectForTimeout', 'submitControlArtifact', 'submitInterpretation',
  'submitReceiverTaskAction', 'appendLifecycleLedgerEvent', 'submitAffect',
  'recordDerivedAffect', 'resetRejectionCounter',
] as const;
type Method = (typeof METHODS)[number];

const ARITY: Record<Method, number> = {
  describe: 0,
  submitProposal: 2,
  beginShuffledBatch: 1,
  preflightShuffledProposal: 2,
  sealShuffledBatch: 0,
  submitPreparedShuffledProposal: 1,
  discardShuffledBatchAfterRecovery: 0,
  rejectForTimeout: 2,
  submitControlArtifact: 2,
  submitInterpretation: 3,
  submitReceiverTaskAction: 3,
  appendLifecycleLedgerEvent: 3,
  submitAffect: 2,
  recordDerivedAffect: 2,
  resetRejectionCounter: 0,
};

interface OperationalStatus {
  consecutiveRejections: number;
  evidenceWriteQuarantined: boolean;
}

function status(gateway: SymbolGateway): OperationalStatus {
  return {
    consecutiveRejections: gateway.consecutiveRejections(),
    evidenceWriteQuarantined: gateway.isEvidenceWriteQuarantined(),
  };
}

/** Run-bound Controller endpoint for a separately hosted Symbol Gateway. */
export function createSymbolGatewayRpcServer(
  socketPath: string,
  gateway: SymbolGateway,
): Promise<Server> {
  const runId = gateway.runContext.runId;
  return createEvidenceRpcServer(
    socketPath,
    runId,
    PROTOCOL,
    METHODS,
    (method, args) => METHODS.includes(method as Method) &&
      args.length === ARITY[method as Method],
    async (method, args) => {
      if (method === 'describe') {
        return {
          runId,
          configurationHash: hashCanonical(
            HASH_DOMAINS.runConfig,
            gateway.runContext.config,
          ),
          allowedActionKinds: [...gateway.allowedActionKinds],
          ...status(gateway),
          processId: process.pid,
        };
      }
      const operation = gateway[method as Exclude<Method, 'describe'>];
      if (typeof operation !== 'function') {
        throw new Error(`Gateway method ${method} is unavailable`);
      }
      const value = await (operation as (...values: unknown[]) => unknown)
        .apply(gateway, args);
      return { value: value ?? null, ...status(gateway) };
    },
  );
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function parseStatus(value: unknown): OperationalStatus & { value: unknown } {
  if (!isRpcRecord(value) || !integer(value['consecutiveRejections']) ||
      typeof value['evidenceWriteQuarantined'] !== 'boolean' ||
      !Object.hasOwn(value, 'value')) {
    throw new Error('Gateway RPC status envelope is malformed');
  }
  return {
    value: value['value'],
    consecutiveRejections: value['consecutiveRejections'],
    evidenceWriteQuarantined: value['evidenceWriteQuarantined'],
  };
}

function parseRejected(value: unknown): Extract<GatewaySubmitResult, { kind: 'rejected' }> {
  if (!isRpcRecord(value) || value['kind'] !== 'rejected' ||
      typeof value['reasonCode'] !== 'string' ||
      !sha256(value['rejectedPayloadHash']) ||
      !integer(value['consecutiveRejections']) ||
      typeof value['pauseRequested'] !== 'boolean') {
    throw new Error('Gateway RPC rejection result is malformed');
  }
  return {
    kind: 'rejected',
    channelEvent: ChannelEventSchema.parse(value['channelEvent']),
    reasonCode: value['reasonCode'],
    rejectedPayloadHash: value['rejectedPayloadHash'],
    consecutiveRejections: value['consecutiveRejections'],
    pauseRequested: value['pauseRequested'],
  };
}

function parseSubmit(value: unknown): GatewaySubmitResult {
  if (!isRpcRecord(value)) throw new Error('Gateway RPC submit result is malformed');
  if (value['kind'] === 'rejected') return parseRejected(value);
  if (value['kind'] !== 'accepted' || !sha256(value['babyProposalHash']) ||
      !sha256(value['deliveredArtifactHash'])) {
    throw new Error('Gateway RPC accepted result is malformed');
  }
  const probe = value['probeApplication'];
  let parsedProbe: ArtifactProbeApplication | undefined;
  if (probe !== undefined) {
    const request = isRpcRecord(probe) ? probe['probe'] : undefined;
    if (!isRpcRecord(probe) || !isRpcRecord(request) ||
        typeof request['probeId'] !== 'string' ||
        (request['kind'] !== 'ablation' && request['kind'] !== 'substitution') ||
        !integer(request['position']) || typeof request['hypothesisRef'] !== 'string' ||
        (request['substitute'] !== undefined && typeof request['substitute'] !== 'string') ||
        !sha256(probe['probeHash']) ||
        (probe['status'] !== 'applied' && probe['status'] !== 'skipped') ||
        (probe['reasonCode'] !== undefined && typeof probe['reasonCode'] !== 'string') ||
        (probe['artifactBefore'] !== null && !isRpcRecord(probe['artifactBefore'])) ||
        (probe['artifactAfter'] !== null && !isRpcRecord(probe['artifactAfter'])) ||
        !sha256(probe['artifactHashBefore']) || !sha256(probe['artifactHashAfter'])) {
      throw new Error('Gateway RPC probe result is malformed');
    }
    parsedProbe = probe as unknown as ArtifactProbeApplication;
  }
  return {
    kind: 'accepted',
    channelEvent: ChannelEventSchema.parse(value['channelEvent']),
    senderLedgerEvent: LedgerEventSchema.parse(value['senderLedgerEvent']),
    delivery: value['delivery'] === null
      ? null : DeliveredChannelArtifactSchema.parse(value['delivery']),
    babyProposalHash: value['babyProposalHash'],
    deliveredArtifactHash: value['deliveredArtifactHash'],
    ...(parsedProbe === undefined ? {} : {
      probeApplication: parsedProbe,
    }),
  };
}

function parseAffect(value: unknown): AffectSubmitResult {
  if (!isRpcRecord(value)) throw new Error('Gateway RPC affect result is malformed');
  if (value['kind'] === 'rejected') return parseRejected(value);
  if (value['kind'] !== 'accepted' || typeof value['deliveredDisplayId'] !== 'string') {
    throw new Error('Gateway RPC affect result is malformed');
  }
  return {
    kind: 'accepted',
    affectEvent: AffectEventSchema.parse(value['affectEvent']),
    deliveredDisplayId: AffectDisplayIdSchema.parse(value['deliveredDisplayId']),
  };
}

/** No call is retried; an unconfirmed response permanently quarantines the client. */
export async function connectSymbolGatewayRpc(
  socketPath: string,
  expected: GatewayRunContext,
): Promise<{ gateway: SymbolGateway; processId: number }> {
  const connection = await connectEvidenceRpc(socketPath, expected.runId, PROTOCOL);
  const described = await connection.call('describe', []);
  const expectedHash = hashCanonical(HASH_DOMAINS.runConfig, expected.config);
  if (!isRpcRecord(described) || described['runId'] !== expected.runId ||
      described['configurationHash'] !== expectedHash ||
      !Array.isArray(described['allowedActionKinds']) ||
      !described['allowedActionKinds'].every((kind) =>
        kind === 'emit_symbols' || kind === 'emit_vector' ||
        kind === 'emit_generative' || kind === 'select_object' ||
        kind === 'submit_affect') ||
      !integer(described['consecutiveRejections']) ||
      typeof described['evidenceWriteQuarantined'] !== 'boolean' ||
      described['processId'] !== connection.processId) {
    throw new Error('Gateway RPC description does not match');
  }
  let rejections = described['consecutiveRejections'];
  let quarantined = described['evidenceWriteQuarantined'];
  const call = async (method: Exclude<Method, 'describe'>, args: unknown[]) => {
    try {
      const reply = parseStatus(await connection.call(method, args));
      rejections = reply.consecutiveRejections;
      quarantined ||= reply.evidenceWriteQuarantined;
      return reply.value;
    } catch (error) {
      quarantined = true;
      throw error;
    }
  };
  const gateway: SymbolGateway = {
    runContext: expected,
    allowedActionKinds: [...described['allowedActionKinds']],
    submitProposal: async (turn, envelope) => parseSubmit(
      await call('submitProposal', [turn, envelope])),
    beginShuffledBatch: async (turns) => { await call('beginShuffledBatch', [turns]); },
    preflightShuffledProposal: async (turn, envelope): Promise<ShuffledPrepassResult> => {
      const value = await call('preflightShuffledProposal', [turn, envelope]);
      return isRpcRecord(value) && value['kind'] === 'eligible'
        ? { kind: 'eligible' } : parseRejected(value);
    },
    sealShuffledBatch: async () => { await call('sealShuffledBatch', []); },
    submitPreparedShuffledProposal: async (turn) => parseSubmit(
      await call('submitPreparedShuffledProposal', [turn])),
    discardShuffledBatchAfterRecovery: async () => {
      await call('discardShuffledBatchAfterRecovery', []);
    },
    isEvidenceWriteQuarantined: () => quarantined,
    rejectForTimeout: async (turn, sender) => parseRejected(
      await call('rejectForTimeout', [turn, sender])),
    submitControlArtifact: async (turn, artifact) => {
      const value = await call('submitControlArtifact', [turn, artifact]);
      if (!isRpcRecord(value)) throw new Error('Gateway RPC control result is malformed');
      return {
        channelEvent: ChannelEventSchema.parse(value['channelEvent']),
        delivery: DeliveredChannelArtifactSchema.parse(value['delivery']),
      };
    },
    submitInterpretation: async (turn, recipient, envelope) => LedgerEventSchema.parse(
      await call('submitInterpretation', [turn, recipient, envelope])),
    submitReceiverTaskAction: async (turn, recipient, envelope) => {
      const value = await call('submitReceiverTaskAction', [turn, recipient, envelope]);
      if (value === null) return null;
      const parsed = AgentActionProposalSchema.parse(value);
      if (parsed.kind !== 'select_object') {
        throw new Error('Gateway RPC receiver action result is malformed');
      }
      return parsed;
    },
    appendLifecycleLedgerEvent: async (turn, role, draft) => LedgerEventSchema.parse(
      await call('appendLifecycleLedgerEvent', [turn, role, draft])),
    submitAffect: async (window, proposal) => parseAffect(
      await call('submitAffect', [window, proposal])),
    recordDerivedAffect: async (window, measurement) => parseAffect(
      await call('recordDerivedAffect', [window, measurement])),
    consecutiveRejections: () => rejections,
    resetRejectionCounter: async () => { await call('resetRejectionCounter', []); },
  };
  return { gateway, processId: connection.processId };
}
