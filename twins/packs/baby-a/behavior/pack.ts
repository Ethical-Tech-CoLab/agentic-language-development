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
  ObservationSchema,
  type BehaviorPack,
  type BehaviorPackContext,
  type BehaviorPackResult,
  type StateMutation,
  type TwinEvent,
  type TwinRequest,
} from '@ald/types';
import { getNurseryRuntime } from '@ald/orchestrator';
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
    handler: ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'observe body');
      const runId = requireString(record, 'runId');
      const observation = ObservationSchema.parse(
        requireField(record, 'observation'),
      );
      const runtime = getNurseryRuntime();
      return runtime.adaptersFor(runId)[OWN_ROLE].observe(observation).then(
        () => success({}),
      );
    },
  },
  {
    method: 'POST',
    pattern: '/act',
    roles: ['internal-gateway'],
    handler: ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'act body');
      const runId = requireString(record, 'runId');
      const turnBudget = parseTurnBudget(requireField(record, 'turnBudget'));
      const runtime = getNurseryRuntime();
      return runtime.adaptersFor(runId)[OWN_ROLE]
        .act(turnBudget)
        .then((envelope) => success({ envelope }));
    },
  },
  {
    method: 'POST',
    pattern: '/deliver',
    roles: ['internal-gateway'],
    handler: ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'deliver body');
      const runId = requireString(record, 'runId');
      const delivery = DeliveredChannelArtifactSchema.parse(
        requireField(record, 'delivery'),
      );
      const runtime = getNurseryRuntime();
      return runtime.adaptersFor(runId)[OWN_ROLE]
        .receive(delivery)
        .then((ledgerDraft) => success({ ledgerDraft }));
    },
  },
  {
    method: 'POST',
    pattern: '/outcome',
    roles: ['internal-controller'],
    handler: ({ body }) => {
      const forbidden = guardOtherBaby(body);
      if (forbidden) {
        return forbidden;
      }
      const record = asRecord(body, 'outcome body');
      const runId = requireString(record, 'runId');
      const outcome = parseOutcomeEvent(requireField(record, 'outcome'));
      const runtime = getNurseryRuntime();
      return runtime.adaptersFor(runId)[OWN_ROLE].onOutcome(outcome).then(
        () => success({}),
      );
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
      const humanAudit = babyA.filter(
        (event) => event.contentSchema === 'human-audit-ledger',
      );
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
      // once, inside `createRun`); this route is a documented gap, not a
      // silent no-op.
      return failure(
        'NOT_IMPLEMENTED',
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
