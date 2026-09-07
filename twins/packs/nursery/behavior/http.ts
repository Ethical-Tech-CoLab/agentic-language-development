/**
 * Shared DTSF route infrastructure for the `nursery`, `baby-a`, and `baby-b`
 * twin packs (SPECIFICATION.md §12.1-§12.3; BACKLOG ALD-049, ALD-051,
 * ALD-052).
 *
 * A twin's Express route is `/:twinName/*` and the DTSF runtime strips the
 * twin name before dispatch (§12.1), so every route pattern here is
 * unprefixed (e.g. `/runs/:id/step`, never `/nursery/runs/:id/step`).
 *
 * `baby-a` and `baby-b` import this module by relative path
 * (`../../nursery/behavior/http.js`) rather than duplicating it, and list
 * `twins/packs/nursery` in their `tsconfig.json` `references` so
 * `tsc --build` can order the compilation. Both baby packs' project files
 * live under their own `rootDir`, so this remains a source-level import of a
 * sibling composite project's public surface, not a runtime dependency on
 * the nursery pack itself — no code here reaches into `NurseryPack`.
 */
import type {
  AgentActionProposal,
  BehaviorPackContext,
  BehaviorPackResult,
  OutcomeEvent,
  TurnBudget,
  TwinRequest,
  TwinResponse,
} from '@ald/types';
import { isGatewayError, toGatewayError } from '@ald/gateway';
import { NurseryRuntimeError, type RuntimeErrorCode } from '@ald/orchestrator';

// ---------------------------------------------------------------------------
// Authorization roles (SPEC §12.2)
// ---------------------------------------------------------------------------

export const ROLES = [
  'internal-gateway',
  'internal-controller',
  'internal-evidence-writer',
  'internal-audit-interpreter',
  'researcher-viewer',
  'researcher-operator',
  'verifier-service',
] as const;

export type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Per-run/per-process service tokens, keyed by role. Supplied by a caller
 * through `BehaviorPackContext.state.get('serviceTokens')`. Mode P only: a
 * research-grade (Mode R) deployment authenticates over its own network
 * boundary, not this header pair (SPEC §5.2).
 */
export type ServiceTokens = Partial<Record<Role, string>>;

const SERVICE_TOKENS_STATE_KEY = 'serviceTokens';

/**
 * Mode P development default: role `r` accepts token `dev-r` when no
 * `serviceTokens` override names that role. This is a prototype-mode
 * convenience only and MUST NOT be relied on outside local development or
 * tests (SPEC §5.1).
 */
export function devToken(role: Role): string {
  return `dev-${role}`;
}

function expectedToken(role: Role, context: BehaviorPackContext): string {
  const tokens = context.state.get(SERVICE_TOKENS_STATE_KEY) as
    | ServiceTokens
    | undefined;
  return tokens?.[role] ?? devToken(role);
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      return headers[key];
    }
  }
  return undefined;
}

/**
 * `researcher-operator` may do everything `researcher-viewer` may
 * (SPEC §12.2 table); every other role is exact-match only.
 */
export function roleSatisfies(actual: Role, required: readonly Role[]): boolean {
  if (required.includes(actual)) {
    return true;
  }
  return actual === 'researcher-operator' && required.includes('researcher-viewer');
}

interface AuthFailure {
  ok: false;
  status: 401 | 403;
  code: 'UNAUTHENTICATED' | 'FORBIDDEN';
  message: string;
}

interface AuthSuccess {
  ok: true;
  role: Role;
}

/**
 * SPEC §12.2/§12.3: validates the `x-ald-role` / `x-ald-service-token`
 * header pair. Missing or unrecognized headers, or a token that does not
 * match the resolved expectation for the declared role, are
 * `401 UNAUTHENTICATED` — a role mismatch (valid credential, wrong role for
 * this route) is the caller's job to check separately via
 * {@link roleSatisfies} and report as `403 FORBIDDEN`.
 */
