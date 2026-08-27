import canonicalize from 'canonicalize';

export function canonicalizeJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new Error('Value cannot be represented as canonical JSON');
  }
  return serialized;
}

export function parseCanonicalJson<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  if (canonicalizeJson(parsed) !== value) {
    throw new Error('Input is valid JSON but is not RFC 8785 canonical JSON');
  }
  return parsed as T;
}
