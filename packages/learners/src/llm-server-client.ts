/**
 * `OpenAiCompatibleLocalClient` — the loopback-only transport for a locally
 * deployed frozen open-weight model (BACKLOG ALD-044;
 * SPECIFICATION.md §6.7, §10.1, §10.3).
 *
 * It speaks the OpenAI-compatible `/v1/chat/completions` surface that
 * `llama.cpp`'s `llama-server`, Ollama, vLLM and LM Studio all expose, using
 * `response_format: { type: 'json_schema', … }` plus `tools` so decoding is
 * constrained to the turn's tool schema (SPEC §6.7 "reliable constrained
 * tool-calling").
 *
 * The single most important property of this file is what it refuses.
 * SPEC §10.3 puts "no direct network … access from a Baby process/container
 * beyond the Gateway RPC" in the Mode R threat model, and §6.7's default
 * reference implementation for this track is a model with "no network access".
 * So:
 *
 * - the constructor accepts an endpoint only when its host is `127.0.0.1`,
 *   `localhost`, `::1`, or a unix socket. Every other host — including
 *   `127.0.0.1.example.com`, a bare LAN address, and any public name — raises
 *   `NonLoopbackEndpointError` before a single request is made;
 * - this is the *only* network client anywhere in the `frozen-llm` code path.
 *   Nothing here downloads weights, resolves a model name against a hub, or
 *   fetches a tokenizer;
 * - the `fetch` implementation is injectable, so this package's tests exercise
 *   the whole request/response path without opening a socket.
 *
 * The weight hash comes from one of two places and records which
 * (`LocalModelDescription.weightsHashSource`): a plain SHA-256 over a local
 * weights file (`weightsPath`, reproducible with `sha256sum`), or the
 * inference server's own reported digest. A deployment that can supply
 * neither is refused rather than recorded with a placeholder, because ALD-044
 * criterion 1 is about recording the *exact* weight hash.
 */
import type { Sha256Hash } from '@ald/types';
import { canonicalJson } from '@ald/hashing';

import {
  LocalModelResponseError,
  LocalModelTimeoutError,
  LocalModelTransportError,
  NonLoopbackEndpointError,
  WeightsHashUnavailableError,
} from './llm-errors.js';
import {
  parseCompletionResponse,
  type ConstrainedCompletionRequest,
  type ConstrainedCompletionResponse,
  type LocalModelClient,
  type LocalModelDescription,
} from './llm-client.js';
import { hashWeightsFile } from './llm-weights.js';

/** Hosts an inference endpoint may use (SPEC §10.3). */
export const LOOPBACK_HOSTNAMES: readonly string[] = [
  '127.0.0.1',
  'localhost',
  '::1',
];

/** URL schemes that address a unix domain socket rather than a host. */
const UNIX_SCHEMES: readonly string[] = ['unix:', 'http+unix:', 'https+unix:'];

/**
 * The minimal `fetch` surface this client uses. Declared here rather than
 * relying on the ambient DOM/undici types so the package type-checks under the
 * repository's `@types/node` version and so tests can inject a double.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** `true` when `endpoint` addresses loopback or a unix socket. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (UNIX_SCHEMES.includes(url.protocol)) {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  // `new URL('http://[::1]:8080').hostname` keeps the brackets.
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  return LOOPBACK_HOSTNAMES.includes(hostname);
}

/** Throws {@link NonLoopbackEndpointError} unless `endpoint` is loopback. */
export function assertLoopbackEndpoint(endpoint: string): void {
  if (isLoopbackEndpoint(endpoint)) {
    return;
  }
  let hostname = '<unparseable>';
  try {
    hostname = new URL(endpoint).hostname || new URL(endpoint).protocol;
  } catch {
    // Keep the placeholder: the endpoint string itself is operator input and
    // is not echoed into the error.
  }
  throw new NonLoopbackEndpointError(hostname);
}

