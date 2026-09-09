/**
 * The fixed bundle layout of docs/evidence-bundle-format.md §1 and the
 * normative stream metadata of `@ald/types` `domains.ts`, restated as
 * verifier-side expectations.
 *
 * `run-manifest.json` is unsigned and is committed by no checkpoint, so every
 * value it declares about a stream — file name, hash domain, signer domain,
 * checkpoint tree name — has to be compared with the constants rather than
 * trusted (LEDGER-INTEGRITY-DESIGN.md §14 step 5, §17; bundle format §7).
 */
import {
  AUXILIARY_TREES,
  MANDATORY_TREES,
  STREAM_HASH_DOMAIN,
  STREAM_SIGNER,
  type EventStream,
  type SignerDomain,
} from '@ald/types';

/**
 * File name of each exported stream (bundle format §1). Mirrors the exporter's
 * own table in packages/evidence/src/export.ts, which is the only writer of
 * `streams[].file`.
 */
export const STREAM_FILES: Record<EventStream, string> = {
  'baby-a-ledger': 'baby-a-ledger.jsonl',
  'baby-b-ledger': 'baby-b-ledger.jsonl',
  channel: 'channel-transcript.jsonl',
  affect: 'affect-transcript.jsonl',
  audit: 'audit-ledger.jsonl',
  turns: 'turn-records.jsonl',
  intervention: 'intervention-log.jsonl',
};

/**
 * Streams every bundle exports, empty file included
 * (packages/evidence/src/export.ts `ALWAYS_EXPORTED`, bundle format §1). A
 * manifest that omits one of these hides a whole stream from verification.
 */
export const REQUIRED_STREAMS: readonly EventStream[] = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'turns',
  'intervention',
];

/** Signer domain that MUST sign a stream, or `undefined` for `intervention`. */
export function expectedSignerDomain(
  stream: EventStream,
): SignerDomain | undefined {
  return stream === 'intervention' ? undefined : STREAM_SIGNER[stream];
}

/** Hash domain a stream's entry hashes MUST use (bundle format §3). */
export function expectedHashDomain(stream: EventStream): string {
  return STREAM_HASH_DOMAIN[stream];
}

/** Checkpoint tree name of a stream. */
export function expectedTreeName(stream: EventStream): string | undefined {
  if (
    stream === 'baby-a-ledger' ||
    stream === 'baby-b-ledger' ||
    stream === 'channel'
  ) {
    return MANDATORY_TREES[stream];
  }
  if (
    stream === 'affect' ||
    stream === 'audit' ||
    stream === 'turns' ||
    stream === 'intervention'
  ) {
    return AUXILIARY_TREES[stream];
  }
  return undefined;
}
