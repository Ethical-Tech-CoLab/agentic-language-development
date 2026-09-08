/**
 * Tool-schema construction and model-output classification for the
 * `frozen-llm` track (BACKLOG ALD-044; SPECIFICATION.md §6.3, §9.1, §9.4,
 * §11.3).
 *
 * Two jobs, both deliberately narrow:
 *
 * 1. **Tool schemas.** SPEC §6.3: "a Baby may act only through the tools the
 *    runtime offers it on this turn", and "exactly one of `emit_symbols` or
 *    the selected alternate-carrier tool is available per run". So the schema
 *    handed to the model is built from `TurnBudget.availableActions` and from
 *    the run's own inventory and length cap — the model is *shown* the
 *    allowlist rather than being trusted to remember it.
 *
 * 2. **Classification, not sanitization.** SPEC §9.4 makes every rejection
 *    evidence, and EXPERIMENT-NOTEBOOK.md E10 measures "Prohibited attempts".
 *    An adapter that quietly repaired a bad completion would erase that
 *    measurement and would report a compliance the model never achieved. So
 *    the classification below decides *what kind* of violation a completion
 *    is, and the proposal builder forwards the model's own arguments object
 *    verbatim to the Symbol Gateway, which judges it under §9.1 and records a
 *    `channel.rejected` event carrying a hash and a reason code only.
 *
 * The full mapping from completion shape to the Gateway's reason code is:
 *
 * | completion | forwarded proposal | Gateway outcome |
 * |---|---|---|
 * | tool call, clean args, in-inventory symbols | `{kind, publicArtifact}` | accepted |
 * | tool call + assistant text | `{kind, publicArtifact, freeText}` | `free-text-present` |
 * | assistant text, no tool call | `{kind, publicArtifact: {}, freeText}` | `free-text-present` |
 * | tool call whose args are not an object | the raw text as the proposal | `invalid-envelope` |
 * | no tool call and no text | the raw text as the proposal | `invalid-envelope` |
 * | tool call for another carrier's kind | `{kind, publicArtifact}` | `carrier-mismatch` |
 * | symbol outside the inventory but token-shaped | `{kind, publicArtifact}` | `symbol-not-in-inventory` |
 * | symbol that is prose | `{kind, publicArtifact}` | `free-text-present` |
 * | more symbols than the cap | `{kind, publicArtifact}` | `message-too-long` |
 * | extra key inside `publicArtifact` | `{kind, publicArtifact}` | `unexpected-artifact-field` |
 *
 * The last four rows need no special handling here: the arguments object is
 * forwarded unchanged and `fixedTokenModule.validate` reaches the row's code
 * on its own. `packages/learners/__tests__/frozen-llm-gateway.test.ts` runs
 * every row through `SymbolGatewayImpl` and asserts the code.
 */
import { z } from 'zod';

import type { TurnBudget } from '@ald/types';

import { ToolUnavailableError } from './llm-errors.js';
import {
  isFrozenLlmToolKind,
  type ConstrainedCompletionResponse,
  type FrozenLlmToolKind,
  type JsonSchemaObject,
  type ToolDefinition,
} from './llm-client.js';

/**
 * SPEC §11.3 caps `symbols` at 16 entries and the Gateway's absolute ceiling
 * is the same; a run's own `maxSymbolsPerMessage` is usually lower. The schema
 * shows the model the *run's* cap, so a compliant model cannot exceed it.
 */
export interface ToolSchemaInputs {
  symbolInventory: readonly string[];
  maxSymbolsPerMessage: number;
  candidateRefs?: readonly string[];
}

function emitSymbolsSchema(inputs: ToolSchemaInputs): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string', enum: [...inputs.symbolInventory] },
        minItems: 1,
        maxItems: inputs.maxSymbolsPerMessage,
      },
    },
    required: ['symbols'],
    additionalProperties: false,
  };
}