export function authenticate(
  request: TwinRequest,
  context: BehaviorPackContext,
): AuthFailure | AuthSuccess {
  const roleHeader = headerValue(request.headers, 'x-ald-role');
  const token = headerValue(request.headers, 'x-ald-service-token');
  if (roleHeader === undefined || !isRole(roleHeader)) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Missing or unrecognized x-ald-role header',
    };
  }
  if (token === undefined || token !== expectedToken(roleHeader, context)) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Missing or invalid x-ald-service-token header',
    };
  }
  return { ok: true, role: roleHeader };
}

/** The actor id recorded on audited interventions and human-view reads (SPEC §14.2). */
export function actorIdFor(request: TwinRequest, role: Role): string {
  return headerValue(request.headers, 'x-ald-actor') ?? role;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link matchPath} when a `:param` segment is not validly
 * percent-encoded (SPEC §12.3). `createRouter`'s route loop catches this
 * specifically, before authentication, and maps it to `400 INVALID_REQUEST`
 * rather than letting `decodeURIComponent`'s `URIError` escape the router as
 * a rejected promise — the §12.3 code/status set has no server-fault member.
 */
export class MalformedPathError extends Error {
  constructor(readonly segment: string) {
    super(`Path segment "${segment}" is not validly percent-encoded`);
    this.name = 'MalformedPathError';
  }
}

/** Matches a `/runs/:id/step`-style pattern against a request path. */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter((part) => part.length > 0);
  const pathParts = path.split('/').filter((part) => part.length > 0);
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index] ?? '';
    const pathPart = pathParts[index] ?? '';
    if (patternPart.startsWith(':')) {
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      } catch {
        throw new MalformedPathError(pathPart);
      }
    } else if (patternPart !== pathPart) {
      return undefined;
    }
  }
  return params;
}

export interface RouteHandlerArgs {
  request: TwinRequest;
  params: Record<string, string>;
  body: unknown;
  role: Role;
  actorId: string;
  context: BehaviorPackContext;
}

export type RouteHandler = (
  args: RouteHandlerArgs,
) => Promise<BehaviorPackResult> | BehaviorPackResult;

export interface RouteDefinition {
  method: string;
  pattern: string;
  /** Roles permitted to call this route (SPEC §12.2); expanded by {@link roleSatisfies}. */
  roles: readonly Role[];
  handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// Response envelope (SPEC §12.3)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export function success(
  data: Record<string, unknown> = {},
  status = 200,
): BehaviorPackResult {
  const response: TwinResponse = {
    status,
    headers: { ...JSON_HEADERS },
    body: { ok: true, ...data },
  };
  return { response, mutations: [] };
}

/**
 * SPEC §12.3's closed error-code union. `NOT_IMPLEMENTED`/501 deliberately
 * has no member here: the spec's status list is 200/201/400/401/403/404/409/
 * 422 only, so a route with no operative implementation answers in-envelope
 * (typically `409 CONFLICT`) rather than a code a conformant client is not
 * required to recognize.
 */
export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'DUPLICATE_ID'
  | 'CHANNEL_REJECTED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONFLICT';

const STATUS_FOR_ERROR_CODE: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  DUPLICATE_ID: 409,
  CHANNEL_REJECTED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
};

export function failure(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
  status: number = STATUS_FOR_ERROR_CODE[code],
): BehaviorPackResult {
  const response: TwinResponse = {
    status,
    headers: { ...JSON_HEADERS },
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
  return { response, mutations: [] };
}

/** Thrown by the small body validators below; mapped to `400 INVALID_REQUEST`. */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Narrows an already-parsed body to a plain JSON object. */
export function asRecord(
  value: unknown,
  label = 'request body',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** A required, non-empty string field. */
export function requireString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestError(
      `"${field}" is required and must be a non-empty string`,
    );
  }
  return value;
}

