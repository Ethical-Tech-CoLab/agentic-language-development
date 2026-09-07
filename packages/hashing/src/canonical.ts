/**
 * RFC 8785 (JCS) canonical JSON, the single serialization every hash in the
 * system is computed over (LEDGER §4; docs/evidence-bundle-format.md §1, §3).
 *
 * Because `entryHash` binds the canonical form and every exported `*.jsonl`
 * line *is* that canonical form, a value the serializer cannot represent must
 * never produce a hash: the alternatives are a signed entry whose content is
 * silently empty, or an evidence line no independent verifier can parse.
 * `canonicalize` v4 signals neither case — a `Map`, `Set`, `Buffer`, or class
 * instance serializes to `{}`, and a function-valued property is interpolated
 * as the bare token `undefined` — so {@link canonicalJson} validates the value
 * itself before serializing.
 */
import canonicalize from 'canonicalize';

/** Message prefix of every rejection thrown by {@link canonicalJson}. */
const REJECTION = 'Value cannot be represented as canonical JSON';

function reject(reason: string, path: string): never {
  throw new Error(`${REJECTION}: ${reason} at ${path === '' ? '<root>' : path}`);
}

function describe(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } })
    .constructor?.name;
  return typeof name === 'string' && name.length > 0
    ? `a non-plain object (${name})`
    : 'a non-plain object';
}

/**
 * Reject anything JSON cannot represent, before `canonicalize` can drop it or
 * emit a non-JSON token.
 *
 * Accepted: `null`, booleans, finite numbers, strings, plain `Array`s, and
 * objects whose prototype is `Object.prototype` or `null`.
 *
 * Rejected: `undefined` at the root, `bigint`, functions, symbols, `NaN`,
 * `±Infinity`, circular references, sparse arrays (see below), `Array`
 * subclasses, and every other non-plain object (`Map`, `Set`, `Date`,
 * `Buffer`, typed arrays, boxed primitives, class instances) — each of which
 * either loses its contents or produces invalid JSON.
 *
 * Two JSON/JCS semantics are deliberately preserved rather than rejected, and
 * are pinned by tests: an object property whose value is `undefined` is
 * **omitted** from the canonical form, and an *explicitly* `undefined` array
 * element becomes `null`. Both match `JSON.stringify`, so a caller reading the
 * canonical form back gets exactly what was hashed.
 *
 * An array *hole* is not the same case and is rejected: `canonicalize` v4
 * emits `[1,,2]` for `[1, , 2]` where `JSON.stringify` emits `[1,null,2]`, so
 * a hole would produce an evidence line that is not JSON at all.
 */
function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        reject(`the non-finite number ${String(value)}`, path);
      }
      return;
    case 'undefined':
      reject('undefined', path);
      break;
    case 'bigint':
      reject('a bigint', path);
      break;
    case 'function':
      reject('a function', path);
      break;
    case 'symbol':
      reject('a symbol', path);
      break;
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) {
    reject('a circular reference', path);
  }
  const prototype: unknown = Object.getPrototypeOf(object);
  seen.add(object);
  if (Array.isArray(object)) {
    if (prototype !== Array.prototype) {
      reject(describe(object), path);
    }
    const elements: readonly unknown[] = object;
    for (let index = 0; index < elements.length; index += 1) {
      // A hole serializes as an empty slot (`[1,,2]`), which is not JSON.
      if (!Object.hasOwn(elements, index)) {
        reject('an array hole', `${path}[${index}]`);
      }
      const element = elements[index];
      // An explicit `undefined` element canonicalizes to `null` (JSON
      // semantics), matching `JSON.stringify`.
      if (element !== undefined) {
        assertJsonValue(element, `${path}[${index}]`, seen);
      }
    }
  } else {
    if (prototype !== Object.prototype && prototype !== null) {
      reject(describe(object), path);
    }
    const record = object as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const property = record[key];
      // An `undefined` property is omitted from the canonical form (JCS).
      if (property !== undefined) {
        assertJsonValue(property, path === '' ? key : `${path}.${key}`, seen);
      }
    }
  }
  seen.delete(object);
}

/**
 * RFC 8785 (JCS) serialization. Throws for values JSON cannot represent —
 * see {@link assertJsonValue} for the exact accept/reject rules — so a hash
 * is never computed over a form that lost data or is not valid JSON
 * (docs/evidence-bundle-format.md §1, §3).
 */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, '', new Set<object>());
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new Error(REJECTION);
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