function selectObjectSchema(inputs: ToolSchemaInputs): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      objectRef: { type: 'string', enum: [...(inputs.candidateRefs ?? [])] },
    },
    required: ['objectRef'],
    additionalProperties: false,
  };
}

/**
 * The tools available on this turn, in `availableActions` order. Kinds this
 * track cannot produce are dropped rather than approximated; if that leaves
 * nothing, the turn is an adapter fault (`ToolUnavailableError`) instead of a
 * guess, because SPEC §6.1 forbids silently substituting another behavior.
 */
export function buildToolDefinitions(
  turnBudget: TurnBudget,
  inputs: ToolSchemaInputs,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const kind of turnBudget.availableActions) {
    if (!isFrozenLlmToolKind(kind)) {
      continue;
    }
    if (kind === 'emit_symbols') {
      tools.push({ name: kind, parameters: emitSymbolsSchema(inputs) });
    } else {
      tools.push({ name: kind, parameters: selectObjectSchema(inputs) });
    }
  }
  if (tools.length === 0) {
    throw new ToolUnavailableError([...turnBudget.availableActions]);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Strict shapes for a *clean* tool call. `.strict()` is what makes an extra
 * key a violation rather than something the parse quietly drops (the same
 * hazard `conformance.ts` documents for `z.object().parse`), and the strict
 * parse is used only to *classify*: whichever way it goes, the model's own
 * arguments object is what gets forwarded.
 */
const CleanEmitSymbolsArgsSchema = z
  .object({ symbols: z.array(z.string()).min(1) })
  .strict();

const CleanSelectObjectArgsSchema = z
  .object({ objectRef: z.string().min(1) })
  .strict();

const CLEAN_ARGS_SCHEMAS: Record<
  FrozenLlmToolKind,
  typeof CleanEmitSymbolsArgsSchema | typeof CleanSelectObjectArgsSchema
> = {
  emit_symbols: CleanEmitSymbolsArgsSchema,
  select_object: CleanSelectObjectArgsSchema,
};

/**
 * Short, opaque classification codes. They are written into the private
 * intention event, so they must survive the SPEC §11.4 agent-native content
 * rule: each is a hyphenated code under 24 characters with no human-language
 * token and no closed-class function word, so the §10.1 scan reads it as an
 * identifier rather than as prose.
 */
export const MODEL_OUTPUT_CLASSES = [
  /** A tool call whose arguments match the strict shape, nothing else. */
  'tool-call',
  /** A tool call plus assistant text: SPEC §6.3's rejected free text. */
  'tool-call-text',
  /** Assistant text and no tool call at all. */
  'text-only',
  /** A tool call for a kind this run's carrier does not offer. */
  'kind-mismatch',
  /** Arguments that are not an object, or an empty completion. */
  'unparsed',
] as const;

export type ModelOutputClass = (typeof MODEL_OUTPUT_CLASSES)[number];

export type ClassifiedModelOutput =
  | {
      outputClass: 'tool-call' | 'tool-call-text';
      /** A kind this track produces and the turn offered. */
      toolName: FrozenLlmToolKind;
      /** The model's own arguments object, unmodified. */
      args: Record<string, unknown>;
      /** Assistant text riding alongside the call; `null` for `tool-call`. */
      freeText: string | null;
      /** True when `args` matched the strict clean shape. */
      argsClean: boolean;
    }
  | {
      outputClass: 'kind-mismatch';
      /** The kind the model named; not offered this turn. */
      toolName: string;
      args: Record<string, unknown>;
      freeText: string | null;
    }
  | { outputClass: 'text-only'; freeText: string }
  | { outputClass: 'unparsed'; raw: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

/**
 * Decide what the model actually did. No repair, no fallback, no default tool
 * call: an ambiguous completion is classified as the violation it is.
 */
export function classifyModelOutput(
  response: ConstrainedCompletionResponse,
  offered: readonly ToolDefinition[],
): ClassifiedModelOutput {
  const text = response.raw.trim();
  const freeText = text.length > 0 ? response.raw : null;
  const call = response.toolCall;

  if (call === undefined) {
    return freeText === null
      ? { outputClass: 'unparsed', raw: response.raw }
      : { outputClass: 'text-only', freeText };
  }

  if (!isPlainObject(call.arguments)) {
    // A tool call whose arguments are a string, a number, or absent is not a
    // tool call the §11.3 envelope can carry; the raw completion goes forward
    // so the rejection framework hashes it (`invalid-envelope`).
    return { outputClass: 'unparsed', raw: response.raw };
  }
  const args = call.arguments;

  const isOffered = offered.some((tool) => tool.name === call.name);
  if (!isOffered) {
    if (!isFrozenLlmToolKind(call.name) && !isKnownProposalKind(call.name)) {
      return { outputClass: 'unparsed', raw: response.raw };
    }
    return {
      outputClass: 'kind-mismatch',
      toolName: call.name,
      args,
      freeText,
    };
  }

  const toolName = call.name as FrozenLlmToolKind;
  const argsClean = CLEAN_ARGS_SCHEMAS[toolName].safeParse(args).success;
  return {
    outputClass: freeText === null ? 'tool-call' : 'tool-call-text',
    toolName,
    args,
    freeText,
    argsClean,
  };
}

/**
 * The SPEC §11.3 `AgentActionProposal.kind` union. A model that names one of
 * these but the run's carrier does not offer it is a carrier violation the
 * Gateway must see (`carrier-mismatch`); a model that names something else
 * entirely produced no tool call at all.
 */
const KNOWN_PROPOSAL_KINDS: readonly string[] = [
  'emit_symbols',
  'emit_glyphs',
  'emit_bitmap',
  'emit_canvas',
  'emit_tones',
  'select_object',
  'perform_action',
  'submit_affect',
];

function isKnownProposalKind(value: string): boolean {
  return KNOWN_PROPOSAL_KINDS.includes(value);
}

/**
 * The proposal-level field a violating completion's assistant text rides in.
 *
 * It is deliberately *not* inside `publicArtifact`: `fixedTokenModule.validate`
 * inspects proposal-level keys first, so an extra proposal field holding a
 * string reaches `free-text-present` — the code SPEC §9.1 names for "any
 * accompanying free text ... even when a valid tool call is also present"
 * (CONCEPT-IDEA.md §20.4). The Gateway stores only a hash of the whole
 * payload, so the text is never written to evidence, and it never crosses to
 * the other Baby because the proposal is rejected before delivery.
 */
export const FREE_TEXT_FIELD = 'freeText';

/**
 * What the adapter forwards. `unknown` rather than `TurnProposalEnvelope`'s
 * `proposal` type on purpose: a violating completion is not a valid
 * `AgentActionProposal`, and making it one would be the sanitization SPEC
 * §10.2 forbids ("never sanitized and passed through").
 */
export function buildForwardedProposal(
  classified: ClassifiedModelOutput,
  primaryTool: FrozenLlmToolKind,
): unknown {
  switch (classified.outputClass) {
    case 'tool-call':
      return { kind: classified.toolName, publicArtifact: classified.args };
    case 'tool-call-text':
      return {
        kind: classified.toolName,
        publicArtifact: classified.args,
        [FREE_TEXT_FIELD]: classified.freeText,
      };
    case 'kind-mismatch':
      return classified.freeText === null
        ? { kind: classified.toolName, publicArtifact: classified.args }
        : {
            kind: classified.toolName,
            publicArtifact: classified.args,
            [FREE_TEXT_FIELD]: classified.freeText,
          };
    case 'text-only':
      return {
        kind: primaryTool,
        publicArtifact: {},
        [FREE_TEXT_FIELD]: classified.freeText,
      };
    case 'unparsed':
      // Not an object at all: the rejection framework hashes the raw text.
      return classified.raw;
  }
}
