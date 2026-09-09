/**
 * ALD-044: the local-model client seam — the `modelRef` grammar, the
 * loopback-only network policy (SPEC §10.3), weight hashing
 * (`sha256sum`-reproducible), the OpenAI-compatible request/response path
 * driven through an injected `fetch`, and the deterministic scripted double.
 *
 * No test here opens a socket: every transport call goes through a fake
 * `fetch` that records what the client sent.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConstrainedCompletionResponseSchema,
  formatModelRef,
  parseCompletionResponse,
  parseModelRef,
  type ConstrainedCompletionRequest,
} from '../src/llm-client.js';
import {
  LocalModelResponseError,
  LocalModelTransportError,
  NonLoopbackEndpointError,
  WeightsFileUnreadableError,
  WeightsHashUnavailableError,
  isLocalModelErrorCode,
  LOCAL_MODEL_ERROR_CODES,
} from '../src/llm-errors.js';
import { hashWeightsFile } from '../src/llm-weights.js';
import {
  OpenAiCompatibleLocalClient,
  assertLoopbackEndpoint,
  isLoopbackEndpoint,
  type FetchLike,
  type FetchLikeResponse,
} from '../src/llm-server-client.js';
import {
  SCRIPTED_BEHAVIORS,
  ScriptedModelClient,
} from '../src/llm-scripted-client.js';
import { buildToolDefinitions } from '../src/llm-prompt.js';
import { classifyModelOutput } from '../src/llm-prompt.js';

const HASH = `sha256:${'ab'.repeat(32)}`;

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(
  handler: (call: RecordedCall) => { status?: number; body: unknown },
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    const response: FetchLikeResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    };
    return Promise.resolve(response);
  };
  return { fetchImpl, calls };
}

function completionBody(
  toolName: string,
  args: unknown,
  content = '',
): unknown {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: [
            {
              function: {
                name: toolName,
                arguments: typeof args === 'string' ? args : JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function turnBudget(
  role: 'sender' | 'receiver',
): ConstrainedCompletionRequest['tools'] {
  return buildToolDefinitions(
    {
      turn: 1,
      role,
      responseBudgetMs: 1_000,
      availableActions: [role === 'sender' ? 'emit_symbols' : 'select_object'],
      ...(role === 'receiver' ? { candidateRefs: ['o:aa', 'o:bb'] } : {}),
    },
    { symbolInventory: ['S01', 'S02'], maxSymbolsPerMessage: 2, candidateRefs: ['o:aa', 'o:bb'] },
  );
}

function request(
  overrides: Partial<ConstrainedCompletionRequest> = {},
): ConstrainedCompletionRequest {
  return {
    systemPrompt: 'CONTRACT BODY',
    memoryDigest: {
      version: 'frozen-llm-memory-v1',
      turns: 0,
      symbolsTracked: 0,
      entries: [],
    },
    observation: { candidates: [[0, 1], [2, 3]], targetIndex: 0 },
    tools: turnBudget('sender'),
    maxOutputTokens: 64,
    timeBudgetMs: 500,
    samplingSeed: 7,
    temperature: 0,
    ...overrides,
  };
}

describe('ALD-044 modelRef grammar', () => {
  it('formats and parses <modelId>@<weightsHash>', () => {
    const ref = formatModelRef('qwen2.5-3b-instruct-q4_k_m', HASH);
    expect(ref).toBe(`qwen2.5-3b-instruct-q4_k_m@${HASH}`);
    expect(parseModelRef(ref)).toEqual({
      modelId: 'qwen2.5-3b-instruct-q4_k_m',
      weightsHash: HASH,
    });
  });

  it('rejects strings that are not the two-part form', () => {
    expect(parseModelRef('reference:frozen-llm')).toBeUndefined();
    expect(parseModelRef('@only-hash')).toBeUndefined();
    expect(parseModelRef('only-model@')).toBeUndefined();
  });
});

describe('ALD-044 loopback-only network policy (SPEC §10.3)', () => {
  const allowed = [
    'http://127.0.0.1:8080',
    'http://localhost:11434',
    'https://localhost:8443/v1',
    'http://[::1]:8080/v1',
    'unix:/run/llama/llama.sock',
    'http+unix://%2Frun%2Fllama.sock',
  ];
  const refused = [
    'http://127.0.0.1.example.com:8080',
    'http://192.168.1.10:8080',
    'http://10.0.0.5:8080',
    'https://api.example.com/v1',
    'http://model.internal:8080',
    'ftp://localhost/model',
    'not-a-url',
    'http://127.0.0.2:8080',
  ];

  it.each(allowed)('accepts the loopback endpoint %s', (endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(true);
    expect(() => {
      assertLoopbackEndpoint(endpoint);
    }).not.toThrow();
  });

  it.each(refused)('refuses the non-loopback endpoint %s', (endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(false);
    expect(() => {
      assertLoopbackEndpoint(endpoint);
    }).toThrow(NonLoopbackEndpointError);
  });

  it('refuses a non-loopback endpoint before any request is made', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: {} }));
    await expect(
      OpenAiCompatibleLocalClient.create({
        endpoint: 'https://api.example.com',
        modelId: 'm',
        weightsHash: HASH,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(NonLoopbackEndpointError);
    expect(calls).toHaveLength(0);
  });

  it('names a closed error-code union', () => {
    expect(LOCAL_MODEL_ERROR_CODES).toContain('non-loopback-endpoint');
    expect(isLocalModelErrorCode('model-timeout')).toBe(true);
    expect(isLocalModelErrorCode('unknown-code')).toBe(false);
  });
});

describe('ALD-044 weight hashing records the exact weights', () => {
  it('stream-hashes a weights file to the same digest as sha256sum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ald-weights-'));
    const path = join(dir, 'model.gguf');
    const bytes = Buffer.from(`GGUF${randomUUID()}`.repeat(4096));
    await writeFile(path, bytes);

    const digest = await hashWeightsFile(path);
    expect(digest.sizeBytes).toBe(bytes.byteLength);
    expect(digest.weightsHash).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    );
  });

  it('refuses an empty or missing weights file rather than hashing nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ald-weights-'));
    const empty = join(dir, 'empty.gguf');
    await writeFile(empty, '');
    await expect(hashWeightsFile(empty)).rejects.toBeInstanceOf(
      WeightsFileUnreadableError,
    );
    await expect(
      hashWeightsFile(join(dir, 'absent.gguf')),
    ).rejects.toBeInstanceOf(WeightsFileUnreadableError);
  });

  it('hashes the weights file at construction and records the source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ald-weights-'));
    const path = join(dir, 'model.gguf');
    await writeFile(path, 'weights-bytes');
    const { fetchImpl, calls } = fakeFetch(() => ({ body: {} }));

    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      weightsPath: path,
      quantization: 'Q4_K_M',
      fetchImpl,
    });
    const description = client.describe();
    expect(description.weightsHashSource).toBe('weights-file');
    expect(description.weightsHash).toBe(
      (await hashWeightsFile(path)).weightsHash,
    );
    expect(description.quantization).toBe('Q4_K_M');
    expect(description.toolCallingMode).toBe('json-schema-grammar');
    // No model listing was needed because the file supplied the digest.
    expect(calls).toHaveLength(0);
  });

  it('falls back to the server-reported digest and records that source', async () => {
    const digest = `sha256:${'cd'.repeat(32)}`;
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: { data: [{ id: 'local-3b', digest }] },
    }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      fetchImpl,
    });
    expect(client.describe()).toMatchObject({
      weightsHash: digest,
      weightsHashSource: 'server-reported',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/v1/models');
  });

  it('reads the Ollama listing shape as well', async () => {
    const bare = 'ef'.repeat(32);
    const { fetchImpl } = fakeFetch(() => ({
      body: { models: [{ name: 'local-3b', digest: bare }] },
    }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://localhost:11434',
      modelId: 'local-3b',
      fetchImpl,
    });
    expect(client.describe().weightsHash).toBe(`sha256:${bare}`);
  });

  it('refuses to construct when no weight hash is available at all', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { data: [] } }));
    await expect(
      OpenAiCompatibleLocalClient.create({
        endpoint: 'http://127.0.0.1:8080',
        modelId: 'local-3b',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(WeightsHashUnavailableError);
  });
});

describe('ALD-044 constrained completion over the loopback endpoint', () => {
  it('sends the frozen contract verbatim, the digest, and the tool schema', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      ({ body: completionBody('emit_symbols', { symbols: ['S02'] }) }),
    );
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080/v1',
      modelId: 'local-3b',
      weightsHash: HASH,
      fetchImpl,
    });

    const response = await client.complete(request());
    expect(response.toolCall).toEqual({
      name: 'emit_symbols',
      arguments: { symbols: ['S02'] },
    });
    expect(response.finishReason).toBe('tool-call');

    const call = calls[0];
    expect(call?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    const body = call?.body as {
      messages: { role: string; content: string }[];
      tools: { function: { name: string; parameters: unknown } }[];
      seed: number;
      max_tokens: number;
      temperature: number;
      tool_choice: string;
    };
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'CONTRACT BODY',
    });
    expect(body.tools[0]?.function.name).toBe('emit_symbols');
    expect(body.tools[0]?.function.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        symbols: {
          items: { type: 'string', enum: ['S01', 'S02'] },
          maxItems: 2,
        },
      },
    });
    expect(body.seed).toBe(7);
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0);
    expect(body.tool_choice).toBe('required');

    // The user message carries only opaque numeric observation state and the
    // memory digest (SPEC §10.1: no attribute names anywhere).
    const user = body.messages[1]?.content ?? '';
    expect(user).toContain('"candidates"');
    expect(user).toContain('"targetIndex"');
    expect(JSON.parse(user)).toEqual({
      memory: request().memoryDigest,
      observation: request().observation,
    });
  });

  it('passes an unparseable arguments string through unrepaired', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: completionBody('emit_symbols', '{"symbols": ["S0'),
    }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      weightsHash: HASH,
      fetchImpl,
    });
    const response = await client.complete(request());
    expect(response.toolCall?.arguments).toBe('{"symbols": ["S0');
  });

  it('reports assistant text with no tool call as prose', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: {
        choices: [
          { message: { content: 'Let us agree that S01 means the round one.' }, finish_reason: 'stop' },
        ],
      },
    }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      weightsHash: HASH,
      fetchImpl,
    });
    const response = await client.complete(request());
    expect(response.toolCall).toBeUndefined();
    expect(response.raw.length).toBeGreaterThan(0);
  });

  it('raises a transport error on a non-2xx status and never echoes the body', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 503, body: { error: 'busy' } }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      weightsHash: HASH,
      fetchImpl,
    });
    await expect(client.complete(request())).rejects.toMatchObject({
      code: 'model-transport-failure',
    });
    await client.complete(request()).catch((error: unknown) => {
      expect((error as LocalModelTransportError).message).not.toContain('busy');
    });
  });

  it('raises a response error for a body that is not a completion', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { choices: [] } }));
    const client = await OpenAiCompatibleLocalClient.create({
      endpoint: 'http://127.0.0.1:8080',
      modelId: 'local-3b',
      weightsHash: HASH,
      fetchImpl,
    });
    await expect(client.complete(request())).rejects.toBeInstanceOf(
      LocalModelResponseError,
    );
  });
});

describe('ALD-044 completion-envelope validation', () => {
  it('accepts a well-formed completion and rejects anything else', () => {
    expect(
      parseCompletionResponse({ raw: '', finishReason: 'stop' }),
    ).toEqual({ raw: '', finishReason: 'stop' });
    expect(() => parseCompletionResponse({ raw: 1, finishReason: 'stop' })).toThrow(
      LocalModelResponseError,
    );
    expect(() => parseCompletionResponse({ finishReason: 'stop' })).toThrow(
      LocalModelResponseError,
    );
    expect(
      ConstrainedCompletionResponseSchema.safeParse({
        raw: '',
        finishReason: 'stop',
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('never puts the malformed value into the error message', () => {
    try {
      parseCompletionResponse({ raw: 'SECRET-PROMPT-ECHO', finishReason: 'nope' });
      expect.unreachable('a bad finishReason must be rejected');
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-PROMPT-ECHO');
    }
  });
});

describe('ALD-044 ScriptedModelClient (test double)', () => {
  it('declares itself a double so no run can mistake it for real weights', () => {
    const description = new ScriptedModelClient().describe();
    expect(description.weightsHashSource).toBe('scripted-double');
    expect(description.toolCallingMode).toBe('scripted');
    expect(description.weightsHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('produces one classified output per prohibited-attempt category', async () => {
    const expected: Record<string, string> = {
      'valid-tool-call': 'tool-call',
      'tool-call-with-free-text': 'tool-call-text',
      'prose-only': 'text-only',
      'malformed-json': 'unparsed',
      'oversized-payload': 'tool-call',
      'off-inventory-symbol': 'tool-call',
      'extra-artifact-field': 'tool-call',
      'wrong-carrier-kind': 'kind-mismatch',
      'empty-output': 'unparsed',
    };
    for (const behavior of SCRIPTED_BEHAVIORS) {
      if (behavior === 'timeout') {
        continue;
      }
      const client = new ScriptedModelClient({ behavior });
      const tools = turnBudget('sender');
      const response = await client.complete(request({ tools }));
      const classified = classifyModelOutput(response, tools);
      expect(classified.outputClass, behavior).toBe(expected[behavior]);
    }
  });

  it('marks an extra artifact field as a non-clean tool call', async () => {
    const client = new ScriptedModelClient({ behavior: 'extra-artifact-field' });
    const tools = turnBudget('sender');
    const classified = classifyModelOutput(
      await client.complete(request({ tools })),
      tools,
    );
    expect(classified.outputClass).toBe('tool-call');
    if (classified.outputClass === 'tool-call') {
      expect(classified.argsClean).toBe(false);
      expect(Object.keys(classified.args).sort()).toEqual([
        'annotationCode',
        'symbols',
      ]);
    }
  });

  it('is deterministic for the same request and cycles behaviors by call index', async () => {
    const first = new ScriptedModelClient({
      behaviors: ['valid-tool-call', 'prose-only'],
    });
    const second = new ScriptedModelClient({
      behaviors: ['valid-tool-call', 'prose-only'],
    });
    const a1 = await first.complete(request());
    const a2 = await first.complete(request());
    const b1 = await second.complete(request());
    const b2 = await second.complete(request());
    expect(a1).toEqual(b1);
    expect(a2).toEqual(b2);
    expect(a1.toolCall).toBeDefined();
    expect(a2.toolCall).toBeUndefined();
    expect(first.callCount).toBe(2);
    expect(first.requests).toHaveLength(2);
  });

  it('names the same mark for the same attribute row in both roles', () => {
    const client = new ScriptedModelClient();
    const inventory = ['S01', 'S02', 'S03', 'S04'];
    expect(client.namingSymbolFor([1, 2], inventory)).toBe(
      client.namingSymbolFor([1, 2], inventory),
    );
    const distinct = new Set(
      [[0, 0], [0, 1], [1, 0], [3, 3]].map((row) =>
        client.namingSymbolFor(row, inventory),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('waits past the request budget for the timeout behavior', async () => {
    const client = new ScriptedModelClient({
      behavior: 'timeout',
      timeoutOvershootMs: 5,
    });
    const started = Date.now();
    await client.complete(request({ timeBudgetMs: 20 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
