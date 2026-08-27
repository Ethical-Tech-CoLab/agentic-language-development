import {
  UnsignedLedgerEventSchema,
  type UnsignedLedgerEvent,
} from '@ald/types';

import { canonicalizeJson, parseCanonicalJson } from './json-canonical.js';

export function serializeUnsignedLedgerEvent(
  event: UnsignedLedgerEvent,
): string {
  return canonicalizeJson(UnsignedLedgerEventSchema.parse(event));
}

export function deserializeUnsignedLedgerEvent(
  value: string,
): UnsignedLedgerEvent {
  return UnsignedLedgerEventSchema.parse(
    parseCanonicalJson<UnsignedLedgerEvent>(value),
  );
}

export { canonicalizeJson, parseCanonicalJson } from './json-canonical.js';
