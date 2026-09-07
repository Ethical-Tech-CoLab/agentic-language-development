/**
 * Stream-level verification: steps 1-5 of LEDGER-INTEGRITY-DESIGN.md §14
 * (canonical JSON, run/baby/sequence consistency, rebuilt entry hashes,
 * previous-entry links, writer signatures) plus per-event schema validation
 * and the cross-bindings of LEDGER §6 / docs/evidence-bundle-format.md §3.
 *
 * The chain walk itself is `validateChain` from `@ald/hashing`, which never
 * throws and reports one `ChainViolationCode` per broken rule; this module
 * maps those codes onto the SPEC §11.10 report booleans and turns a
 * `duplicate-sequence` violation into a `forks` line (LEDGER §15).
 */
import {
  formatChainViolation,
  parseJsonlEvents,
  type ChainViolationCode,
} from '@ald/hashing';
import {
  AffectEventSchema,
  AuditLedgerEntrySchema,
  ChannelEventSchema,
  InterventionEventSchema,
  LedgerEventSchema,
  TurnRecordSchema,
  ledgerStreamForRole,
  type EventStream,
  type RunManifest,
  type StreamDeclaration,
} from '@ald/types';

import { bundlePath, formatIssues, readTextFile, type SchemaLike } from './bundle-io.js';
import { walkStream } from './chain-walk.js';
import type { VerificationAccumulator, VerificationCheckName } from './checks.js';
import { isRecord, normalizeHash, readNumber, readRecord, readString } from './values.js';

/** Per-event schema of each stream (SPEC §11.4-§11.8). */
const STREAM_SCHEMAS: Record<EventStream, SchemaLike<unknown>> = {
  'baby-a-ledger': LedgerEventSchema,
  'baby-b-ledger': LedgerEventSchema,
  channel: ChannelEventSchema,
  affect: AffectEventSchema,
  audit: AuditLedgerEntrySchema,
  turns: TurnRecordSchema,
  intervention: InterventionEventSchema,
};

/**
 * Which report boolean each chain violation falsifies. `run-id-mismatch`,
 * `baby-id-mismatch`, and `malformed-event` have no boolean of their own in
 * SPEC §11.10 and are reported as structural failures instead.
 */
const VIOLATION_CHECKS: Record<ChainViolationCode, VerificationCheckName | null> = {
  'sequence-start': 'sequencesStrictlyIncreasing',
  'sequence-gap': 'sequencesStrictlyIncreasing',
  'duplicate-sequence': 'sequencesStrictlyIncreasing',
  'previous-hash-mismatch': 'previousEntryLinksValid',
  'entry-hash-mismatch': 'entryHashesRebuilt',
  'signature-missing': 'writerSignaturesValid',
  'signature-invalid': 'writerSignaturesValid',
  'run-id-mismatch': null,
  'baby-id-mismatch': null,
  'malformed-event': null,
};

/** One committed event reduced to what the Merkle rebuild needs (LEDGER §7). */
export interface StreamEntry {
  sequence: number;
  entryHash: string;
}

export interface LoadedStream {
  stream: EventStream;
  declaration: StreamDeclaration;
  /** Parsed JSONL events in file order. */
  events: Record<string, unknown>[];
  /** Chain-usable `{sequence, entryHash}` pairs in file order. */
  entries: StreamEntry[];
  /** `entries` indexed by the event's own sequence. */
  bySequence: Map<number, StreamEntry>;
  size: number;
}

export type LoadedStreams = Map<EventStream, LoadedStream>;

function babyIdFor(stream: EventStream): 'A' | 'B' | undefined {
  if (stream === 'baby-a-ledger') {
    return 'A';
  }
  return stream === 'baby-b-ledger' ? 'B' : undefined;
}

/**
 * Reads and verifies every stream declared by `run-manifest.json`
 * (bundle format §1, §7) and returns the parsed events for the checkpoint,
 * proof, and cross-binding checks.
 */