/** A required field of any non-`undefined` shape (schema validation happens downstream). */
export function requireField(
  record: Record<string, unknown>,
  field: string,
): unknown {
  const value = record[field];
  if (value === undefined) {
    throw new InvalidRequestError(`"${field}" is required`);
  }
  return value;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Baby twin `/act` body validation (SPEC §12.4). `TurnBudget` has no `zod`
 * schema in `@ald/types` (it is a runtime contract, not a wire event), so
 * this is a plain shape check shared by `baby-a`/`baby-b`.
 */
export function parseTurnBudget(value: unknown): TurnBudget {
  const record = asRecord(value, 'turnBudget');
  const { turn, role, responseBudgetMs, availableActions, candidateRefs } = record;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    throw new InvalidRequestError(
      '"turnBudget.turn" must be a non-negative integer',
    );
  }
  if (role !== 'sender' && role !== 'receiver') {
    throw new InvalidRequestError(
      '"turnBudget.role" must be "sender" or "receiver"',
    );
  }
  if (typeof responseBudgetMs !== 'number' || responseBudgetMs <= 0) {
    throw new InvalidRequestError(
      '"turnBudget.responseBudgetMs" must be a positive number',
    );
  }
  if (!stringArray(availableActions)) {
    throw new InvalidRequestError(
      '"turnBudget.availableActions" must be an array of strings',
    );
  }
  if (candidateRefs !== undefined && !stringArray(candidateRefs)) {
    throw new InvalidRequestError(
      '"turnBudget.candidateRefs" must be an array of strings when present',
    );
  }
  return {
    turn,
    role,
    responseBudgetMs,
    availableActions: availableActions as AgentActionProposal['kind'][],
    ...(candidateRefs === undefined ? {} : { candidateRefs }),
  };
}

/**
 * Baby twin `/outcome` body validation (SPEC §12.4). `OutcomeEvent`, like
 * `TurnBudget`, has no `zod` schema of its own.
 */
export function parseOutcomeEvent(value: unknown): OutcomeEvent {
  const record = asRecord(value, 'outcome');
  const { runId, turn, role, success: outcomeSuccess, reward, payload } = record;
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new InvalidRequestError('"outcome.runId" is required');
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    throw new InvalidRequestError(
      '"outcome.turn" must be a non-negative integer',
    );
  }
  if (role !== 'sender' && role !== 'receiver') {
    throw new InvalidRequestError(
      '"outcome.role" must be "sender" or "receiver"',
    );
  }
  if (typeof outcomeSuccess !== 'boolean') {
    throw new InvalidRequestError('"outcome.success" must be a boolean');
  }
  if (reward !== null && typeof reward !== 'number') {
    throw new InvalidRequestError('"outcome.reward" must be a number or null');
  }
  if (
    !Array.isArray(payload) ||
    !payload.every((entry) => typeof entry === 'number')
  ) {
    throw new InvalidRequestError(
      '"outcome.payload" must be an array of numbers',
    );
  }
  return { runId, turn, role, success: outcomeSuccess, reward, payload };
}

/**
 * SPEC §4.2 absence-of-route: a Baby twin route body can never name the
 * *other* Baby as the target of the call. `baby-a`/`baby-b` check every
 * request against this before touching their own adapter.
 */
export function namesOtherBaby(
  body: unknown,
  ownRole: 'baby-a' | 'baby-b',
): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  const other: 'baby-a' | 'baby-b' = ownRole === 'baby-a' ? 'baby-b' : 'baby-a';
  const record = body as Record<string, unknown>;
  return (['role', 'babyId', 'recipient'] as const).some(
    (field) => record[field] === other,
  );
}

/**
 * Parses a request body that may already be a plain object (as constructed
 * in tests) or a raw JSON string (as the DTSF HTTP transport delivers it).
 */
export function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SyntaxError('Request body is not valid JSON');
  }
}

/**
 * Deliberately `Partial`, not exhaustive over {@link RuntimeErrorCode}: a
 * runtime error code this table does not (yet) list falls through to the
 * `409 CONFLICT` default in {@link mapError} rather than failing to compile,
 * since `packages/orchestrator/src/errors.ts` is owned by a concurrently
 * edited file this pack only consumes.
 */
