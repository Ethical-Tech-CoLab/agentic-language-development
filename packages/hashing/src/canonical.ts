import canonicalize from 'canonicalize';

/** RFC 8785 (JCS) serialization. Throws for values JSON cannot represent. */
export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new Error('Value cannot be represented as canonical JSON');
  }
  return serialized;
}

/** Parse JSON and require that it is already in canonical form. */
export function parseCanonicalJson<T = unknown>(text: string): T {
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) {
    throw new Error('Input is valid JSON but is not RFC 8785 canonical JSON');
  }
  return parsed as T;
}
