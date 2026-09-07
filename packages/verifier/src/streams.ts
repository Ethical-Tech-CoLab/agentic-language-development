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

import {
  REQUIRED_STREAMS,
  STREAM_FILES,
  expectedHashDomain,
  expectedSignerDomain,
  expectedTreeName,
} from './bundle-layout.js';
import {
  containedBundlePath,
  formatIssues,
  readTextFile,
  type SchemaLike,
} from './bundle-io.js';
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
 * Compares one `streams[]` declaration with the normative constants of
 * `@ald/types` `domains.ts` and the layout of bundle format §1, §7.
 *
 * `run-manifest.json` is unsigned and no checkpoint commits a hash of it, so
 * an editor of the bundle could otherwise pick the signer domain, the hash
 * domain, the tree name, and even the file that gets read. Whatever the
 * manifest says, verification uses the constants; a disagreement is reported
 * against `writerSignaturesValid` when it concerns signing and structurally
 * otherwise (LEDGER §14 step 5, §17).
 */
function verifyDeclaration(
  declaration: StreamDeclaration,
  accumulator: VerificationAccumulator,
): void {
  const stream = declaration.stream;
  const at = `run-manifest.json streams[${stream}]`;

  if (declaration.file !== STREAM_FILES[stream]) {
    accumulator.failStructural(
      'stream-file-unexpected',
      `${at}: file ${declaration.file} is not the documented ${STREAM_FILES[stream]}`,
    );
  }
  if (declaration.hashDomain !== expectedHashDomain(stream)) {
    accumulator.failStructural(
      'stream-hash-domain-mismatch',
      `${at}: hashDomain ${declaration.hashDomain} is not ${expectedHashDomain(stream)}`,
    );
  }

  const signerDomain = expectedSignerDomain(stream);
  if (declaration.signerDomain !== signerDomain) {
    accumulator.fail(
      'writerSignaturesValid',
      'stream-signer-domain-mismatch',
      `${at}: signerDomain ${String(declaration.signerDomain)} is not ${String(signerDomain)}`,
    );
  }

  const treeName = expectedTreeName(stream);
  if (declaration.treeName !== treeName) {
    accumulator.failStructural(
      'stream-tree-name-mismatch',
      `${at}: treeName ${String(declaration.treeName)} is not ${String(treeName)}`,
    );
  }
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

    if (streams.has(stream)) {
      accumulator.failStructural(
        'duplicate-stream-declaration',
        `run-manifest.json declares stream ${stream} more than once`,
      );
      continue;
    }
    verifyDeclaration(declaration, accumulator);

    // Bundle format §1: a stream file name is a single segment inside the
    // bundle. Anything else is refused before the read, so an untrusted
    // manifest can never point the verifier at a host file.
    const resolved = containedBundlePath(bundleDir, file);
    let events: Record<string, unknown>[] = [];

    if (!resolved.ok) {
      accumulator.failStructural(
        'stream-file-outside-bundle',
        `${STREAM_FILES[stream]}: ${resolved.detail}`,
      );
    } else {
      const text = await readTextFile(resolved.path);
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
    }

    // The signer is taken from STREAM_SIGNER, never from the manifest's own
    // `signerDomain`, so deleting that field cannot switch signature
    // verification off for a signed stream (LEDGER §14 step 5).
    const signerDomain = expectedSignerDomain(stream);
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

  // Bundle format §1: these five streams are exported for every run, empty
  // file included. Omitting one from `streams[]` would otherwise hide the
  // whole file from verification — `intervention` completely, because it is
  // the one stream with no checkpoint tree to miss it.
  for (const stream of REQUIRED_STREAMS) {
    if (!streams.has(stream)) {
      accumulator.failStructural(
        'missing-stream-declaration',
        `run-manifest.json declares no ${stream} stream; ${STREAM_FILES[stream]} was never verified`,
      );
    }
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

export interface CrossBindingOptions {
  /**
   * `RunConfig.ledgerLagTurns` (SPEC §8.2): how many turns a receiver's
   * `interpretation.recorded` event may legitimately lag the delivery it
   * interprets. Defaults to the schema maximum so a bundle without a usable
   * configuration is never rejected for a legal lag.
   */
  ledgerLagTurns?: number | undefined;
}

/** Widest lag the schema allows (`packages/types/src/schemas.ts`). */
const MAX_LEDGER_LAG_TURNS = 2;

/**
 * The intention → message → interpretation → turn graph of LEDGER §6, listed
 * as mandatory verifier checks in docs/evidence-bundle-format.md §3. Returns
 * one human-readable line per broken binding; the caller records them in the
 * report and raises the exit code.
 *
 * Bundle format §3 requires `TurnRecord.channelEventHash` to reference *the
 * turn's* channel event, so hash membership alone is not enough: the
 * referenced event's `turn` has to be the record's own turn. For a receiver
 * `interpretation.recorded` event the same section requires only that the
 * referenced event was delivered to that Baby, and SPEC §8.2 lets the entry
 * lag by `ledgerLagTurns`, so the turn rule there is a causality window
 * (`channelTurn <= eventTurn <= channelTurn + ledgerLagTurns`) rather than
 * equality — equality would reject a legal `ledgerLagTurns > 0` run.
 */
export function verifyCrossBindings(
  streams: LoadedStreams,
  options: CrossBindingOptions = {},
): string[] {
  const failures: string[] = [];
  const declaredLag = options.ledgerLagTurns;
  const lag =
    declaredLag !== undefined &&
    Number.isSafeInteger(declaredLag) &&
    declaredLag >= 0
      ? declaredLag
      : MAX_LEDGER_LAG_TURNS;
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
      // A missing `turn` on either side is already a schema failure, so the
      // window is only applied when both turns are readable.
      const eventTurn = readNumber(event, 'turn');
      const channelTurn = readNumber(referenced, 'turn');
      if (eventTurn !== undefined && channelTurn !== undefined) {
        const latest = channelTurn + lag;
        if (eventTurn < channelTurn || eventTurn > latest) {
          failures.push(
            `${at} interprets the channel event of turn ${String(channelTurn)} at turn ${String(eventTurn)}, outside the ledgerLagTurns window ${String(channelTurn)}..${String(latest)}`,
          );
        }
      }
    }
  }

  for (const event of streams.get('turns')?.events ?? []) {
    const at = `turns#${String(readNumber(event, 'sequence') ?? -1)}`;
    const channelEventHash = event['channelEventHash'];
    if (channelEventHash === null || channelEventHash === undefined) {
      continue;
    }
    const normalized = normalizeHash(channelEventHash);
    const referenced =
      normalized === undefined ? undefined : channelByHash.get(normalized);
    if (referenced === undefined) {
      failures.push(
        `${at} channelEventHash ${String(channelEventHash)} is not a channel event in this bundle`,
      );
      continue;
    }
    const recordTurn = readNumber(event, 'turn');
    const channelTurn = readNumber(referenced, 'turn');
    if (
      recordTurn !== undefined &&
      channelTurn !== undefined &&
      recordTurn !== channelTurn
    ) {
      failures.push(
        `${at} channelEventHash references the channel event of turn ${String(channelTurn)}, not this record's turn ${String(recordTurn)}`,
      );
    }
  }

  return failures;
}
