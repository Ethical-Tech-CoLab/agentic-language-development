/**
 * Gateway error taxonomy and the SPECIFICATION.md §12.3 response mapping.
 *
 * A *rejection* is not an error: `submitProposal` returns a
 * `GatewaySubmitResult` of kind `rejected` because the rejection itself is
 * evidence and must be committed before the caller learns about it. The
 * classes here cover the cases where the caller — the Nursery Controller or a
 * twin route — asked for something the Gateway may not do at all, plus the
 * receiver-side interpretation rejection, which throws *after* its
 * `channel.rejected` event is committed.
 *
 * Every class carries the §12.3 `code` and HTTP status so the twin routes
 * (ALD-048/ALD-052) can render `{ error: { code, message, details? } }`
 * without re-deriving the mapping.
 */
import { ZodError } from 'zod';

import type { ChannelEvent, GatewaySubmitResult, RunConfig } from '@ald/types';

import type { GatewayReasonCode } from './reason-codes.js';

/** The §12.3 error codes the Gateway can produce. */
export type GatewayErrorCode =
  | 'CHANNEL_REJECTED'
  | 'INVALID_REQUEST'
  | 'CONFLICT'
  | 'FORBIDDEN';

/** HTTP statuses paired with {@link GatewayErrorCode} in SPEC §12.3. */
export type GatewayErrorStatus = 400 | 403 | 409 | 422;

export interface GatewayErrorBody {
  code: GatewayErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface GatewayErrorResponse {
  status: GatewayErrorStatus;
  error: GatewayErrorBody;
}

const STATUS_FOR_CODE: Record<GatewayErrorCode, GatewayErrorStatus> = {
  INVALID_REQUEST: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
  CHANNEL_REJECTED: 422,
};

/** Base class for every condition the Gateway refuses outright. */
export class GatewayError extends Error {
  readonly status: GatewayErrorStatus;

  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.status = STATUS_FOR_CODE[code];
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

/**
 * SPEC §9.2 carriers other than `fixed-token` are separate experiment
 * conditions and are only reachable once their protocol module is registered
 * (BACKLOG ALD-031 for the neutral carriers, ALD-033 for the affect channel).
 */
export class UnsupportedCarrierError extends GatewayError {
  constructor(readonly carrier: RunConfig['carrierMode']) {
    super(
      'INVALID_REQUEST',
      `No protocol module is registered for carrier ${carrier}; register one (ALD-031 for neutral carriers, ALD-033 for the affect channel) before constructing a Gateway`,
      { carrier, backlogRefs: ['ALD-031', 'ALD-033'] },
    );
  }
}

/**
 * SPEC §9.6 `shuffled` delivers an artifact from *another* episode of the
 * same evaluation batch, so the caller must supply the batch and this
 * episode's position in it.
 */
export class ShuffledBatchRequiredError extends GatewayError {
  constructor(readonly turn: number) {
    super(
      'INVALID_REQUEST',
      `The shuffled communication condition requires batchArtifacts and a batchIndex inside them (turn ${turn})`,
      { turn, condition: 'shuffled' },
    );
  }
}

/**
 * SPEC §9.6: under `oracle` no learner output is used, so a Baby proposal is
 * never routed. The Nursery Controller calls `submitControlArtifact` with the
 * Scenario Engine's minimal sufficient artifact instead.
 */
export class OracleRequiresControlArtifactError extends GatewayError {
  constructor() {
    super(
      'FORBIDDEN',
      'The oracle communication condition uses no learner output; call submitControlArtifact with the Scenario Engine artifact',
      { condition: 'oracle' },
    );
  }
}

/** Mirror of {@link OracleRequiresControlArtifactError} for the other five conditions. */
export class ControlArtifactNotPermittedError extends GatewayError {
  constructor(readonly condition: RunConfig['communicationCondition']) {
    super(
      'FORBIDDEN',
      `Control artifacts are only accepted under the oracle condition, not ${condition}`,
      { condition },
    );
  }
}

/**
 * A researcher-supplied artifact (pre-registered constant, oracle output, or
 * a batch member for `shuffled`) that the active carrier module rejects. This
 * is a configuration/orchestration fault, not a Baby channel violation, so it
 * is never committed as `channel.rejected`.
 */
export class InvalidControlArtifactError extends GatewayError {
  constructor(
    readonly reasonCode: GatewayReasonCode,
    readonly origin: 'constant' | 'oracle' | 'shuffled-batch',
    detail: string,
  ) {
    super(
      'INVALID_REQUEST',
      `The ${origin} artifact is not valid for the active carrier (${reasonCode}): ${detail}`,
      { reasonCode, origin },
    );
  }
}

/** The declared symbol inventory itself violates SPEC §9.1. */
export class InvalidSymbolInventoryError extends GatewayError {
  constructor(detail: string) {
    super('INVALID_REQUEST', `Invalid symbol inventory: ${detail}`, {});
  }
}

/**
 * SPEC §11.3: the receiver must echo the `channelEventHash` of the delivery
 * addressed to it. The `channel.rejected` event is committed first, so
 * `channelEvent` is always a committed event.
 */
export class InterpretationRejectedError extends GatewayError {
  constructor(
    readonly reasonCode: GatewayReasonCode,
    readonly channelEvent: ChannelEvent,
    readonly rejectedPayloadHash: string,
    readonly consecutiveRejections: number,
    readonly pauseRequested: boolean,
  ) {
    super('CHANNEL_REJECTED', `Interpretation rejected: ${reasonCode}`, {
      reasonCode,
      channelEventHash: channelEvent.entryHash,
      rejectedPayloadHash,
      consecutiveRejections,
      pauseRequested,
    });
  }
}

/**
 * SPEC §8.3: the per-turn response deadline elapsed. The caller commits the
 * forfeited turn with `rejectForTimeout`; the deadline helper only reports
 * that the budget is gone.
 */
export class TurnDeadlineExceededError extends GatewayError {
  readonly reasonCode: GatewayReasonCode = 'timeout';

