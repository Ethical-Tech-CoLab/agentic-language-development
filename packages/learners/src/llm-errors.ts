/**
 * Errors raised by the `frozen-llm` local-model client seam (BACKLOG ALD-044;
 * SPECIFICATION.md §6.7, §10.3).
 *
 * Every error carries a code from the closed {@link LOCAL_MODEL_ERROR_CODES}
 * union so the Nursery Controller can classify an adapter fault without
 * matching on message text, exactly as `errors.ts` does for the rest of this
 * package.
 *
 * Two rules hold for every message built here:
 *
 * - it never contains model output, prompt text, or any part of a rejected
 *   payload — SPEC §9.4 forbids storing attempted content, and §10.1 forbids a
 *   human-readable exception message reaching a Baby's context. Sizes, counts
 *   and codes only;
 * - it never contains an endpoint credential. The only endpoints this module
 *   accepts are loopback ones, which carry no credential by construction.
 *
 * These are *adapter faults*: the model was unreachable, timed out, or the
 * client returned something that is not a completion at all. A model *content*
 * problem — prose instead of a tool call, an off-inventory symbol, free text
 * alongside a valid call — is never an error here: it is forwarded to the
 * Symbol Gateway unsanitized so the §9.4 rejection framework records it
 * (EXPERIMENT-NOTEBOOK.md E10 "Prohibited attempts").
 */

/** Closed set of local-model client failure codes. */
export const LOCAL_MODEL_ERROR_CODES = [
  /** The configured endpoint is not a loopback address or unix socket. */
  'non-loopback-endpoint',
  /** The weights file could not be read or is empty. */
  'weights-file-unreadable',
  /** Neither a weights file nor a server-reported digest was available. */
  'weights-hash-unavailable',
  /** The endpoint could not be reached, or answered with a non-2xx status. */
  'model-transport-failure',
  /** No completion arrived within the turn's model time budget (SPEC §8.3). */
  'model-timeout',
  /** The client returned something that is not a well-formed completion. */
  'model-response-invalid',
  /** No tool this track can produce was offered for the turn (SPEC §6.3). */
  'tool-unavailable',
] as const;

export type LocalModelErrorCode = (typeof LOCAL_MODEL_ERROR_CODES)[number];

export function isLocalModelErrorCode(
  value: string,
): value is LocalModelErrorCode {
  return (LOCAL_MODEL_ERROR_CODES as readonly string[]).includes(value);
}

/** Base class: a local-model client fault, tagged with a closed code. */
export class LocalModelError extends Error {
  override name = 'LocalModelError';

  constructor(
    readonly code: LocalModelErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SPEC §10.3: "no direct network ... access from a Baby process/container
 * beyond the Gateway RPC". The `frozen-llm` adapter needs one local inference
 * endpoint, so this module admits exactly loopback addresses and unix sockets
 * and refuses everything else. There is no other network client in the
 * `frozen-llm` code path, and nothing here ever downloads weights.
 */
export class NonLoopbackEndpointError extends LocalModelError {
  override name = 'NonLoopbackEndpointError';

  constructor(readonly hostname: string) {
    super(
      'non-loopback-endpoint',
      `A frozen-llm endpoint must be loopback or a unix socket; refused host "${hostname}"`,
    );
  }
}

/** The GGUF (or other) weights file named by `weightsPath` is unusable. */
export class WeightsFileUnreadableError extends LocalModelError {
  override name = 'WeightsFileUnreadableError';

  constructor(readonly detail: string) {
    super('weights-file-unreadable', `Model weights are unreadable: ${detail}`);
  }
}

/**
 * ALD-044 criterion 1 requires the run to record the exact model and weight
 * hashes, so a client that can produce neither is refused at construction
 * rather than recording a placeholder.
 */
export class WeightsHashUnavailableError extends LocalModelError {
  override name = 'WeightsHashUnavailableError';

  constructor(readonly modelId: string) {
    super(
      'weights-hash-unavailable',
      `No weight hash is available for model "${modelId}": pass weightsPath or weightsHash, or use a server that reports a sha256 digest`,
    );
  }
}

/** The endpoint was unreachable or answered with a non-2xx status. */
export class LocalModelTransportError extends LocalModelError {
  override name = 'LocalModelTransportError';

  constructor(readonly status: number | null) {
    super(
      'model-transport-failure',
      status === null
        ? 'The local model endpoint could not be reached'
        : `The local model endpoint answered with status ${status}`,
    );
  }
}

/**
 * The model did not answer within this turn's model time budget. The Nursery
 * Controller's §8.3 deadline / §14.5 retry-then-pause path owns what happens
 * next; the adapter forwards nothing, because there is no output to forward.
 */
export class LocalModelTimeoutError extends LocalModelError {
  override name = 'LocalModelTimeoutError';

  constructor(readonly budgetMs: number) {
    super(
      'model-timeout',
      `No completion within the ${budgetMs} ms model time budget`,
    );
  }
}

/**
 * The client returned a value that is not a completion envelope — a transport
 * or client bug, not model content. The message records only how the shape
 * failed, never the value.
 */
export class LocalModelResponseError extends LocalModelError {
  override name = 'LocalModelResponseError';

  constructor(readonly detail: string) {
    super(
      'model-response-invalid',
      `The local model client returned a malformed completion: ${detail}`,
    );
  }
}

/** No `AgentActionProposal` kind this track can produce was offered. */
export class ToolUnavailableError extends LocalModelError {
  override name = 'ToolUnavailableError';

  constructor(readonly offered: readonly string[]) {
    super(
      'tool-unavailable',
      `None of the ${offered.length} offered action kind(s) is available to the frozen-llm track`,
    );
  }
}

export function isLocalModelError(value: unknown): value is LocalModelError {
  return value instanceof LocalModelError;
}