const RUNTIME_ERROR_MAP: Partial<
  Record<RuntimeErrorCode, { status: number; code: ApiErrorCode }>
> = {
  'unknown-run': { status: 404, code: 'NOT_FOUND' },
  'duplicate-run': { status: 409, code: 'CONFLICT' },
  'invalid-configuration': { status: 400, code: 'INVALID_REQUEST' },
  'configuration-mismatch': { status: 409, code: 'CONFLICT' },
  'invalid-run-state': { status: 409, code: 'CONFLICT' },
  'verifier-not-configured': { status: 409, code: 'CONFLICT' },
  'anchor-policy': { status: 400, code: 'INVALID_REQUEST' },
  'unsupported-condition': { status: 400, code: 'INVALID_REQUEST' },
};

function isNodeErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * SPEC §12.3 error mapping, shared by every route's `catch`. Gateway and
 * `NurseryRuntimeError` failures use their own machine-readable codes;
 * everything else falls back to `@ald/gateway`'s generic mapping (which
 * itself covers `ZodError` and tagged Evidence Writer errors), then to
 * `409 CONFLICT` for a truly unclassified fault, per this pack's brief
 * (never a bare 500 — the §12.3 code list has no server-fault member).
 */
export function mapError(error: unknown): BehaviorPackResult {
  if (error instanceof SyntaxError) {
    return failure('INVALID_REQUEST', error.message);
  }
  if (error instanceof InvalidRequestError) {
    return failure('INVALID_REQUEST', error.message, error.details);
  }
  if (error instanceof NurseryRuntimeError) {
    const mapped = RUNTIME_ERROR_MAP[error.code] ?? {
      status: 409,
      code: 'CONFLICT' as const,
    };
    return failure(mapped.code, error.message, undefined, mapped.status);
  }
  if (isNodeErrnoException(error) && error.code === 'ENOENT') {
    return failure('NOT_FOUND', error.message);
  }
  if (isGatewayError(error)) {
    const mapped = toGatewayError(error);
    return failure(
      mapped.error.code as ApiErrorCode,
      mapped.error.message,
      mapped.error.details,
      mapped.status,
    );
  }
  const mapped = toGatewayError(error);
  return failure(
    mapped.error.code as ApiErrorCode,
    mapped.error.message,
    mapped.error.details,
    mapped.status,
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Builds a `BehaviorPack.handleRequest` implementation from a route table:
 * matches method + unprefixed pattern, authenticates the service-token
 * header pair, checks the route's role list, parses the body, and maps any
 * thrown error to the §12.3 envelope. No route in the returned handler ever
 * throws past this boundary.
 */
export function createRouter(
  routes: readonly RouteDefinition[],
): (
  request: TwinRequest,
  context: BehaviorPackContext,
) => Promise<BehaviorPackResult> {
  return async (request, context) => {
    let sawPathMatch = false;
    for (const route of routes) {
      let params: Record<string, string> | undefined;
      try {
        params = matchPath(route.pattern, request.path);
      } catch (error) {
        if (error instanceof MalformedPathError) {
          return failure('INVALID_REQUEST', error.message);
        }
        throw error;
      }
      if (params === undefined) {
        continue;
      }
      sawPathMatch = true;
      if (route.method !== request.method) {
        continue;
      }

      const auth = authenticate(request, context);
      if (!auth.ok) {
        return failure(auth.code, auth.message, undefined, auth.status);
      }
      if (!roleSatisfies(auth.role, route.roles)) {
        return failure(
          'FORBIDDEN',
          `role "${auth.role}" may not call ${route.method} ${route.pattern}`,
        );
      }

      try {
        const body = parseBody(request.body);
        return await route.handler({
          request,
          params,
          body,
          role: auth.role,
          actorId: actorIdFor(request, auth.role),
          context,
        });
      } catch (error) {
        return mapError(error);
      }
    }

    return failure(
      'NOT_FOUND',
      sawPathMatch
        ? `No handler for ${request.method} ${request.path}`
        : `No route matches ${request.path}`,
    );
  };
}
