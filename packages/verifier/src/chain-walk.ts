/**
 * Stream chain walk (steps 2-5 of LEDGER-INTEGRITY-DESIGN.md §14).
 *
 * `validateChain` from `@ald/hashing` is the authoritative implementation and
 * is used unchanged for every stream whose previous-hash field is called
 * `previousEntryHash`. The `channel` stream is the one exception: SPEC §11.5
 * names its link field `previousChannelHash` (the Evidence Store reads it from
 * its own `previous_channel_hash` column), while `validateChain` looks only
 * for `previousEntryHash`.
 *
 * Rather than fake the field — which would change the event's canonical form
 * and therefore its entry hash — this module keeps every `validateChain`
 * result, removes the "previousEntryHash must be ..." complaint that the
 * naming difference produces, and runs the same link rule over the real field,
 * emitting the same `previous-hash-mismatch` / `malformed-event` codes. The
 * naming asymmetry is recorded as a contract deviation for ALD-008.
 */
import {
  isSha256Hash,
  validateChain,
  type ChainValidationOptions,
  type ChainValidationResult,
  type ChainViolation,
} from '@ald/hashing';
import { GENESIS_HASH, type EventStream } from '@ald/types';

import { readNumber } from './values.js';

/** Previous-hash field name of each stream (SPEC §11.4-§11.8). */
export const LINK_FIELDS: Record<EventStream, string> = {
  'baby-a-ledger': 'previousEntryHash',
  'baby-b-ledger': 'previousEntryHash',
  channel: 'previousChannelHash',
  affect: 'previousEntryHash',
  audit: 'previousEntryHash',
  turns: 'previousEntryHash',
  intervention: 'previousEntryHash',
};

const MISSING_LINK_CLAUSE = 'previousEntryHash must be sha256:<64 hex>';
const MALFORMED_PREFIX = /^(event at index \d+): (.*)$/u;

/** Drops the standard-link complaint from a malformed-event message. */
function withoutMissingLinkClause(
  violation: ChainViolation,
): ChainViolation | undefined {
  if (violation.code !== 'malformed-event') {
    return violation;
  }
  const match = MALFORMED_PREFIX.exec(violation.message);
  if (match === null) {
    return violation;
  }
  const prefix = match[1] ?? '';
  const clauses = (match[2] ?? '')
    .split('; ')
    .filter((clause) => clause !== MISSING_LINK_CLAUSE);
  if (clauses.length === 0) {
    return undefined;
  }
  return {
    ...violation,
    message: `${prefix}: ${clauses.join('; ')}`,
  };
}

/**
 * Validates one stream's chain, honouring the stream's own previous-hash
 * field name. Never throws.
 */
export function walkStream(
  stream: EventStream,
  events: readonly Record<string, unknown>[],
  options: ChainValidationOptions = {},
): ChainValidationResult {
  const result = validateChain(stream, events, options);
  const linkField = LINK_FIELDS[stream];
  if (linkField === 'previousEntryHash') {
    return result;
  }

  const violations: ChainViolation[] = [];
  for (const violation of result.violations) {
    const kept = withoutMissingLinkClause(violation);
    if (kept !== undefined) {
      violations.push(kept);
    }
  }

  let previous = GENESIS_HASH;
  events.forEach((event, index) => {
    const sequence = readNumber(event, 'sequence') ?? null;
    const link = event[linkField];
    if (!isSha256Hash(link)) {
      violations.push({
        sequence,
        code: 'malformed-event',
        message: `event at index ${String(index)}: ${linkField} must be sha256:<64 hex>`,
      });
    } else if (link !== previous) {
      violations.push({
        sequence,
        code: 'previous-hash-mismatch',
        message: `${linkField} ${link} does not match ${previous}`,
      });
    }
    const entryHash = event['entryHash'];
    if (isSha256Hash(entryHash)) {
      previous = entryHash;
    }
  });

  return {
    ok: violations.length === 0,
    size: result.size,
    lastEntryHash: result.lastEntryHash,
    violations,
  };
}
