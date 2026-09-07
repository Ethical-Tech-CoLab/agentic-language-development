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
 * First trusted-metadata key found anywhere inside `value`, or `undefined`.
 *
 * Only the matched key from {@link TRUSTED_METADATA_KEYS} is returned — never
 * a path or a value — so the result is safe to log and cannot echo attempted
 * content back to a caller.
 */
export function findTrustedMetadataKey(
  value: unknown,
): TrustedMetadataKey | undefined {
  if (Array.isArray(value)) {
    for (const element of value) {
      const found = findTrustedMetadataKey(element);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (TRUSTED_METADATA_SET.has(key)) {
      return key as TrustedMetadataKey;
    }
  }
  for (const nested of Object.values(value)) {
    const found = findTrustedMetadataKey(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * True when a string value appears anywhere inside `value`. Key names are not
 * considered: a numeric extra field is a schema violation, while a
 * string-valued one is a free-text carrier (SPEC §9.1).
 */
export function containsString(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((element) => containsString(element));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).some((nested) => containsString(nested));
}

/**
 * JSON-safe copy for hashing a rejected payload. The raw payload is never
 * stored (SPEC §9.4), only its domain-separated hash, so an unserializable
 * submission collapses to a fixed marker rather than failing the commit.
 */
export function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return { unserializable: true };
  }
}