export async function loadStreams(
  bundleDir: string,
  manifest: RunManifest,
  accumulator: VerificationAccumulator,
): Promise<LoadedStreams> {
  const streams: LoadedStreams = new Map();

  for (const declaration of manifest.streams) {
    const stream = declaration.stream;
    const file = declaration.file;
    const text = await readTextFile(bundlePath(bundleDir, file));
    let events: Record<string, unknown>[] = [];

    if (!text.ok) {
      accumulator.failStructural(text.code, `${file}: ${text.detail}`);
    } else {
      try {
        events = parseJsonlEvents(text.value, { requireCanonical: true });
      } catch (error) {
        accumulator.fail(
          'canonicalJsonValid',
          'canonical-json-invalid',
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        events = [];
      }
    }

    const signerDomain = declaration.signerDomain;
    const publicKey =
      signerDomain === undefined
        ? undefined
        : manifest.signers.find((signer) => signer.domain === signerDomain)
            ?.publicKey;
    if (signerDomain !== undefined && publicKey === undefined) {
      accumulator.fail(
        'writerSignaturesValid',
        'missing-signer-key',
        `${file}: run manifest declares no public key for signer domain ${signerDomain}`,
      );
    }

    const result = walkStream(stream, events, {
      runId: manifest.runId,
      publicKey,
      requireSignatures: signerDomain !== undefined,
      babyId: babyIdFor(stream),
    });

    for (const violation of result.violations) {
      const line = formatChainViolation(stream, violation);
      if (violation.code === 'duplicate-sequence') {
        accumulator.fork(line);
      }
      const check = VIOLATION_CHECKS[violation.code];
      if (check === null || check === undefined) {
        accumulator.failStructural('chain-violation', line);
      } else {
        accumulator.fail(check, 'chain-violation', line);
      }
    }

    const schema = STREAM_SCHEMAS[stream];
    events.forEach((event, index) => {
      const parsed = schema.safeParse(event);
      if (!parsed.success) {
        const sequence = isRecord(event) ? readNumber(event, 'sequence') : undefined;
        accumulator.failStructural(
          'event-schema-invalid',
          `${stream}#${sequence === undefined ? `index ${String(index)}` : String(sequence)}: ${formatIssues(parsed.error.issues)}`,
        );
      }
    });

    const entries: StreamEntry[] = [];
    const bySequence = new Map<number, StreamEntry>();
    for (const event of events) {
      const sequence = readNumber(event, 'sequence');
      const entryHash = normalizeHash(event['entryHash']);
      if (sequence === undefined || sequence < 1 || entryHash === undefined) {
        continue;
      }
      const entry: StreamEntry = { sequence, entryHash };
      entries.push(entry);
      if (!bySequence.has(sequence)) {
        bySequence.set(sequence, entry);
      }
    }

    streams.set(stream, {
      stream,
      declaration,
      events,
      entries,
      bySequence,
      size: events.length,
    });
  }

  return streams;
}

function ledgerStreamFor(sender: unknown): EventStream | undefined {
  if (sender === 'baby-a' || sender === 'baby-b') {
    return ledgerStreamForRole(sender);
  }
  return undefined;
}

function roleForLedgerStream(stream: EventStream): string {
  return stream === 'baby-a-ledger' ? 'baby-a' : 'baby-b';
}

/**
 * The intention → message → interpretation → turn graph of LEDGER §6, listed
 * as mandatory verifier checks in docs/evidence-bundle-format.md §3. Returns
 * one human-readable line per broken binding; the caller records them in the
 * report and raises the exit code.
 */
export function verifyCrossBindings(streams: LoadedStreams): string[] {
  const failures: string[] = [];
  const channel = streams.get('channel');
  const channelEvents = channel?.events ?? [];
  const channelByHash = new Map<string, Record<string, unknown>>();

  for (const event of channelEvents) {
    const hash = normalizeHash(event['entryHash']);
    if (hash !== undefined && !channelByHash.has(hash)) {
      channelByHash.set(hash, event);
    }
  }

  const ledgerBySequence = new Map<EventStream, Map<number, Record<string, unknown>>>();
  for (const stream of ['baby-a-ledger', 'baby-b-ledger'] as const) {
    const loaded = streams.get(stream);
    const index = new Map<number, Record<string, unknown>>();
    for (const event of loaded?.events ?? []) {
      const sequence = readNumber(event, 'sequence');
      if (sequence !== undefined && !index.has(sequence)) {
        index.set(sequence, event);
      }
    }
    ledgerBySequence.set(stream, index);
  }

  for (const event of channelEvents) {
    const at = `channel#${String(readNumber(event, 'sequence') ?? -1)}`;
    const validation = readString(event, 'gatewayValidationResult');
    const receipt = readRecord(event, 'deliveryReceipt');

    if (validation === 'rejected') {
      if ((readString(event, 'reasonCode') ?? '').length === 0) {
        failures.push(`${at} rejected event carries no reasonCode`);
      }
      if (receipt !== undefined) {
        failures.push(`${at} rejected event carries a deliveryReceipt`);
      }
      if (
        event['senderLedgerSequence'] !== undefined ||
        event['senderEntryHash'] !== undefined
      ) {
        failures.push(`${at} rejected event carries sender ledger bindings`);
      }
      continue;
    }

    if (validation !== 'accepted' || readString(event, 'origin') !== 'baby') {
      continue;
    }
    if (readString(event, 'communicationCondition') === 'disabled') {
      continue;
    }

    const senderStream = ledgerStreamFor(event['logicalSender']);
    const senderSequence = readNumber(event, 'senderLedgerSequence');
    const senderEntryHash = normalizeHash(event['senderEntryHash']);

    if (senderStream === undefined || senderSequence === undefined || senderEntryHash === undefined) {
      failures.push(`${at} accepted Baby event is missing its sender ledger binding`);
    } else {
      const senderEvent = ledgerBySequence.get(senderStream)?.get(senderSequence);
      if (senderEvent === undefined) {
        failures.push(
          `${at} references ${senderStream}#${String(senderSequence)}, which is not in the bundle`,
        );
      } else if (readString(senderEvent, 'eventType') !== 'intention.recorded') {
        failures.push(
          `${at} references ${senderStream}#${String(senderSequence)}, whose eventType is ${String(readString(senderEvent, 'eventType'))}, not intention.recorded`,
        );
      } else if (normalizeHash(senderEvent['entryHash']) !== senderEntryHash) {
        failures.push(
          `${at} senderEntryHash does not match ${senderStream}#${String(senderSequence)}`,
        );
      }
    }

    if (receipt === undefined) {
      failures.push(`${at} accepted delivery carries no deliveryReceipt`);
    } else {
      const delivered = normalizeHash(receipt['deliveredArtifactHash']);
      const published = normalizeHash(event['publicArtifactHash']);
      if (delivered === undefined || published === undefined || delivered !== published) {
        failures.push(
          `${at} deliveryReceipt.deliveredArtifactHash does not equal publicArtifactHash`,
        );
      }
    }
  }

  for (const stream of ['baby-a-ledger', 'baby-b-ledger'] as const) {
    const loaded = streams.get(stream);
    for (const event of loaded?.events ?? []) {
      if (readString(event, 'eventType') !== 'interpretation.recorded') {
        continue;
      }
      const at = `${stream}#${String(readNumber(event, 'sequence') ?? -1)}`;
      const channelEventHash = normalizeHash(event['channelEventHash']);
      if (channelEventHash === undefined) {
        failures.push(`${at} interpretation.recorded carries no channelEventHash`);
        continue;
      }
      const referenced = channelByHash.get(channelEventHash);
      if (referenced === undefined) {
        failures.push(
          `${at} channelEventHash ${channelEventHash} is not a channel event in this bundle`,
        );
        continue;
      }
      const recipient = readRecord(referenced, 'deliveryReceipt')?.['recipient'];
      if (recipient !== roleForLedgerStream(stream)) {
        failures.push(
          `${at} interprets a channel event delivered to ${String(recipient)}, not ${roleForLedgerStream(stream)}`,
        );
      }
    }
  }

  for (const event of streams.get('turns')?.events ?? []) {
    const channelEventHash = event['channelEventHash'];
    if (channelEventHash === null || channelEventHash === undefined) {
      continue;
    }
    const normalized = normalizeHash(channelEventHash);
    if (normalized === undefined || !channelByHash.has(normalized)) {
      failures.push(
        `turns#${String(readNumber(event, 'sequence') ?? -1)} channelEventHash ${String(channelEventHash)} is not a channel event in this bundle`,
      );
    }
  }

  return failures;
}
