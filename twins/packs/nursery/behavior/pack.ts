import type {
  BehaviorPack,
  BehaviorPackContext,
  BehaviorPackResult,
  StateMutation,
  TwinEvent,
  TwinRequest,
} from '@ald/types';

export const NURSERY_ROUTE_PATTERNS = ['/placeholder'] as const;

export default class NurseryPack implements BehaviorPack {
  private context!: BehaviorPackContext;

  async init(context: BehaviorPackContext): Promise<void> {
    this.context = context;
  }

  async handleRequest(
    request: TwinRequest,
    _state: Map<string, unknown>,
  ): Promise<BehaviorPackResult> {
    if (request.method === 'GET' && request.path === '/placeholder') {
      return {
        response: {
          status: 501,
          headers: { 'content-type': 'application/json' },
          body: {
            error: {
              code: 'NOT_IMPLEMENTED',
              message: 'Nursery behavior is not implemented',
              details: { path: request.path },
            },
          },
        },
        mutations: [],
      };
    }

    return {
      response: {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: {
          error: {
            code: 'NOT_FOUND',
            message: `No Nursery route matches ${request.path}`,
          },
        },
      },
      mutations: [],
    };
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
    return ['scaffold'];
  }
}
