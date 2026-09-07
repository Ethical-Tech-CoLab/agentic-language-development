/**
 * Hash-chain construction and the chain-walk validator (ALD-008).
 *
 * Every event stream is an independent previous-hash chain whose sequences
 * start at `1` (LEDGER §4, §6). This module holds the two halves of that
 * rule: the small helpers a writer uses to link the next event onto a chain
 * head, and the validator an independent verifier uses to walk a chain and
 * report every deviation.
 *
 * The validator implements steps 1-5 of the independent-verification
 * procedure in LEDGER §14 (canonical JSON, run/baby/sequence consistency,
 * rebuilt entry hashes, previous-entry links, writer signatures) and is the
 * detector required by the LEDGER §17 acceptance tests for modified content,
 * changed sequence numbers, deleted, inserted, and reordered entries,
 * incorrect previous-entry hashes, and invalid writer signatures. Merkle,
 * checkpoint, and anchoring checks (steps 6-11) belong to `@ald/merkle`,
 * `@ald/checkpoint`, and `@ald/anchor`.
 */
import {
  GENESIS_HASH,
  STREAM_SIGNER,
  type ChainHead,
  type DomainSigner,
  type EventStream,
} from '@ald/types';

import { parseCanonicalJson } from './canonical.js';
import { verifyHashSignature } from './ed25519.js';
import { computeEntryHash, isSha256Hash } from './sha256.js';

/** Streams whose events carry a `writerSignature` (`intervention` does not). */
export type SignedEventStream = Exclude<EventStream, 'intervention'>;

/**
 * Integrity failure codes reported by {@link validateChain}. One code per
 * distinct rule so a verifier report can name the rule that failed rather
 * than a free-text reason.
 */
export type ChainViolationCode =
  /** The first event of the chain does not have `sequence: 1` (LEDGER §4). */
  | 'sequence-start'
  /** A sequence is not exactly one greater than its predecessor. */
  | 'sequence-gap'
  /** A sequence value repeats within the walked chain (LEDGER §15 fork). */
  | 'duplicate-sequence'
  /** `previousEntryHash` does not equal the preceding `entryHash`. */
  | 'previous-hash-mismatch'
  /** The recomputed entry hash differs from the stored `entryHash`. */
  | 'entry-hash-mismatch'
  /** A signed stream event has no `writerSignature`. */
  | 'signature-missing'
  /** `writerSignature` does not verify under the expected public key. */
  | 'signature-invalid'
  /** The event's `runId` differs from the run being verified. */
  | 'run-id-mismatch'
  /** The event's `babyId` differs from the ledger owner being verified. */
  | 'baby-id-mismatch'
  /** The event is not an object, or lacks usable chain fields. */
  | 'malformed-event';

export interface ChainViolation {
  /** The event's own `sequence`, or `null` when it is unusable. */
  sequence: number | null;
  code: ChainViolationCode;
  message: string;
}

export interface ChainValidationResult {
  ok: boolean;
  /** Number of events walked, comparable with `ChainHead.size`. */
  size: number;
  /** Head of the walked chain: the last usable `entryHash`, else genesis. */
  lastEntryHash: string;
  violations: ChainViolation[];
}