export interface OpenAiCompatibleLocalClientOptions {
  /** Server root or `/v1` base, e.g. `http://127.0.0.1:8080`. */
  endpoint: string;
  /** Model name as the server knows it; also the recorded `modelId`. */
  modelId: string;
  /** Local weights file to hash (`sha256sum`-reproducible). */
  weightsPath?: string;
  /** Pre-computed weight hash, when the operator hashed the file already. */
  weightsHash?: Sha256Hash;
  quantization?: string;
  /** Context window; default `8192`. */
  contextLength?: number;
  /** Injected `fetch`; defaults to the global one. */
  fetchImpl?: FetchLike;
}

interface CompletionChoiceToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

interface CompletionChoice {
  message?: { content?: unknown; tool_calls?: unknown };
  finish_reason?: unknown;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const BARE_HEX_PATTERN = /^[0-9a-f]{64}$/u;

function normalizeDigest(value: unknown): Sha256Hash | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (HASH_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return BARE_HEX_PATTERN.test(trimmed) ? `sha256:${trimmed}` : undefined;
}

function resolveFetch(options: OpenAiCompatibleLocalClientOptions): FetchLike {
  if (options.fetchImpl !== undefined) {
    return options.fetchImpl;
  }
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    throw new LocalModelTransportError(null);
  }
  return globalFetch as FetchLike;
}

/** `<base>/v1/chat/completions`, tolerating a base that already ends in `/v1`. */
function joinPath(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/+$/u, '');
  if (base.endsWith('/v1') && path.startsWith('/v1/')) {
    return `${base}${path.slice('/v1'.length)}`;
  }
  return `${base}${path}`;
}

export class OpenAiCompatibleLocalClient implements LocalModelClient {
  private readonly fetchImpl: FetchLike;

  private constructor(
    private readonly endpoint: string,
    private readonly description: LocalModelDescription,
    fetchImpl: FetchLike,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * Build a client, resolving the weight hash first.
   *
   * Precedence: an explicit `weightsHash`, then a streamed digest of
   * `weightsPath`, then the server's reported digest. The loopback check runs
   * before any of that, so a misconfigured endpoint never receives a request.
   */
  static async create(
    options: OpenAiCompatibleLocalClientOptions,
  ): Promise<OpenAiCompatibleLocalClient> {
    assertLoopbackEndpoint(options.endpoint);
    const fetchImpl = resolveFetch(options);

    let weightsHash: Sha256Hash | undefined = normalizeDigest(
      options.weightsHash,
    );
    let weightsHashSource: LocalModelDescription['weightsHashSource'] =
      'weights-file';

    if (weightsHash === undefined && options.weightsPath !== undefined) {
      weightsHash = (await hashWeightsFile(options.weightsPath)).weightsHash;
    }
    if (weightsHash === undefined) {
      weightsHash = await OpenAiCompatibleLocalClient.serverReportedDigest(
        options.endpoint,
        options.modelId,
        fetchImpl,
      );
      weightsHashSource = 'server-reported';
    }
    if (weightsHash === undefined) {
      throw new WeightsHashUnavailableError(options.modelId);
    }

    return new OpenAiCompatibleLocalClient(
      options.endpoint,
      {
        modelId: options.modelId,
        weightsHash,
        weightsHashSource,
        ...(options.quantization === undefined
          ? {}
          : { quantization: options.quantization }),
        contextLength: options.contextLength ?? 8_192,
        toolCallingMode: 'json-schema-grammar',
      },
      fetchImpl,
    );
  }

  describe(): LocalModelDescription {
    return { ...this.description };
  }

  async complete(
    request: ConstrainedCompletionRequest,
  ): Promise<ConstrainedCompletionResponse> {
    const tool = request.tools[0];
    if (tool === undefined) {
      throw new LocalModelResponseError('no tool schema was supplied');
    }

    const body = {
      model: this.description.modelId,
      messages: [
        // The frozen contract text, verbatim (SPEC §6.4, §6.6).
        { role: 'system', content: request.systemPrompt },
        // Opaque numeric observation plus the private-memory digest; RFC 8785
        // canonical JSON, so the same turn state always renders identically
        // and a greedy decode is reproducible (SPEC §14.3).
        {
          role: 'user',
          content: canonicalJson({
            memory: request.memoryDigest,
            observation: request.observation,
          }),
        },
      ],
      tools: request.tools.map((definition) => ({
        type: 'function',
        function: { name: definition.name, parameters: definition.parameters },
      })),
      // One schema is exposed per turn, so the portable OpenAI-compatible
      // string form is equivalent to naming it and is accepted by llama.cpp,
      // Ollama and vLLM.
      tool_choice: 'required',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: tool.name,
          strict: true,
          schema: tool.parameters,
        },
      },
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      seed: request.samplingSeed,
      stream: false,
    };

