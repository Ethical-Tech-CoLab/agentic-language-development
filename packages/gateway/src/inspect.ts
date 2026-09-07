/**
 * Structural inspection helpers used by the Gateway boundary checks.
 *
 * All of these run against the *raw* submission, before any zod parse: zod
 * object schemas strip unknown keys, so a check that ran after parsing could
 * not see a Baby-supplied `runId` or a free-text field at all
 * (SPECIFICATION.md §11.3, ALD-035 criterion 1).
 */

/**
 * SPEC §11.3: fields the Gateway derives from the authenticated service
 * identity and authoritative run state. A proposal containing any of them at
 * any depth is rejected rather than sanitized, so a Baby can never influence
 * the trusted framing of its own message (CONCEPT-IDEA.md §9).
 */
export const TRUSTED_METADATA_KEYS = [
  'runId',
  'turn',
  'sender',
  'logicalSender',
  'sequence',
  'timestamp',
  'recordedAt',
  'hash',
  'entryHash',
  'previousHash',
  'previousEntryHash',
  'channelEventHash',
] as const;

export type TrustedMetadataKey = (typeof TRUSTED_METADATA_KEYS)[number];

const TRUSTED_METADATA_SET: ReadonlySet<string> = new Set(TRUSTED_METADATA_KEYS);

/**
 * SPEC §9.4: an explicit structural ceiling every recursive inspection below
 * enforces on Baby-controlled input.
 *
 * Without a bound, a payload nested (or wide) enough can exhaust the native
 * call stack — or overwhelm an unbounded canonicalizer downstream — before
 * any rejection reason is decided. That would let a hostile or
 * malfunctioning adapter escape both the intended reason code and the §9.4
 * consecutive-rejection counter by crashing the turn instead of producing a
 * committed `channel.rejected` event.
 */
export interface ComplexityBudget {
  /** Maximum nesting depth a value may reach; the root value is depth `0`. */
  readonly maxDepth: number;
  /** Maximum number of array elements / object property values visited in total. */
  readonly maxNodes: number;
}

/**
 * SPEC §9.4: the default budget applied at every Gateway boundary check. 32
 * levels and 10,000 nodes comfortably exceed any well-formed §9.1/§11.4
 * artifact or ledger draft while staying far below the point at which
 * traversal, JSON serialization, or canonicalization risk exhausting the
 * call stack.
 */
export const DEFAULT_COMPLEXITY_BUDGET: ComplexityBudget = {
  maxDepth: 32,
  maxNodes: 10_000,
};

/**
 * Thrown by the bounded helpers in this module when a value's nesting depth
 * or cumulative node count exceeds a {@link ComplexityBudget}. The Gateway
 * boundary (symbol-gateway.ts) catches this — or, more commonly, calls
 * {@link isWithinComplexityBudget} first — and commits a `payload-too-complex`
 * rejection (SPEC §9.4) instead of letting a `RangeError` unwind past the
 * rejection framework uncaught.
 */
export class PayloadTooComplexError extends Error {
  constructor(readonly budget: ComplexityBudget) {
    super(
      `payload exceeds the Gateway complexity budget (maxDepth=${budget.maxDepth}, maxNodes=${budget.maxNodes})`,
    );
    this.name = 'PayloadTooComplexError';
  }
}

/** A JSON object, as opposed to an array, a class instance, or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Throws {@link PayloadTooComplexError} the instant `depth` or `nodes` would
 * exceed `budget`. Every bounded traversal in this module checks this before
 * recursing one level deeper, so none of them can recurse past
 * `budget.maxDepth` regardless of how deeply (or widely) the caller's input
 * is nested — the check fires long before the native call stack could ever
 * be at risk (SPEC §9.4).
 */
function assertWithinBudget(
  depth: number,
  nodes: number,
  budget: ComplexityBudget,
): void {
  if (depth > budget.maxDepth || nodes > budget.maxNodes) {
    throw new PayloadTooComplexError(budget);
  }
}

/**
 * `true` when `value`'s nesting depth and total node count both stay within
 * `budget`, `false` otherwise. Never throws and never overflows the call
 * stack: recursion is capped at `budget.maxDepth + 1` frames by construction.
 *
 * This is the primary boundary guard (SPEC §9.4): the Gateway calls it on a
 * whole submission — proposal *and* `privateLedgerDraft` alike — before any
 * other recursive inspection or canonical hashing touches it, so a
 * complexity violation is always caught at the earliest possible point
 * rather than by whichever downstream routine happens to overflow first.
 */
