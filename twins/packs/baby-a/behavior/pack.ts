/**
 * `baby-a` twin pack (SPECIFICATION.md §12.4; BACKLOG ALD-048).
 *
 * Every route here is reachable only by `internal-gateway` or
 * `internal-controller` except `/ledger`, which is `researcher-viewer`'s
 * audit-layer read (§12.2: "never cross-exposed to a Baby"; this file reads
 * only its own side). There is no route, and no code path, that lets a
 * request address `baby-b`'s adapter (§4.2 absence-of-route): every body is
 * checked with `namesOtherBaby` before this pack's own adapter is touched.
 *
 * This pack does not import anything from `baby-b`; the isolation test in
 * `twins/packs/__tests__/routes.test.ts` asserts that directly against this
 * file's source text.
 */
import {
  DeliveredChannelArtifactSchema,
  type BehaviorPack,
  type BehaviorPackContext,
  type BehaviorPackResult,
  type Observation,
  type RunSummary,
  type StateMutation,
  type TwinEvent,
  type TwinRequest,
} from '@ald/types';
import { getNurseryRuntime } from '@ald/orchestrator';
import { HygieneViolationError, assertObservationHygiene } from '@ald/scenario';
import {
  asRecord,
  createRouter,
  failure,
  namesOtherBaby,
  parseOutcomeEvent,
  parseTurnBudget,
  requireField,
  requireString,
  success,
  type RouteDefinition,
} from '../../nursery/behavior/http.js';

/** This pack's fixed identity; never taken from a request body (SPEC §4.2). */
const OWN_ROLE = 'baby-a' as const;

/** Run states in which a Baby tool route may touch the live adapter (SPEC §7.2). */
const ACTIVE_RUN_STATES: readonly RunSummary['state'][] = ['running', 'evaluating'];

/**
 * SPEC §7.2/§12.4: `/observe`, `/act`, `/deliver`, and `/outcome` mutate this
 * Baby's live `LearnerAdapter` outside `NurseryRuntimeImpl.step`'s own turn
 * transaction, so — unlike `step()` — an accepted call here writes no turn
 * record of its own even though it does append signed agent-native ledger
 * events (§14.5's adapter-crash accounting does not apply to a route that
 * never calls `step()` at all). Gating on run state keeps a paused, sealing,
 * sealed, or aborted run's evidence and learner state from being perturbed
 * out of band; it does not by itself audit an *accepted* call — a Mode R
 * (§5.2) deployment should drive these routes only from its own turn
 * controller, never a human console, and any audit trail for an accepted
 * call is the caller's responsibility, not this gate's.
 */
function requireActiveRun(runId: string): BehaviorPackResult | undefined {
  const runtime = getNurseryRuntime();
  const run = runtime.getRun(runId);
  if (run === undefined) {
    return failure('NOT_FOUND', `run "${runId}" is not loaded`);
  }
  if (!ACTIVE_RUN_STATES.includes(run.state)) {
    return failure(
      'CONFLICT',
      `run "${runId}" is in state "${run.state}"; ${OWN_ROLE}'s tool routes require "running" or "evaluating" (SPEC §7.2)`,
    );
  }
  return undefined;
}

export const BABY_A_ROUTE_PATTERNS = [
  '/observe',
  '/act',
  '/deliver',
  '/outcome',
  '/ledger',
  '/reset',
] as const;

function guardOtherBaby(body: unknown): BehaviorPackResult | undefined {
  if (namesOtherBaby(body, OWN_ROLE)) {
    return failure(
      'FORBIDDEN',
      `${OWN_ROLE} cannot address the other Baby's adapter (SPEC §4.2)`,
    );
  }
  return undefined;
}

