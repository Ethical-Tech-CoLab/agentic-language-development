import { createHash } from 'node:crypto';

import {
  HASH_DOMAINS,
  SIGNATURE_FIELDS,
  STREAM_HASH_DOMAIN,
  type EventStream,
} from '@ald/types';

import { canonicalJson } from './canonical.js';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type HashSeparator = 0x00 | 0x01;

export function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function sha256Bytes(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

/** Encode a 32-byte digest as `sha256:<64 lowercase hex>`. */
export function encodeHash(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new Error('SHA-256 digest must be exactly 32 bytes');
  }
  return `sha256:${Buffer.from(digest).toString('hex')}`;
}

/** Decode `sha256:<hex>` into its 32 raw bytes. */
export function decodeHash(hash: string): Buffer {
  if (!isSha256Hash(hash)) {
    throw new Error(
      `Invalid SHA-256 hash encoding: ${String(hash).slice(0, 80)}`,
    );
  }
  return Buffer.from(hash.slice('sha256:'.length), 'hex');
}

/** Big-endian unsigned 64-bit encoding used for Merkle leaf sequences. */
export function uint64BE(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('uint64 value must be a non-negative safe integer');
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

export function toBytes(payload: Uint8Array | string): Buffer {
  return typeof payload === 'string'
    ? Buffer.from(payload, 'utf8')
    : Buffer.from(payload);
}

/**
 * `SHA-256(utf8(domain) || separator || payload...)` encoded as `sha256:<hex>`.
 * Strings are UTF-8 encoded; byte arrays are used verbatim.
 */
export function domainHash(
  domain: string,
  payload: Array<Uint8Array | string> | Uint8Array | string,
  separator: HashSeparator = 0x00,
): string {
  const parts = Array.isArray(payload) ? payload : [payload];
  return encodeHash(
    sha256Bytes(
      Buffer.from(domain, 'utf8'),
      Buffer.from([separator]),
      ...parts.map(toBytes),
    ),
  );
}

/** Domain-separated hash of the RFC 8785 canonical form of `value`. */
export function hashCanonical(domain: string, value: unknown): string {
  return domainHash(domain, canonicalJson(value));
}

/** SPEC §9.2 content address for any delivered public artifact. */
export function hashCarrierMark(carrierMode: string, artifact: unknown): string {
  return domainHash(HASH_DOMAINS.carrierMark, [
    carrierMode,
    new Uint8Array([0]),
    canonicalJson(artifact),
  ]);
}

export function hashRunId(runId: string): string {
  return domainHash(HASH_DOMAINS.runId, runId);
}

/** Copy of `record` without the given top-level keys. */
export function omitFields<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const field of fields) {
    delete copy[field];
  }
  return copy;
}

/**
 * Recompute the entry hash of a (signed or unsigned) stream event by removing
 * `entryHash` and `writerSignature`, canonicalizing, and hashing under the
 * stream's domain. Used by writers to create hashes and by verifiers to check
 * them.
 */
export function computeEntryHash(
  stream: EventStream,
  event: Record<string, unknown>,
): string {
  return hashCanonical(
    STREAM_HASH_DOMAIN[stream],
    omitFields(event, SIGNATURE_FIELDS),
  );
}
