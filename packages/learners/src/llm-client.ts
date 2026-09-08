/**
 * The local-model seam of the `frozen-llm` track (BACKLOG ALD-044;
 * SPECIFICATION.md §6.1 claim boundary, §6.2, §6.3, §6.7).
 *
 * SPEC §6.7 names the default reference implementation for this track as a
 * "locally deployable 3B-8B instruction model with reliable constrained
 * tool-calling and no network access". This module is the interface that
 * describes such a model to the adapter, plus the request/response types of
 * one constrained completion. It contains no model, downloads nothing, and
 * holds no transport of its own: `llm-server-client.ts` implements the
 * loopback-only OpenAI-compatible transport and `llm-scripted-client.ts` the
 * deterministic test double.
 *
 * What the adapter demands of a client:
 *
 * 1. `describe()` is *stable and synchronous*, because ALD-044 criterion 1
 *    requires the exact model and weight hashes to be recorded at `init`, and
 *    `init` must be able to compare them against `RunConfig.babyA/babyB.
 *    modelRef` before the run starts. Any work needed to learn the weight hash
 *    (streaming a GGUF file, asking a server for its digest) happens in the
 *    client's async factory, not here.
 * 2. `complete()` receives a *complete* prompt: the frozen learner-contract
 *    text verbatim (SPEC §6.4, §6.6), the Baby's private-memory digest, the
 *    turn's observation as opaque numeric JSON (SPEC §10.1: no attribute
 *    names, ever), and JSON Schemas for exactly the tools available on this
 *    turn (SPEC §6.3: a Baby may act only through the tools the runtime offers
 *    it). A client MUST NOT add a message, a tool, or an example of its own.
 * 3. `complete()` returns what the model produced, unsanitized. A client that
 *    "repairs" prose into a tool call would destroy the E10 "Prohibited
 *    attempts" measurement; the adapter forwards violations to the Symbol
 *    Gateway on purpose so §9.4 records them.
 */
import { z } from 'zod';

import type { Sha256Hash } from '@ald/types';

import { LocalModelResponseError } from './llm-errors.js';

/**
 * Where the recorded weight hash came from. `weights-file` is the strongest:
 * a plain SHA-256 over the weights file's bytes, which any third party can
 * reproduce with `sha256sum`. `server-reported` trusts the inference server's
 * own digest. `scripted-double` marks the deterministic test double, which has
 * no weights at all and therefore never supports a Mode R or research claim.
 */
export type WeightsHashSource =
  | 'weights-file'
  | 'server-reported'
  | 'scripted-double';

/** Everything the evidence bundle needs to identify the frozen model. */
export interface LocalModelDescription {
  /** Model identifier as the operator configured it; MUST NOT contain `@`. */
  modelId: string;
  /** `sha256:<64 hex>` over the weights, or the server-reported digest. */
  weightsHash: Sha256Hash;
  weightsHashSource: WeightsHashSource;
  /** e.g. `Q4_K_M`; absent when the deployment does not report one. */
  quantization?: string;
  /** Context window in tokens, as configured on the server. */
  contextLength: number;
  /**
   * `json-schema-grammar` when the server constrains decoding to the supplied
   * JSON Schema (llama.cpp grammars, Ollama `format`, OpenAI `json_schema`);
   * `scripted` for the deterministic double.
   */
  toolCallingMode: 'json-schema-grammar' | 'scripted';
}

// ---------------------------------------------------------------------------
// `modelRef` grammar (SPEC §11.1 `babyA.modelRef`)
// ---------------------------------------------------------------------------

/**
 * `RunConfig.babyA/babyB.modelRef` for this track is exactly
 * `<modelId>@<weightsHash>`, e.g.
 * `qwen2.5-3b-instruct-q4_k_m@sha256:0f1e…`. It is a pre-registered claim
 * about which weights ran, so `FrozenLlmAdapter.init` refuses a run whose
 * configured `modelRef` does not equal the one derived from the client the
 * adapter was actually handed (ALD-044 criterion 1).
 */