    const raw = await this.post(
      joinPath(this.endpoint, '/v1/chat/completions'),
      body,
      request.timeBudgetMs,
    );
    return parseCompletionResponse(readChatCompletion(raw));
  }

  private async post(
    url: string,
    body: unknown,
    timeBudgetMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeBudgetMs);
    let response: FetchLikeResponse;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LocalModelTimeoutError(timeBudgetMs);
      }
      throw new LocalModelTransportError(
        typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: unknown }).status)
          : null,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new LocalModelTransportError(response.status);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LocalModelResponseError('response body is not JSON');
    }
  }

  /**
   * The server's own digest for `modelId`, from `/v1/models`. Both the
   * OpenAI-compatible shape (`{ data: [{ id, digest }] }`) and Ollama's
   * (`{ models: [{ name, digest }] }`) are read, because the two are the
   * deployments SPEC §6.7 has in mind.
   */
  private static async serverReportedDigest(
    endpoint: string,
    modelId: string,
    fetchImpl: FetchLike,
  ): Promise<Sha256Hash | undefined> {
    let response: FetchLikeResponse;
    try {
      response = await fetchImpl(joinPath(endpoint, '/v1/models'), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new LocalModelTransportError(null);
    }
    if (!response.ok) {
      throw new LocalModelTransportError(response.status);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new LocalModelResponseError('model listing is not JSON');
    }
    const entries = modelEntries(parsed);
    for (const entry of entries) {
      const name = entry.id ?? entry.name;
      if (name === modelId) {
        return normalizeDigest(entry.digest);
      }
    }
    return undefined;
  }
}

interface ModelListingEntry {
  id?: string;
  name?: string;
  digest?: unknown;
}

function modelEntries(value: unknown): ModelListingEntry[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const record = value as { data?: unknown; models?: unknown };
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return list.filter(
    (entry): entry is ModelListingEntry =>
      typeof entry === 'object' && entry !== null,
  );
}

/**
 * Read one chat completion into the {@link ConstrainedCompletionResponse}
 * shape. A `tool_calls[0].function.arguments` string that does not parse as
 * JSON is passed through as the string it is, so the adapter classifies it as
 * unparseable output and forwards it to the Gateway rather than repairing it
 * (SPEC §10.2: never sanitized and passed through).
 */
function readChatCompletion(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new LocalModelResponseError('completion is not an object');
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LocalModelResponseError('completion carries no choices');
  }
  const choice = choices[0] as CompletionChoice;
  const message = choice.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = calls[0] as CompletionChoiceToolCall | undefined;
  const fn = first?.function;
  if (fn === undefined || typeof fn.name !== 'string') {
    return {
      raw: content,
      finishReason: choice.finish_reason === 'length' ? 'length' : 'stop',
    };
  }

  return {
    raw: content,
    toolCall: { name: fn.name, arguments: parseArguments(fn.arguments) },
    finishReason: 'tool-call',
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
