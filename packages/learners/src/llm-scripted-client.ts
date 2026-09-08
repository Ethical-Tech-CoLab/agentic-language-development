/**
 * `ScriptedModelClient` — the deterministic `LocalModelClient` double
 * (BACKLOG ALD-044).
 *
 * It is a **test double, not a model**. Its `describe()` reports
 * `weightsHashSource: 'scripted-double'` and `toolCallingMode: 'scripted'`
 * precisely so that nothing downstream can mistake a run driven by it for a
 * run of a real 3B-8B open-weight model: `FrozenLlmAdapter.init` refuses to
 * accept the conformance `reference:` `modelRef` namespace for any other kind
 * of client, and a research-grade deployment refuses the double outright.
 *
 * Two things it exists to do:
 *
 * 1. drive every seam of the adapter and of the Symbol Gateway deterministically
 *    — one behavior per prohibited-output category of EXPERIMENT-NOTEBOOK.md
 *    E10's "Prohibited attempts" metric, plus the compliant case;
 * 2. behave *consistently* in the compliant case, so a two-adapter turn
 *    completes end-to-end (ALD-044 criterion 2) without any learning: the
 *    scripted naming function `f(attributeRow) → symbol` is shared by both
 *    roles, so the receiver can invert it. Any success rate that produces is a
 *    property of the double and is never a finding about model behavior.
 *
 * The double reads nothing but its request. It records every request it was
 * given so a test can assert what the adapter put in the prompt (the frozen
 * contract text verbatim, an opaque numeric observation, the memory digest,
 * and JSON Schemas for exactly the offered tools).
 */
import { SeededPrng, domainHash } from '@ald/hashing';

import {
  type ConstrainedCompletionRequest,
  type ConstrainedCompletionResponse,
  type LocalModelClient,
  type LocalModelDescription,
  type ToolDefinition,
} from './llm-client.js';

/** Domain separator for the double's stand-in weight hash. */
const SCRIPTED_WEIGHTS_DOMAIN = 'dtsf-scripted-frozen-llm-v1';

/**
 * The double has no weights, so its "weight hash" is the digest of a fixed
 * label. It is recorded with `weightsHashSource: 'scripted-double'`, which is
 * what marks the provenance as a stand-in rather than a measured file.
 */
export const SCRIPTED_WEIGHTS_HASH = domainHash(
  SCRIPTED_WEIGHTS_DOMAIN,
  'no-weights',
);

/**
 * One prohibited-output (or compliant) category. Every category except
 * `valid-tool-call` is a violation the adapter forwards unsanitized so the
 * Gateway's §9.4 framework records it.
 */
export const SCRIPTED_BEHAVIORS = [
  /** A schema-clean tool call using in-inventory marks. */
  'valid-tool-call',
  /** A clean tool call with an assistant message riding alongside it. */
  'tool-call-with-free-text',
  /** Prose and no tool call at all. */
  'prose-only',
  /** A tool call whose arguments are an unparsed JSON fragment. */
  'malformed-json',
  /** More marks than the run's cap allows. */
  'oversized-payload',
  /** A token-shaped mark that is not in the declared inventory. */
  'off-inventory-symbol',
  /** A clean mark list plus an extra field inside `publicArtifact`. */
  'extra-artifact-field',
  /** A tool call for a carrier family this run does not offer. */
  'wrong-carrier-kind',
  /** An empty completion: no tool call, no text. */
  'empty-output',
  /** No completion within the request's time budget. */
  'timeout',
] as const;

export type ScriptedBehavior = (typeof SCRIPTED_BEHAVIORS)[number];

export interface ScriptedModelClientOptions {
  /** Fixed behavior for every call; default `valid-tool-call`. */
  behavior?: ScriptedBehavior;
  /** Behaviors cycled by call index; overrides `behavior` when present. */
  behaviors?: readonly ScriptedBehavior[];
  /** Full control over the behavior of each call; overrides both above. */
  behaviorFor?: (
    request: ConstrainedCompletionRequest,
    callIndex: number,
  ) => ScriptedBehavior;
  /** Reported `modelId`; default `scripted-frozen-llm`. */
  modelId?: string;
  /** Reported `weightsHash`; default {@link SCRIPTED_WEIGHTS_HASH}. */
  weightsHash?: string;
  /** Reported context window; default `8192`. */
  contextLength?: number;
  /**
   * Salt of the scripted naming function, so two doubles can be given
   * different (still deterministic) conventions.
   */
  namingSalt?: number;
  /**
   * The run's mark inventory. A receiver turn offers only `select_object`, so
   * the inventory is not in the request; without it the double falls back to a
   * seeded uniform selection instead of inverting its naming function.
   */
  symbolInventory?: readonly string[];
  /** Extra milliseconds past the request budget the `timeout` behavior waits. */
  timeoutOvershootMs?: number;
}