export const MODEL_REF_SEPARATOR = '@';

/** The reference `modelRef` namespace of the conformance harness. */
export const REFERENCE_MODEL_REF_PREFIX = 'reference:';

export function formatModelRef(
  modelId: string,
  weightsHash: Sha256Hash,
): string {
  return `${modelId}${MODEL_REF_SEPARATOR}${weightsHash}`;
}

export interface ParsedModelRef {
  modelId: string;
  weightsHash: Sha256Hash;
}

/** Split `<modelId>@<weightsHash>`; `undefined` when it is not that form. */
export function parseModelRef(modelRef: string): ParsedModelRef | undefined {
  const separator = modelRef.lastIndexOf(MODEL_REF_SEPARATOR);
  if (separator <= 0 || separator === modelRef.length - 1) {
    return undefined;
  }
  return {
    modelId: modelRef.slice(0, separator),
    weightsHash: modelRef.slice(separator + 1),
  };
}

// ---------------------------------------------------------------------------
// Tool schemas (SPEC §6.3)
// ---------------------------------------------------------------------------

/**
 * The two `AgentActionProposal` kinds the `frozen-llm` track produces under
 * the default `fixed-token` carrier (SPEC §9.1): one per role. Alternate
 * carriers (ALD-031) are not wired into this track yet; a turn that offers
 * only carrier kinds this track cannot produce raises `ToolUnavailableError`
 * rather than silently emitting something else.
 */
export const FROZEN_LLM_TOOL_KINDS = ['emit_symbols', 'select_object'] as const;

export type FrozenLlmToolKind = (typeof FROZEN_LLM_TOOL_KINDS)[number];

export function isFrozenLlmToolKind(value: string): value is FrozenLlmToolKind {
  return (FROZEN_LLM_TOOL_KINDS as readonly string[]).includes(value);
}

/** Minimal JSON Schema subset the tool definitions need. */
export type JsonSchemaNode =
  | { type: 'string'; enum?: string[] }
  | {
      type: 'array';
      items: JsonSchemaNode;
      minItems?: number;
      maxItems?: number;
    };

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required: string[];
  /** Always `false`: a tool call may carry no field the carrier does not define. */
  additionalProperties: false;
}

export interface ToolDefinition {
  /** The `AgentActionProposal.kind` this tool produces. */
  name: FrozenLlmToolKind;
  /** JSON Schema for the tool arguments, i.e. for `publicArtifact`. */
  parameters: JsonSchemaObject;
}

// ---------------------------------------------------------------------------
// Prompt inputs
// ---------------------------------------------------------------------------

/**
 * The turn's observation as the model sees it: opaque integers only.
 *
 * SPEC §10.1 forbids attribute *names* anywhere in an observation, so the rows
 * are the same numeric matrix `@ald/scenario` builds and nothing is relabelled
 * on the way into the prompt. `candidateRefs` are the Scenario Engine's opaque
 * references, passed through verbatim, because the receiver's tool call has to
 * name one of them exactly.
 */
export interface PromptObservation {
  /** Attribute-code rows in this Baby's own candidate order. */
  candidates: number[][];
  /** Sender view: the index of the target row. `null` in a receiver view. */
  targetIndex: number | null;
  /** Receiver view: opaque candidate references, verbatim, in row order. */
  candidateRefs?: string[];
  /**
   * Receiver view: the marks delivered on this turn, verbatim. Absent on a
   * sender turn; an empty array when nothing was delivered, which is the §9.6
   * `disabled` control rather than an error.
   */
  deliveredSymbols?: string[];
}