  constructor(readonly budgetMs: number) {
    super(
      'CHANNEL_REJECTED',
      `Turn response budget of ${budgetMs}ms elapsed`,
      { reasonCode: 'timeout', budgetMs },
    );
  }
}

/** Evidence Writer errors expose a machine-readable `code`; see @ald/evidence. */
const EVIDENCE_CODE_MAP: Record<string, GatewayErrorCode> = {
  'duplicate-run': 'CONFLICT',
  'unknown-run': 'CONFLICT',
  'duplicate-event': 'CONFLICT',
  'fork-detected': 'CONFLICT',
  'interpretation-binding': 'CONFLICT',
  'integrity-blocked': 'CONFLICT',
  'checkpoint-chain': 'CONFLICT',
  'experiment-record-version': 'CONFLICT',
  'invalid-request': 'INVALID_REQUEST',
};

function evidenceErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code in EVIDENCE_CODE_MAP ? code : undefined;
}

/**
 * SPEC §12.3 response mapping used by the twin routes.
 *
 * Unmapped failures (an infrastructure fault, say) are reported as
 * `CONFLICT`/409 with `details.unmapped`, never as a request error: the
 * caller cannot fix them by changing the request, and the §12.3 code list has
 * no server-fault member. A route layer that distinguishes 5xx should test
 * {@link isGatewayError} first and handle the remainder itself.
 */
export function toGatewayError(error: unknown): GatewayErrorResponse {
  if (isGatewayError(error)) {
    return {
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request failed schema validation',
        details: { issues: error.issues.length },
      },
    };
  }

  const evidenceCode = evidenceErrorCode(error);
  if (evidenceCode !== undefined) {
    const code = EVIDENCE_CODE_MAP[evidenceCode] as GatewayErrorCode;
    return {
      status: STATUS_FOR_CODE[code],
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        details: { evidenceCode },
      },
    };
  }

  return {
    status: 409,
    error: {
      code: 'CONFLICT',
      message: 'The Gateway could not complete the request',
      details: { unmapped: true },
    },
  };
}

/**
 * SPEC §12.3 mapping for a committed channel rejection. The body carries the
 * reason code, the payload hash, and the counters only — never the attempted
 * content.
 */
export function toGatewayRejectionResponse(
  result: Extract<GatewaySubmitResult, { kind: 'rejected' }>,
): GatewayErrorResponse {
  return {
    status: 422,
    error: {
      code: 'CHANNEL_REJECTED',
      message: `Proposal rejected: ${result.reasonCode}`,
      details: {
        reasonCode: result.reasonCode,
        rejectedPayloadHash: result.rejectedPayloadHash,
        channelEventHash: result.channelEvent.entryHash,
        consecutiveRejections: result.consecutiveRejections,
        pauseRequested: result.pauseRequested,
      },
    },
  };
}