export function isWithinComplexityBudget(
  value: unknown,
  budget: ComplexityBudget = DEFAULT_COMPLEXITY_BUDGET,
): boolean {
  const nodes = { count: 0 };
  const visit = (node: unknown, depth: number): void => {
    nodes.count += 1;
    assertWithinBudget(depth, nodes.count, budget);
    if (Array.isArray(node)) {
      for (const element of node) {
        visit(element, depth + 1);
      }
      return;
    }
    if (isPlainObject(node)) {
      for (const nested of Object.values(node)) {
        visit(nested, depth + 1);
      }
    }
  };
  try {
    visit(value, 0);
    return true;
  } catch (error) {
    if (error instanceof PayloadTooComplexError) {
      return false;
    }
    throw error;
  }
}

/**
 * First trusted-metadata key found anywhere inside `value`, or `undefined`.
 *
 * Only the matched key from {@link TRUSTED_METADATA_KEYS} is returned — never
 * a path or a value — so the result is safe to log and cannot echo attempted
 * content back to a caller.
 *
 * Bounded by `budget` (SPEC §9.4): this recurses over arbitrary
 * Baby-controlled structure, so it throws {@link PayloadTooComplexError}
 * rather than recursing until the native call stack is exhausted. Callers on
 * the Gateway boundary check {@link isWithinComplexityBudget} first, which
 * makes that throw unreachable in practice; it remains here as the recursive
 * inspection's own budget, not merely a precondition borrowed from the
 * caller.
 */
export function findTrustedMetadataKey(
  value: unknown,
  budget: ComplexityBudget = DEFAULT_COMPLEXITY_BUDGET,
): TrustedMetadataKey | undefined {
  const nodes = { count: 0 };
  const visit = (node: unknown, depth: number): TrustedMetadataKey | undefined => {
    nodes.count += 1;
    assertWithinBudget(depth, nodes.count, budget);

    if (Array.isArray(node)) {
      for (const element of node) {
        const found = visit(element, depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }

    if (!isPlainObject(node)) {
      return undefined;
    }

    for (const key of Object.keys(node)) {
      if (TRUSTED_METADATA_SET.has(key)) {
        return key as TrustedMetadataKey;
      }
    }
    for (const nested of Object.values(node)) {
      const found = visit(nested, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return visit(value, 0);
}

/**
 * True when a string value appears anywhere inside `value`. Key names are not
 * considered: a numeric extra field is a schema violation, while a
 * string-valued one is a free-text carrier (SPEC §9.1).
 *
 * Bounded by `budget` (SPEC §9.4) for the same reason as
 * {@link findTrustedMetadataKey}. In practice every call site inspects a
 * subtree of a value the Gateway boundary already ran through
 * {@link isWithinComplexityBudget}, so a subtree can never itself exceed the
 * budget; the bound here is defense in depth, not the primary guard.
 */
export function containsString(
  value: unknown,
  budget: ComplexityBudget = DEFAULT_COMPLEXITY_BUDGET,
): boolean {
  const nodes = { count: 0 };
  const visit = (node: unknown, depth: number): boolean => {
    nodes.count += 1;
    assertWithinBudget(depth, nodes.count, budget);
    if (typeof node === 'string') {
      return true;
    }
    if (Array.isArray(node)) {
      return node.some((element) => visit(element, depth + 1));
    }
    if (!isPlainObject(node)) {
      return false;
    }
    return Object.values(node).some((nested) => visit(nested, depth + 1));
  };
  return visit(value, 0);
}

/**
 * JSON-safe copy for hashing a rejected payload. The raw payload is never
 * stored (SPEC §9.4), only its domain-separated hash, so an unserializable
 * submission collapses to a fixed marker rather than failing the commit.
 *
 * Bounded by `budget` (SPEC §9.4): the canonicalizer that hashes the result
 * (`@ald/hashing`) has no depth limit of its own, so a payload nested or wide
 * enough to exceed the budget is replaced with a marker *before* it is ever
 * handed to `JSON.stringify` or canonicalization, rather than discovered only
 * after one of those recursors exhausts the call stack. Unlike
 * {@link findTrustedMetadataKey} and {@link containsString}, this never
 * throws — it is the last line of defense before hashing a rejection, so it
 * always returns something hashable.
 */
export function jsonSafe(
  value: unknown,
  budget: ComplexityBudget = DEFAULT_COMPLEXITY_BUDGET,
): unknown {
  if (!isWithinComplexityBudget(value, budget)) {
    return { tooComplex: true };
  }
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return { unserializable: true };
  }
}
