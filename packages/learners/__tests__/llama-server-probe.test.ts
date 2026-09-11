import { describe, expect, it } from 'vitest';

import { LocalModelResponseError } from '../src/llm-errors.js';
import { probeLlamaServer } from '../src/llama-server-probe.js';
import type {
  FetchLike,
  FetchLikeResponse,
} from '../src/llm-server-client.js';

function response(body: unknown): FetchLikeResponse {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function probeFetch(slotContextLength = 8_192): FetchLike {
  return (url) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Promise.resolve(response({ status: 'ok' }));
    if (path === '/props') {
      return Promise.resolve(
        response({
          build_info: 'b10809-5266f24da',
          model_alias: 'qwen3-4b-q4-k-m',
          model_ftype: 'Q4_K - Medium',
          total_slots: 1,
          chat_template: 'template bytes',
          chat_template_caps: { supports_tools: true },
          modalities: { vision: false, video: false, audio: false },
        }),
      );
    }
    if (path === '/v1/models') {
      return Promise.resolve(
        response({
          data: [
            {
              id: 'qwen3-4b-q4-k-m',
              meta: {
                n_ctx: 8_192,
                n_ctx_train: 40_960,
                n_params: 4_022_468_096,
                size: 2_491_323_904,
              },
            },
          ],
        }),
      );
    }
    return Promise.resolve(response([{ id: 0, n_ctx: slotContextLength }]));
  };
}

describe('live llama-server attestation', () => {
  it('cross-checks health, model metadata, tools, and slots', async () => {
    const result = await probeLlamaServer({
      endpoint: 'http://127.0.0.1:18091',
      modelId: 'qwen3-4b-q4-k-m',
      fetchImpl: probeFetch(),
    });
    expect(result).toMatchObject({
      health: 'ok',
      buildInfo: 'b10809-5266f24da',
      modelAlias: 'qwen3-4b-q4-k-m',
      modelFileType: 'Q4_K - Medium',
      configuredContextLength: 8_192,
      totalSlots: 1,
      slotContextLengths: [8_192],
      supportsTools: true,
    });
    expect(result.chatTemplateSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects a slot whose context does not match the loaded model', async () => {
    await expect(
      probeLlamaServer({
        endpoint: 'http://127.0.0.1:18091',
        modelId: 'qwen3-4b-q4-k-m',
        fetchImpl: probeFetch(4_096),
      }),
    ).rejects.toBeInstanceOf(LocalModelResponseError);
  });
});
