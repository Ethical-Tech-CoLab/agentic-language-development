/**
 * Defensive readers for fields of an already-parsed evidence event.
 *
 * The verifier walks JSON that may have been tampered with, so every field
 * access has to tolerate a wrong type without throwing (LEDGER §14: report,
 * never crash). Hash comparisons are normalized because the event schemas of
 * SPECIFICATION.md §11.4-§11.6 accept both `sha256:<hex>` and the bare hex
 * form while the integrity schemas of §11.7 onwards require the prefix.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** Lowercased `sha256:<hex>` form, or `undefined` for a non-hash value. */
export function normalizeHash(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const lowered = value.toLowerCase();
  const withPrefix = lowered.startsWith('sha256:') ? lowered : `sha256:${lowered}`;
  return /^sha256:[a-f0-9]{64}$/u.test(withPrefix) ? withPrefix : undefined;
}
