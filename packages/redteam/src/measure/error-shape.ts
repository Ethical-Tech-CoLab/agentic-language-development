/**
 * Error-shape measurement (SPECIFICATION.md §10.3 "normalized message
 * envelope size and error behavior"; ALD-040 criterion 1/2).
 *
 * The error channel is the crudest and most reliable side channel: if a
 * rejected turn's response body differs from another rejected turn's — a
 * different code, a different length, a different field order — the body
 * itself carries information out of the Gateway. §10.3 requires accepted and
 * rejected turns to be "externally indistinguishable" in envelope, so the
 * check here is byte equality of the response bodies, with **no
 * normalization applied by the measurement**: stripping whitespace or sorting
 * keys before comparing would hide exactly the difference being looked for.
 *
 * The measurement records body *hashes*, never bodies. A rejected payload's
 * content must not be copied into evidence (SPEC §13.6, §10.2), and an error
 * body under test may embed one.
 */
import { encodeHash, sha256Bytes } from '@ald/hashing';

import { RedTeamError } from '../errors.js';

export interface LabeledResponse {
  label: string;
  /** The response body exactly as it went on the wire. */
  body: string | Uint8Array;
}

export interface ErrorShapeGroup {
  /** SHA-256 of the body bytes; the body itself is never recorded. */
  bodyHash: string;
  byteLength: number;
  count: number;
  /** Labels that produced this exact body, sorted. */
  labels: string[];
}

export interface ErrorShapeMeasurement {
  totalResponses: number;
  /** Distinct bodies, byte-for-byte. One means fully normalized. */
  distinctBodies: number;
  distinctByteLengths: number[];
  /** True when every response body is byte-identical. */
  identical: boolean;
  /** True when every body has the same length (weaker than `identical`). */
  constantLength: boolean;
  groups: ErrorShapeGroup[];
  /** Labels whose responses are not all the same body, sorted. */
  labelsWithVariation: string[];
  /**
   * Distinct bodies observed *across* labels: greater than one means the
   * label (accepted vs rejected, or one rejection reason vs another) is
   * recoverable from the body alone.
   */
  bodiesDistinguishLabels: boolean;
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

/**
 * Group responses by exact body bytes and report whether the grouping leaks
 * the label. Nothing is stripped, trimmed, sorted, or canonicalized first.
 */
export function measureErrorShape(
  responses: readonly LabeledResponse[],
): ErrorShapeMeasurement {
  if (responses.length === 0) {
    throw new RedTeamError('empty-sample', 'an error-shape measurement needs responses');
  }
  const groups = new Map<string, { byteLength: number; labels: string[]; count: number }>();
  const bodiesByLabel = new Map<string, Set<string>>();
  for (const response of responses) {
    const bytes = toBytes(response.body);
    const bodyHash = encodeHash(sha256Bytes(bytes));
    const existing = groups.get(bodyHash);
    if (existing === undefined) {
      groups.set(bodyHash, {
        byteLength: bytes.byteLength,
        labels: [response.label],
        count: 1,
      });
    } else {
      existing.count += 1;
      if (!existing.labels.includes(response.label)) {
        existing.labels.push(response.label);
      }
    }
    const labelBodies = bodiesByLabel.get(response.label);
    if (labelBodies === undefined) {
      bodiesByLabel.set(response.label, new Set([bodyHash]));
    } else {
      labelBodies.add(bodyHash);
    }
  }
  const ordered = [...groups.entries()]
    .map(([bodyHash, group]) => ({
      bodyHash,
      byteLength: group.byteLength,
      count: group.count,
      labels: [...group.labels].sort(),
    }))
    .sort((left, right) => (left.bodyHash < right.bodyHash ? -1 : 1));
  const distinctByteLengths = [...new Set(ordered.map((group) => group.byteLength))].sort(
    (left, right) => left - right,
  );
  const labelsWithVariation = [...bodiesByLabel.entries()]
    .filter(([, bodies]) => bodies.size > 1)
    .map(([label]) => label)
    .sort();

  return {
    totalResponses: responses.length,
    distinctBodies: ordered.length,
    distinctByteLengths,
    identical: ordered.length === 1,
    constantLength: distinctByteLengths.length === 1,
    groups: ordered,
    labelsWithVariation,
    bodiesDistinguishLabels: ordered.length > 1,
  };
}

export interface ErrorShapeTolerance {
  /** Require every body to be byte-identical. Default true. */
  requireIdentical?: boolean;
  /** Require at least a constant body length. Default true. */
  requireConstantLength?: boolean;
}

export interface ErrorShapeDecision {
  withinTolerance: boolean;
  violations: Array<'bodies-differ' | 'lengths-differ' | 'label-recoverable'>;
}

/** Automated pass/fail for the error channel (ALD-067 criterion 2). */
export function errorShapeWithinTolerance(
  measurement: ErrorShapeMeasurement,
  tolerance: ErrorShapeTolerance = {},
): ErrorShapeDecision {
  const requireIdentical = tolerance.requireIdentical ?? true;
  const requireConstantLength = tolerance.requireConstantLength ?? true;
  const violations: ErrorShapeDecision['violations'] = [];
  if (requireIdentical && !measurement.identical) {
    violations.push('bodies-differ');
  }
  if (requireConstantLength && !measurement.constantLength) {
    violations.push('lengths-differ');
  }
  if (measurement.bodiesDistinguishLabels && requireIdentical) {
    violations.push('label-recoverable');
  }
  return { withinTolerance: violations.length === 0, violations };
}