/** One symbol's private-memory summary as it appears in the prompt. */
export interface MemoryDigestEntry {
  /** Inventory symbol id, e.g. `S07`. */
  symbol: string;
  /** Turns this Baby emitted the symbol. */
  emitted: number;
  /** Turns this Baby received the symbol. */
  received: number;
  /** Co-occurrence distribution over object type codes, rounded. */
  typeCodeDistribution: number[];
  /** Highest-mass type code, or `-1` when the symbol has no evidence yet. */
  argmaxTypeCode: number;
  /** Mass on `argmaxTypeCode`. */
  confidence: number;
  /** Successful turns over turns involving the symbol. */
  successRate: number;
  /** Bounded, opaque evidence references (channel-event or proposal hashes). */
  evidenceRefs: string[];
  /** Current hypothesis reference, `hyp:<symbol>:<version>`. */
  hypothesisRef: string | null;
}

/**
 * The bounded private-memory digest (SPEC §6.1: this track "adapts only via
 * private memory/ledger"). It summarizes the adapter's own ledger drafts and
 * carries no prose, no attribute name, and no part of any prompt.
 */
export interface MemoryDigest {
  version: 'frozen-llm-memory-v1';
  /** Completed turns folded into the memory. */
  turns: number;
  /** Symbols tracked, before the digest bound was applied. */
  symbolsTracked: number;
  /** Highest-evidence entries first; at most `maxDigestEntries` of them. */
  entries: MemoryDigestEntry[];
}

// ---------------------------------------------------------------------------
// One constrained completion
// ---------------------------------------------------------------------------

export interface ConstrainedCompletionRequest {
  /**
   * The frozen learner-contract body, verbatim (SPEC §6.4/§6.6: the v1
   * contract text is used as-is; the adapter never edits or extends it).
   */
  systemPrompt: string;
  memoryDigest: MemoryDigest;
  observation: PromptObservation;
  /** Exactly the tools available this turn (SPEC §6.3). */
  tools: ToolDefinition[];
  /** Hard cap on generated tokens. */
  maxOutputTokens: number;
  /** Hard wall-clock cap; the adapter also enforces it (SPEC §8.3). */
  timeBudgetMs: number;
  /** Deterministic sampling seed derived from the Baby's private seed. */
  samplingSeed: number;
  /** Sampling temperature; `0` for greedy decoding. */
  temperature: number;
}

/**
 * What the model produced. `raw` is the assistant message content exactly as
 * the model emitted it (empty string when the model emitted only a tool call);
 * `toolCall` is present only when the constrained decoder produced one.
 * Neither is sanitized.
 */
export interface ConstrainedCompletionResponse {
  raw: string;
  toolCall?: { name: string; arguments?: unknown };
  finishReason: 'tool-call' | 'stop' | 'length';
}

export const ConstrainedCompletionResponseSchema = z
  .object({
    raw: z.string(),
    toolCall: z
      .object({ name: z.string(), arguments: z.unknown() })
      .strict()
      .optional(),
    finishReason: z.enum(['tool-call', 'stop', 'length']),
  })
  .strict();

/**
 * Validate whatever a client returned before the adapter reads it. A client is
 * an operator-supplied component; a malformed return value is an adapter
 * fault, and the error carries only the shape failure, never the value.
 */
export function parseCompletionResponse(
  value: unknown,
): ConstrainedCompletionResponse {
  const parsed = ConstrainedCompletionResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new LocalModelResponseError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.code}`)
        .join('; '),
    );
  }
  return parsed.data as ConstrainedCompletionResponse;
}

/**
 * A locally deployed, frozen open-weight model with constrained tool calling
 * and no network access beyond its own loopback endpoint (SPEC §6.7).
 *
 * There is deliberately no `train`, `update`, or `fineTune` member: ALD-044
 * criterion 3 requires the track to expose no weight-update path, and the
 * absence is enforced structurally here as well as on the adapter.
 */
export interface LocalModelClient {
  describe(): LocalModelDescription;
  complete(
    request: ConstrainedCompletionRequest,
  ): Promise<ConstrainedCompletionResponse>;
}
