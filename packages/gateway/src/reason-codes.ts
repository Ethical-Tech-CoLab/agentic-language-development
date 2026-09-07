/**
 * The closed set of Gateway rejection reason codes (SPECIFICATION.md §9.4,
 * ALD-034).
 *
 * A rejection reveals *nothing* about the attempted content: a
 * `channel.rejected` event carries only `reasonCode` and a domain-separated
 * hash of the rejected payload, and the value returned to the caller carries
 * the same two fields plus counters. Every code below is therefore a bare
 * enum string with no interpolated payload text
 * (EXPERIMENT-NOTEBOOK.md E01).
 *
 * `invalid-envelope`, `unexpected-artifact-field`, `missing-interpretation`,
 * `payload-too-complex` and `timeout` are implementation-defined codes; the
 * remainder are named in SPECIFICATION.md §9.1/§9.4 or in the
 * ALD-030/ALD-034/ALD-035 acceptance criteria.
 */
export const GATEWAY_REASON_CODES = [
  /** The submission is not a well-formed §11.3 envelope. */
  'invalid-envelope',
  /** SPEC §11.3: the Baby supplied a field only the Gateway may set. */
  'trusted-metadata-present',
  /** SPEC §8.1 step 2: the required `intention.recorded` draft is absent or invalid. */
  'missing-intention',
  /**
   * SPEC §9.4: the raw submission's nesting depth or node count exceeds the
   * Gateway's structural complexity budget (inspect.ts `ComplexityBudget`).
   * Checked before any other recursive inspection or canonical hashing, so a
   * hostile or malformed adapter cannot escape the §9.4 rejection counter by
   * exhausting the call stack instead of failing a shape check.
   */
  'payload-too-complex',
  /** SPEC §8.2: the receiver draft is not a valid `interpretation.recorded` event. */
  'missing-interpretation',
  /** SPEC §9.6: the proposal kind is not offered by the run's carrier. */
  'carrier-mismatch',
  /** SPEC §9.1: the public artifact carries a field the carrier does not define. */
  'unexpected-artifact-field',
  /** SPEC §9.1: free text, prose, URLs, or non-inventory code points appeared. */
  'free-text-present',
  /** SPEC §9.1: allowlist violation — the symbol is not in the declared inventory. */
  'symbol-not-in-inventory',
  /** SPEC §9.1: a carrier message must contain at least one mark. */
  'empty-message',
  /** SPEC §9.1: over `maxSymbolsPerMessage` (absolute ceiling 16). */
  'message-too-long',
  /** SPEC §9.1: over `maxSymbolRepeats` consecutive identical symbols. */
  'symbol-repeat-limit',
  /** SPEC §11.3: the echoed `channelEventHash` does not match the recorded delivery. */
  'interpretation-hash-mismatch',
  /** SPEC §8.3: the turn response budget elapsed; the turn is forfeited. */
  'timeout',
] as const;

export type GatewayReasonCode = (typeof GATEWAY_REASON_CODES)[number];

export function isGatewayReasonCode(value: string): value is GatewayReasonCode {
  return (GATEWAY_REASON_CODES as readonly string[]).includes(value);
}