export interface ChainValidationOptions {
  /** When given, every event's `runId` must equal this value (LEDGER §14). */
  runId?: string;
  /** When given, `writerSignature` is verified against this public key. */
  publicKey?: string;
  /** When true, a signed-stream event without a signature is a violation. */
  requireSignatures?: boolean;
  /** When given, every event's `babyId` must equal this value (LEDGER §14). */
  babyId?: 'A' | 'B';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` for every stream except the unsigned `intervention` log. */
export function isSignedStream(stream: EventStream): stream is SignedEventStream {
  return Object.prototype.hasOwnProperty.call(STREAM_SIGNER, stream);
}

/**
 * Walk one stream's events in storage order and report every integrity
 * violation found. Never throws: malformed input is reported, not raised, so
 * a verifier can produce a complete report for a corrupted bundle.
 *
 * Checks are independent by design — a mutated event body is reported once as
 * `entry-hash-mismatch` and does not cascade into the link or signature
 * checks, because the stored `entryHash` (which the link and signature
 * commit to) is unchanged.
 */
/**
 * Name of the previous-hash link field in each stream's events. Every stream
 * uses `previousEntryHash` except the channel transcript, whose schema
 * (SPEC §11.5) names the link `previousChannelHash`.
 */
export const LINK_FIELDS: Record<EventStream, 'previousEntryHash' | 'previousChannelHash'> = {
  'baby-a-ledger': 'previousEntryHash',
  'baby-b-ledger': 'previousEntryHash',
  channel: 'previousChannelHash',
  affect: 'previousEntryHash',
  audit: 'previousEntryHash',
  turns: 'previousEntryHash',
  intervention: 'previousEntryHash',
};

export function linkFieldFor(stream: EventStream): 'previousEntryHash' | 'previousChannelHash' {
  return LINK_FIELDS[stream];
}

export function validateChain(
  stream: EventStream,
  events: readonly Record<string, unknown>[],
  options: ChainValidationOptions = {},
): ChainValidationResult {
  const violations: ChainViolation[] = [];
  const signed = isSignedStream(stream);
  const linkField = linkFieldFor(stream);
  const requireSignatures = options.requireSignatures ?? false;
  const seen = new Set<number>();
  let previousEntryHash = GENESIS_HASH;
  let expectedSequence = 1;

  const report = (
    sequence: number | null,
    code: ChainViolationCode,
    message: string,
  ): void => {
    violations.push({ sequence, code, message });
  };

  events.forEach((event, index) => {
    if (!isRecord(event)) {
      report(null, 'malformed-event', `event at index ${index} is not an object`);
      expectedSequence += 1;
      return;
    }

    const rawSequence = event['sequence'];
    const sequence =
      typeof rawSequence === 'number' &&
      Number.isSafeInteger(rawSequence) &&
      rawSequence > 0
        ? rawSequence
        : null;
    const entryHash = event['entryHash'];
    const linkHash = event[linkField];

    const malformed: string[] = [];
    if (sequence === null) {
      malformed.push('sequence must be a positive integer');
    }
    if (!isSha256Hash(entryHash)) {
      malformed.push('entryHash must be sha256:<64 hex>');
    }
    if (!isSha256Hash(linkHash)) {
      malformed.push(`${linkField} must be sha256:<64 hex>`);
    }
    if (malformed.length > 0) {
      report(
        sequence,
        'malformed-event',
        `event at index ${index}: ${malformed.join('; ')}`,
      );
    }

    if (options.runId !== undefined && event['runId'] !== options.runId) {
      report(
        sequence,
        'run-id-mismatch',
        `expected runId ${options.runId}, found ${String(event['runId'])}`,
      );
    }
    if (options.babyId !== undefined && event['babyId'] !== options.babyId) {
      report(
        sequence,
        'baby-id-mismatch',
        `expected babyId ${options.babyId}, found ${String(event['babyId'])}`,
      );
    }

    if (sequence === null) {
      expectedSequence += 1;
    } else {
      if (seen.has(sequence)) {
        report(
          sequence,
          'duplicate-sequence',
          `sequence ${sequence} appears more than once`,
        );
      } else if (index === 0 && sequence !== 1) {
        report(
          sequence,
          'sequence-start',
          `chain must start at sequence 1, found ${sequence}`,
        );
      } else if (sequence !== expectedSequence) {
        report(
          sequence,
          'sequence-gap',
          `expected sequence ${expectedSequence}, found ${sequence}`,
        );
      }
      seen.add(sequence);
      // Resynchronize so a single break reports once instead of cascading.
      expectedSequence = sequence + 1;
    }

    if (isSha256Hash(linkHash) && linkHash !== previousEntryHash) {
      report(
        sequence,
        'previous-hash-mismatch',
        `${linkField} ${linkHash} does not match ${previousEntryHash}`,
      );
    }

    let recomputed: string | undefined;
    try {
      recomputed = computeEntryHash(stream, event);
    } catch {
      report(
        sequence,
        'malformed-event',
        `event at index ${index} is not representable as canonical JSON`,
      );
    }
    if (
      recomputed !== undefined &&
      isSha256Hash(entryHash) &&
      recomputed !== entryHash
    ) {
      report(
        sequence,
        'entry-hash-mismatch',
        `stored entryHash ${entryHash} does not match recomputed ${recomputed}`,
      );
    }

    if (signed) {
      const signature = event['writerSignature'];
      if (typeof signature !== 'string' || signature.length === 0) {
        if (requireSignatures) {
          report(sequence, 'signature-missing', 'writerSignature is absent');
        }
      } else if (
        options.publicKey !== undefined &&
        isSha256Hash(entryHash) &&
        !verifyHashSignature(entryHash, signature, options.publicKey)
      ) {
        report(
          sequence,
          'signature-invalid',
          `writerSignature does not verify under ${options.publicKey}`,
        );
      }
    }

    if (isSha256Hash(entryHash)) {
      previousEntryHash = entryHash;
    }
  });

  return {
    ok: violations.length === 0,
    size: events.length,
    lastEntryHash: previousEntryHash,
    violations,
  };
}

/**
 * One-line rendering of a violation, for `RecoveryReport.chainViolations` and
 * `VerificationReport.gaps`, which are contracted as `string[]`.
 */
export function formatChainViolation(
  stream: EventStream,
  violation: ChainViolation,
): string {
  const at = violation.sequence === null ? '-' : String(violation.sequence);
  return `${stream}#${at} ${violation.code}: ${violation.message}`;
}