const routes: RouteDefinition[] = [
  {
    method: 'POST',
    pattern: '/observe',
    roles: ['internal-controller'],
    // SPEC §10.1/§10.2, ALD-038: `assertObservationHygiene` is documented as
    // "the only gate between a built Observation and a learner" — this route
    // is a second path into the same adapter, so it must run the same gate,
    // fail closed, and audit a rejection rather than silently dropping it.
    // The nested `observation.recipient` field, not only the top-level
    // `role`/`babyId`/`recipient` keys `guardOtherBaby` checks, is where a
    // caller actually names the delivery target (SPEC §4.2, §11.2).
    handler: async ({ body, actorId }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'observe body');
      const runId = requireString(record, 'runId');
      const gated = requireActiveRun(runId);
      if (gated) {
        return gated;
      }
      const observationInput = requireField(record, 'observation');
      const candidate = asRecord(observationInput, 'observation');
      if (candidate['recipient'] !== OWN_ROLE) {
        return failure(
          'FORBIDDEN',
          `${OWN_ROLE} cannot address the other Baby's adapter (SPEC §4.2)`,
        );
      }
      const runtime = getNurseryRuntime();
      let observation: Observation;
      try {
        observation = assertObservationHygiene(observationInput);
      } catch (error) {
        if (!(error instanceof HygieneViolationError)) {
          throw error;
        }
        // ALD-038 criterion 3: a blocked field is an audited event, never a
        // silent drop. `recordHumanView`/`annotate` are the only audit
        // entry points this runtime exposes to a twin route; `annotate` is
        // used here because the rejection is itself an operator-visible
        // event, not a read.
        await runtime
          .annotate(runId, {
            actorId,
            reasonCode: 'observation-hygiene-rejected',
            details: { reasonCodes: error.reasonCodes },
          })
          .catch(() => undefined);
        return failure('INVALID_REQUEST', error.message, {
          reasonCodes: error.reasonCodes,
        });
      }
      await runtime.adaptersFor(runId)[OWN_ROLE].observe(observation);
      return success({});
    },
  },
  {
    method: 'POST',
    pattern: '/act',
    roles: ['internal-gateway'],
    handler: async ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'act body');
      const runId = requireString(record, 'runId');
      const gated = requireActiveRun(runId);
      if (gated) {
        return gated;
      }
      const turnBudget = parseTurnBudget(requireField(record, 'turnBudget'));
      const runtime = getNurseryRuntime();
      const envelope = await runtime.adaptersFor(runId)[OWN_ROLE].act(turnBudget);
      return success({ envelope });
    },
  },
  {
    method: 'POST',
    pattern: '/deliver',
    roles: ['internal-gateway'],
    handler: async ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'deliver body');
      const runId = requireString(record, 'runId');
      const gated = requireActiveRun(runId);
      if (gated) {
        return gated;
      }
      const delivery = DeliveredChannelArtifactSchema.parse(
        requireField(record, 'delivery'),
      );
      const runtime = getNurseryRuntime();
      const ledgerDraft = await runtime.adaptersFor(runId)[OWN_ROLE].receive(delivery);
      return success({ ledgerDraft });
    },
  },
  {
    method: 'POST',
    pattern: '/outcome',
    roles: ['internal-controller'],
    handler: async ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'outcome body');
      const runId = requireString(record, 'runId');
      const gated = requireActiveRun(runId);
      if (gated) {
        return gated;
      }
      const outcome = parseOutcomeEvent(requireField(record, 'outcome'));
      const runtime = getNurseryRuntime();
      await runtime.adaptersFor(runId)[OWN_ROLE].onOutcome(outcome);
      return success({});
    },
  },
  {
    method: 'GET',
    pattern: '/ledger',
    roles: ['researcher-viewer'],
    handler: ({ request, actorId }) => {
      const runId = request.query['runId'];
      if (runId === undefined || runId.length === 0) {
        return failure('INVALID_REQUEST', '"runId" query parameter is required');
      }
      const runtime = getNurseryRuntime();
      const { babyA } = runtime.ledgers(runId);
      const { babyA: humanAudit } = runtime.auditLedgers(runId);
      const agentNativeEventCount = babyA.filter(
        (event) => event.contentSchema === 'agent-native-ledger',
      ).length;
      return runtime
        .recordHumanView(runId, {
          actorId,
          reasonCode: 'read-baby-ledger',
          details: { twinName: OWN_ROLE, route: '/ledger' },
        })
        .catch(() => undefined)
        .then(() =>
          success({
            ledger: humanAudit,
            agentNativeEventCount,
          }),
        );
    },
  },
  {
    method: 'POST',
    pattern: '/reset',
    roles: ['internal-controller'],
    handler: ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'reset body');
      requireString(record, 'runId');
      // `NurseryRuntimeImpl` has no adapter re-initialization entry point
      // (SPEC §12.4's "reset private state at run initialization" happens
      // once, inside `createRun`); this is a documented gap, not a silent
      // no-op. `NOT_IMPLEMENTED`/501 is not a member of the §12.3 closed
      // error-code/status set, so the gap is reported in-envelope instead.
      return failure(
        'CONFLICT',
        `${OWN_ROLE} has no adapter reset entry point on this runtime; ` +
          'reset happens once, during run creation (SPEC §12.4)',
      );
    },
  },
];

const dispatch = createRouter(routes);

export default class BabyAPack implements BehaviorPack {
  private context!: BehaviorPackContext;

  async init(context: BehaviorPackContext): Promise<void> {
    this.context = context;
  }

  handleRequest(
    request: TwinRequest,
    _state: Map<string, unknown>,
  ): Promise<BehaviorPackResult> {
    return dispatch(request, this.context);
  }

  emitEvents(mutations: StateMutation[]): TwinEvent[] {
    return mutations.map((mutation) => ({
      type: `${mutation.type}.${mutation.entity}`,
      source: this.context.twinName,
      timestamp: Date.now(),
      data: { key: mutation.key, value: mutation.value },
    }));
  }

  validateInvariants(_state: Map<string, unknown>): string[] {
    return [];
  }

  describeCapabilities(): string[] {
    return ['learner-routes', 'prototype-mode'];
  }
}
