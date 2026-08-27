export interface TwinRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface TwinResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface StateMutation {
  type: string;
  entity: string;
  key: string;
  value: unknown;
}

export interface TwinEvent {
  type: string;
  source: string;
  timestamp: number;
  data: unknown;
}

export interface BehaviorPackContext {
  twinName: string;
  seed: number;
  state: Map<string, unknown>;
}

export interface BehaviorPackResult {
  response: TwinResponse;
  mutations: StateMutation[];
}

export interface BehaviorPack {
  init(context: BehaviorPackContext): Promise<void>;
  handleRequest(
    request: TwinRequest,
    state: Map<string, unknown>,
  ): Promise<BehaviorPackResult>;
  emitEvents(mutations: StateMutation[]): TwinEvent[];
  validateInvariants(state: Map<string, unknown>): string[];
  describeCapabilities(): string[];
}
