/**
 * Mutation helpers for the LEDGER-INTEGRITY-DESIGN.md §17 acceptance matrix.
 *
 * Every helper works on a *copy* of the fixture bundle so one test never
 * disturbs another, and every helper leaves the bundle byte-format valid
 * (canonical JSON, one event per JSONL line) so the check that fails is the
 * integrity rule under test and not the parser.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemorySignerRegistry,
  buildSignedEvent,
  canonicalJson,
  hashCanonical,
  omitFields,
  parseCanonicalJson,
} from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  MANIFEST_SIGNATURE_FIELDS,
  SIGNER_KEY_IDS,
  STREAM_SIGNER,
  type CheckpointManifest,
  type EventStream,
  type SignerDomain,
} from '@ald/types';

export interface BundleCopy {
  dir: string;
  cleanup(): Promise<void>;
}

/** Copies the immutable fixture bundle into a fresh temp directory. */
export async function copyBundle(sourceDir: string): Promise<BundleCopy> {
  const parent = await mkdtemp(join(tmpdir(), 'ald-verifier-case-'));
  const dir = join(parent, 'bundle');
  await cp(sourceDir, dir, { recursive: true });
  return {
    dir,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

export async function readJsonl(
  path: string,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => parseCanonicalJson<Record<string, unknown>>(line));
}

export async function writeJsonl(
  path: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  const lines = events.map((event) => canonicalJson(event));
  await writeFile(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  return parseCanonicalJson<T>(text.endsWith('\n') ? text.slice(0, -1) : text);
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, 'utf8');
}

/** Reads, mutates, and rewrites one JSONL stream file. */
export async function mutateJsonl(
  path: string,
  mutate: (events: Record<string, unknown>[]) => void,
): Promise<void> {
  const events = await readJsonl(path);
  mutate(events);
  await writeJsonl(path, events);
}

export function checkpointFile(bundleDir: string, sequence: number): string {
  return join(
    bundleDir,
    'checkpoints',
    `${String(sequence).padStart(6, '0')}.json`,
  );
}

function signerFor(
  runId: string,
  seeds: Record<string, string>,
  domain: SignerDomain,
) {
  return InMemorySignerRegistry.fromSeeds(runId, seeds).signer(domain);
}

/**
 * The strongest-attacker checkpoint rewrite: mutate one manifest, then relink,
 * rehash, and re-sign the whole checkpoint series with the real witness key,
 * so the only detectable defect is the one the test introduced (LEDGER §17
 * "incorrect Merkle root" and "inconsistent checkpoint prefix").
 */
export async function rewriteCheckpoints(
  bundleDir: string,
  runId: string,
  seeds: Record<string, string>,
  sequences: readonly number[],
  mutate: (manifest: CheckpointManifest) => void,
): Promise<CheckpointManifest[]> {
  const witness = signerFor(runId, seeds, 'witness');
  const rewritten: CheckpointManifest[] = [];
  let previousCheckpointHash = GENESIS_HASH;

  for (let sequence = 0; ; sequence += 1) {
    const path = checkpointFile(bundleDir, sequence);
    let manifest: CheckpointManifest;
    try {
      manifest = await readJsonFile<CheckpointManifest>(path);
    } catch {
      break;
    }
    manifest.previousCheckpointHash = previousCheckpointHash;
    if (sequences.includes(sequence)) {
      mutate(manifest);
    }
    manifest.witnessKeyId = SIGNER_KEY_IDS.witness;
    const unsigned = omitFields(manifest, MANIFEST_SIGNATURE_FIELDS);
    const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
    manifest.checkpointHash = checkpointHash;
    manifest.witnessSignature = await witness.sign(checkpointHash);
    await writeJsonFile(path, manifest);
    previousCheckpointHash = checkpointHash;
    rewritten.push(manifest);
  }

  return rewritten;
}

/**
 * Appends one *validly signed* event to a signed stream, so the only failing
 * rule is the LEDGER §17 unanchored final ledger tail.
 */
export async function appendSignedLedgerEvent(
  bundleDir: string,
  file: string,
  stream: Exclude<EventStream, 'intervention'>,
  runId: string,
  seeds: Record<string, string>,
  build: (
    previous: Record<string, unknown>,
  ) => Record<string, unknown>,
): Promise<void> {
  const path = join(bundleDir, file);
  const events = await readJsonl(path);
  const previous = events[events.length - 1];
  if (previous === undefined) {
    throw new Error(`${file} has no event to extend`);
  }
  const signer = signerFor(runId, seeds, STREAM_SIGNER[stream]);
  const signed = await buildSignedEvent(stream, build(previous), signer);
  await writeJsonl(path, [...events, signed]);
}

/** Re-signs one event's `writerSignature` with a key that is not the run's. */
export async function foreignSignature(entryHash: string): Promise<string> {
  const foreign = InMemorySignerRegistry.generate('run-foreign');
  return foreign.signer('baby-a-ledger').sign(entryHash);
}
