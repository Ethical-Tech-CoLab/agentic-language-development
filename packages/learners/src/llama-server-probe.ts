import { createHash } from 'node:crypto';

import {
  assertLoopbackEndpoint,
  type FetchLike,
  type FetchLikeResponse,
} from './llm-server-client.js';
import {
  LocalModelResponseError,
  LocalModelTransportError,
} from './llm-errors.js';

export interface LlamaServerAttestation {
  readonly endpoint: string;
  readonly health: 'ok';
  readonly buildInfo: string;
  readonly modelAlias: string;
  readonly modelFileType: string;
  readonly modelParameterCount: number;
  readonly modelSizeBytes: number;
  readonly configuredContextLength: number;
  readonly trainingContextLength: number;
  readonly totalSlots: number;
  readonly slotContextLengths: number[];
  readonly chatTemplateSha256: `sha256:${string}`;
  readonly supportsTools: boolean;
  readonly modalities: {
    readonly vision: boolean;
    readonly video: boolean;
    readonly audio: boolean;
  };
}

interface ProbeOptions {
  endpoint: string;
  modelId: string;
  fetchImpl?: FetchLike;
}

function joinPath(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/+$/u, '').replace(/\/v1$/u, '');
  return `${base}${path}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalModelResponseError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalModelResponseError(`${label} is missing`);
  }
  return value;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LocalModelResponseError(`${label} is missing`);
  }
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LocalModelResponseError(`${label} is missing`);
  }
  return value;
}

async function getJson(
  endpoint: string,
  path: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(joinPath(endpoint, path), {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new LocalModelTransportError(null);
  }
  if (!response.ok) {
    throw new LocalModelTransportError(response.status);
  }
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    throw new LocalModelResponseError(`${path} response is not JSON`);
  }
}

/** Read the live llama-server surfaces used to attest an actual loaded model. */
export async function probeLlamaServer(
  options: ProbeOptions,
): Promise<LlamaServerAttestation> {
  assertLoopbackEndpoint(options.endpoint);
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  const fetchImpl =
    options.fetchImpl ??
    (typeof globalFetch === 'function'
      ? (globalFetch as FetchLike)
      : undefined);
  if (fetchImpl === undefined) {
    throw new LocalModelTransportError(null);
  }

  const health = asRecord(
    await getJson(options.endpoint, '/health', fetchImpl),
    'health response',
  );
  if (health.status !== 'ok') {
    throw new LocalModelResponseError('llama-server is not healthy');
  }

  const props = asRecord(
    await getJson(options.endpoint, '/props', fetchImpl),
    'props response',
  );
  const listing = asRecord(
    await getJson(options.endpoint, '/v1/models', fetchImpl),
    'model listing',
  );
  const slotsValue = await getJson(options.endpoint, '/slots', fetchImpl);
  if (!Array.isArray(slotsValue) || slotsValue.length === 0) {
    throw new LocalModelResponseError('slot listing is empty');
  }

  const data = listing.data;
  if (!Array.isArray(data)) {
    throw new LocalModelResponseError('model listing data is missing');
  }
  const model = data
    .map((entry) => asRecord(entry, 'model listing entry'))
    .find((entry) => entry.id === options.modelId);
  if (model === undefined) {
    throw new LocalModelResponseError('configured model is not loaded');
  }
  const meta = asRecord(model.meta, 'model metadata');
  const caps = asRecord(props.chat_template_caps, 'chat template capabilities');
  const modalities = asRecord(props.modalities, 'model modalities');
  const template = asString(props.chat_template, 'chat template');
  const slots = slotsValue.map((entry) => asRecord(entry, 'slot entry'));

  const attestation: LlamaServerAttestation = {
    endpoint: options.endpoint,
    health: 'ok',
    buildInfo: asString(props.build_info, 'build info'),
    modelAlias: asString(props.model_alias, 'model alias'),
    modelFileType: asString(props.model_ftype, 'model file type'),
    modelParameterCount: asFiniteNumber(meta.n_params, 'model parameter count'),
    modelSizeBytes: asFiniteNumber(meta.size, 'model size'),
    configuredContextLength: asFiniteNumber(meta.n_ctx, 'configured context length'),
    trainingContextLength: asFiniteNumber(meta.n_ctx_train, 'training context length'),
    totalSlots: asFiniteNumber(props.total_slots, 'total slots'),
    slotContextLengths: slots.map((slot) =>
      asFiniteNumber(slot.n_ctx, 'slot context length'),
    ),
    chatTemplateSha256: `sha256:${createHash('sha256').update(template).digest('hex')}`,
    supportsTools: asBoolean(caps.supports_tools, 'tool support'),
    modalities: {
      vision: asBoolean(modalities.vision, 'vision modality'),
      video: asBoolean(modalities.video, 'video modality'),
      audio: asBoolean(modalities.audio, 'audio modality'),
    },
  };
  if (
    attestation.modelAlias !== options.modelId ||
    attestation.totalSlots !== slots.length ||
    attestation.slotContextLengths.some(
      (contextLength) => contextLength !== attestation.configuredContextLength,
    )
  ) {
    throw new LocalModelResponseError(
      'loaded-model, slot, and context attestations do not agree',
    );
  }
  return attestation;
}
