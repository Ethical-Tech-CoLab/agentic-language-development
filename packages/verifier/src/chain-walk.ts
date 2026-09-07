/**
 * Stream chain walk (steps 2-5 of LEDGER-INTEGRITY-DESIGN.md §14).
 *
 * `validateChain` from `@ald/hashing` is the authoritative implementation and
 * honours each stream's own previous-hash field name (`previousChannelHash`
 * for the channel transcript, SPEC §11.5; `previousEntryHash` elsewhere).
 * This module is kept as the verifier's single entry point for chain walks so
 * the report layer has one place to hook stream-specific handling.
 */
import {
  LINK_FIELDS,
  validateChain,
  type ChainValidationOptions,
  type ChainValidationResult,
} from '@ald/hashing';
import type { EventStream } from '@ald/types';

export { LINK_FIELDS };

/** Validates one stream's chain. Never throws. */
export function walkStream(
  stream: EventStream,
  events: readonly Record<string, unknown>[],
  options: ChainValidationOptions = {},
): ChainValidationResult {
  return validateChain(stream, events, options);
}