/** Next sequence to assign on a chain head (LEDGER §15: never reuse one). */
export function nextSequence(head: ChainHead): number {
  return head.size + 1;
}

/** `previousEntryHash` for the next event: genesis for an empty chain. */
export function previousHashFor(head: ChainHead): string {
  return head.size === 0 ? GENESIS_HASH : head.lastEntryHash;
}

/**
 * Hash and sign one assembled unsigned event (LEDGER §4): compute
 * `entryHash` over the canonical event without the signature fields, then
 * have the stream's own domain signer sign the raw digest bytes.
 *
 * The signer domain is checked against `STREAM_SIGNER`, so a cross-domain
 * signing attempt (for example Baby A's signer on the channel stream) fails
 * here rather than producing evidence that only fails later at verification
 * time (LEDGER §11, ALD-009).
 */
export async function buildSignedEvent<T extends Record<string, unknown>>(
  stream: SignedEventStream,
  unsignedEvent: T,
  signer: DomainSigner,
): Promise<T & { entryHash: string; writerSignature: string }> {
  const expectedDomain = STREAM_SIGNER[stream];
  if (signer.domain !== expectedDomain) {
    throw new Error(
      `Stream ${stream} must be signed by the ${expectedDomain} domain, not ${signer.domain}`,
    );
  }
  const entryHash = computeEntryHash(stream, unsignedEvent);
  const writerSignature = await signer.sign(entryHash);
  return { ...unsignedEvent, entryHash, writerSignature };
}

export interface JsonlParseOptions {
  /** Require every line to already be RFC 8785 canonical (bundle default). */
  requireCanonical?: boolean;
}

/**
 * Parse one JSONL stream file into events. Each line must be a single JSON
 * object; a single trailing newline is allowed (every `*.jsonl` line in an
 * evidence bundle ends with `\n`), but a blank line inside the file is an
 * error, as is any line that is not already canonical when
 * `requireCanonical` is set — step 1 of LEDGER §14.
 *
 * Throws on unparseable input; use {@link validateChain} on the result for
 * non-throwing integrity reporting.
 */
export function parseJsonlEvents(
  text: string,
  options: JsonlParseOptions = {},
): Record<string, unknown>[] {
  const requireCanonical = options.requireCanonical ?? true;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = requireCanonical ? parseCanonicalJson(line) : JSON.parse(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`JSONL line ${lineNumber} is invalid: ${reason}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`JSONL line ${lineNumber} is not a JSON object`);
    }
    return parsed;
  });
}
