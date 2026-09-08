/**
 * Bundle-attachment packaging for this package's readouts
 * (docs/evidence-bundle-format.md §10, `BundleAttachmentSchema` in
 * `@ald/types`).
 *
 * An attachment is a file under `analysis/` in the evidence bundle whose
 * `sha256` is the plain SHA-256 of its bytes — no domain separator, because a
 * third party hashes the file with any tool. This module produces the exact
 * bytes and that hash. It does not write anything: the bundle writer is the
 * integrator's, and binding an attachment to a chained evidence entry
 * (`boundBy`) is the runtime's, since only the runtime holds the entry hash.
 *
 * Two rules keep an attachment honest:
 *
 * 1. **A statistic that is undefined for the sample serializes as `null`.**
 *    RFC 8785 has no representation for `NaN` or `±Infinity`
 *    (`canonicalJson` rejects them outright), and substituting `0` for "no
 *    variance estimate exists" would turn a missing number into a claim.
 *    {@link toCanonicalJsonValue} therefore maps every non-finite number to
 *    `null` and records nothing else.
 * 2. **The attachment carries its own `analysisVersion`.** The kind
 *    (`intervention-suite`, `curriculum-transitions`, `drift-evaluation`, …)
 *    says what the file is; the version says which rules produced it.
 */
import { canonicalJson, encodeHash, sha256Bytes } from '@ald/hashing';
import type { Sha256Hash } from '@ald/types';

/** Attachment kinds this package produces (`BundleAttachmentSchema.kind`). */
export type InterventionAttachmentKind =
  | 'intervention-suite'
  | 'curriculum-transitions'
  | 'drift-evaluation'
  /** E14 repair and E50 replication readouts have no dedicated kind yet. */
  | 'other';

export interface AttachmentFile {
  readonly kind: InterventionAttachmentKind;
  readonly analysisVersion: string;
  /** Canonical (RFC 8785) bytes of the attachment, as a UTF-8 string. */
  readonly canonicalJson: string;
  /** Plain SHA-256 of those bytes; `BundleAttachmentSchema.sha256`. */
  readonly sha256: Sha256Hash;
  /** The value that was serialized, after non-finite numbers became `null`. */
  readonly value: unknown;
}

/**
 * Deep-convert a readout into a canonical-JSON-representable value:
 * non-finite numbers become `null`, `undefined` properties are dropped,
 * arrays and plain objects are rebuilt, and anything else is passed through
 * for `canonicalJson` to reject loudly.
 */
export function toCanonicalJsonValue(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((element) => toCanonicalJsonValue(element));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const property = record[key];
    if (property === undefined) {
      continue;
    }
    output[key] = toCanonicalJsonValue(property);
  }
  return output;
}

/** Plain SHA-256 of a UTF-8 string, as `sha256:<hex>` (no domain). */
export function fileSha256(text: string): Sha256Hash {
  return encodeHash(sha256Bytes(Buffer.from(text, 'utf8')));
}

/** Package one readout as bundle-attachment bytes plus its file hash. */
export function buildAttachment(input: {
  readonly kind: InterventionAttachmentKind;
  readonly analysisVersion: string;
  readonly value: unknown;
}): AttachmentFile {
  const value = toCanonicalJsonValue(input.value);
  const text = canonicalJson(value);
  return {
    kind: input.kind,
    analysisVersion: input.analysisVersion,
    canonicalJson: text,
    sha256: fileSha256(text),
    value,
  };
}