/** 32-bit FNV-1a over a numeric row: the scripted naming function's core. */
function fnv1a(values: readonly number[], salt: number): number {
  let hash = 0x811c9dc5 ^ (salt >>> 0);
  for (const value of values) {
    let remaining = (value | 0) >>> 0;
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= remaining & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      remaining >>>= 8;
    }
  }
  return hash >>> 0;
}

function enumOf(tool: ToolDefinition, property: string): string[] {
  const node = tool.parameters.properties[property];
  if (node === undefined) {
    return [];
  }
  if (node.type === 'string') {
    return [...(node.enum ?? [])];
  }
  return node.items.type === 'string' ? [...(node.items.enum ?? [])] : [];
}

function maxItemsOf(tool: ToolDefinition, property: string): number {
  const node = tool.parameters.properties[property];
  return node !== undefined && node.type === 'array'
    ? (node.maxItems ?? 1)
    : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ScriptedModelClient implements LocalModelClient {
  /** Every request handed to this double, in call order. */
  readonly requests: ConstrainedCompletionRequest[] = [];

  private readonly description: LocalModelDescription;
  private readonly namingSalt: number;
  private readonly timeoutOvershootMs: number;
  private calls = 0;

  constructor(private readonly options: ScriptedModelClientOptions = {}) {
    this.description = {
      modelId: options.modelId ?? 'scripted-frozen-llm',
      weightsHash: options.weightsHash ?? SCRIPTED_WEIGHTS_HASH,
      weightsHashSource: 'scripted-double',
      contextLength: options.contextLength ?? 8_192,
      toolCallingMode: 'scripted',
    };
    this.namingSalt = options.namingSalt ?? 0;
    this.timeoutOvershootMs = options.timeoutOvershootMs ?? 20;
  }

  /** Completions produced so far. */
  get callCount(): number {
    return this.calls;
  }

  describe(): LocalModelDescription {
    return { ...this.description };
  }

  async complete(
    request: ConstrainedCompletionRequest,
  ): Promise<ConstrainedCompletionResponse> {
    const callIndex = this.calls;
    this.calls += 1;
    this.requests.push(request);
    const behavior = this.behaviorAt(request, callIndex);

    if (behavior === 'timeout') {
      await sleep(request.timeBudgetMs + this.timeoutOvershootMs);
      return { raw: '', finishReason: 'stop' };
    }
    return this.respond(request, behavior);
  }

  /** The mark this double names an attribute row with, for either role. */
  namingSymbolFor(
    attributes: readonly number[],
    inventory: readonly string[],
  ): string {
    const index = fnv1a(attributes, this.namingSalt) % inventory.length;
    return inventory[index] as string;
  }

  private behaviorAt(
    request: ConstrainedCompletionRequest,
    callIndex: number,
  ): ScriptedBehavior {
    if (this.options.behaviorFor !== undefined) {
      return this.options.behaviorFor(request, callIndex);
    }
    const cycle = this.options.behaviors;
    if (cycle !== undefined && cycle.length > 0) {
      return cycle[callIndex % cycle.length] as ScriptedBehavior;
    }
    return this.options.behavior ?? 'valid-tool-call';
  }

  private respond(
    request: ConstrainedCompletionRequest,
    behavior: ScriptedBehavior,
  ): ConstrainedCompletionResponse {
    const tool = request.tools[0] as ToolDefinition;

    switch (behavior) {
      case 'prose-only':
        return {
          raw: 'I think this mark should stand for the object on the left.',
          finishReason: 'stop',
        };
      case 'empty-output':
        return { raw: '   ', finishReason: 'stop' };
      case 'malformed-json':
        return {
          raw: '{"symbols": ["',
          toolCall: { name: tool.name, arguments: '{"symbols": ["' },
          finishReason: 'stop',
        };
      case 'wrong-carrier-kind':
        return {
          raw: '',
          toolCall: {
            name: 'emit_canvas',
            arguments: {
              strokes: [
                { startX: 1, startY: 1, endX: 4, endY: 9, width: 1 },
              ],
            },
          },
          finishReason: 'tool-call',
        };
      case 'tool-call-with-free-text':
        return {
          raw: 'Here is my choice, and I will keep using it from now on.',
          toolCall: { name: tool.name, arguments: this.cleanArgs(request, tool) },
          finishReason: 'tool-call',
        };
      case 'off-inventory-symbol':
        return {
          raw: '',
          toolCall: {
            name: tool.name,
            arguments:
              tool.name === 'emit_symbols'
                ? { symbols: ['ZZ9'] }
                : { objectRef: 'ZZ9' },
          },
          finishReason: 'tool-call',
        };
      case 'oversized-payload':
        return {
          raw: '',
          toolCall: {
            name: tool.name,
            arguments: this.oversizedArgs(request, tool),
          },
          finishReason: 'tool-call',
        };
      case 'extra-artifact-field':
        return {
          raw: '',
          toolCall: {
            name: tool.name,
            arguments: {
              ...this.cleanArgs(request, tool),
              annotationCode: 3,
            },
          },
          finishReason: 'tool-call',
        };
      case 'valid-tool-call':
      default:
        return {
          raw: '',
          toolCall: { name: tool.name, arguments: this.cleanArgs(request, tool) },
          finishReason: 'tool-call',
        };
    }
  }

  /**
   * The compliant arguments for this turn.
   *
   * Sender: the shared naming function of the target row. Receiver: the first
   * candidate whose row names one of the delivered marks under the same
   * function, falling back to a seeded uniform pick when no candidate matches
   * — which is what happens on a turn with no delivery (§9.6 `disabled`) or
   * before the partner uses the same convention.
   */
  private cleanArgs(
    request: ConstrainedCompletionRequest,
    tool: ToolDefinition,
  ): Record<string, unknown> {
    const prng = new SeededPrng(String(request.samplingSeed));

    if (tool.name === 'emit_symbols') {
      const inventory = enumOf(tool, 'symbols');
      const { candidates, targetIndex } = request.observation;
      const row = targetIndex === null ? undefined : candidates[targetIndex];
      const symbol =
        row === undefined
          ? (inventory[prng.nextInt(inventory.length)] as string)
          : this.namingSymbolFor(row, inventory);
      return { symbols: [symbol] };
    }

    const candidateRefs = enumOf(tool, 'objectRef');
    const delivered = new Set(request.observation.deliveredSymbols ?? []);
    const inventory = this.options.symbolInventory;
    if (delivered.size > 0 && inventory !== undefined && inventory.length > 0) {
      // Invert the shared naming function: the candidate whose row this double
      // would have named with one of the delivered marks. `symbolInventory` is
      // a constructor option because a receiver turn offers only
      // `select_object`, so the run's inventory is not in the request.
      for (let index = 0; index < request.observation.candidates.length; index += 1) {
        const row = request.observation.candidates[index];
        const ref = candidateRefs[index];
        if (row === undefined || ref === undefined) {
          continue;
        }
        if (delivered.has(this.namingSymbolFor(row, inventory))) {
          return { objectRef: ref };
        }
      }
    }
    return {
      objectRef: candidateRefs[prng.nextInt(candidateRefs.length)] as string,
    };
  }

  private oversizedArgs(
    request: ConstrainedCompletionRequest,
    tool: ToolDefinition,
  ): Record<string, unknown> {
    if (tool.name === 'emit_symbols') {
      const inventory = enumOf(tool, 'symbols');
      const cap = maxItemsOf(tool, 'symbols');
      const symbols: string[] = [];
      for (let index = 0; index < cap + 4; index += 1) {
        symbols.push(inventory[index % inventory.length] as string);
      }
      return { symbols };
    }
    const clean = this.cleanArgs(request, tool);
    return { objectRef: `${String(clean.objectRef)}-overlong-suffix` };
  }
}
