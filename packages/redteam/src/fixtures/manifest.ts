/**
 * Fixture manifest: the committed record of what the ALD-068 fixture set is
 * (BACKLOG ALD-068 criterion 1, criterion 3).
 *
 * The PNGs are committed so tests never have to render anything, and the
 * manifest is what makes that safe: it lists each fixture's file, its plain
 * SHA-256, its byte length, and the SHA-256 of the planted string. A test (or
 * a third party) verifies the committed bytes against the manifest, and the
 * suite result cites the same hashes, so "these are the fixtures that ran" is
 * checkable without trusting the runner.
 *
 * The manifest deliberately stores `plantedTextHash` and never the planted
 * text. The attack strings live in `catalogue.ts` — the researcher's own
 * source — so nothing that could be mistaken for evidence carries injection
 * vocabulary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import { encodeHash, sha256Bytes } from '@ald/hashing';

import { OBSERVATION_FIXTURES, type FixtureDefinition } from './catalogue.js';

const hashString = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const FIXTURE_MANIFEST_FILE = 'manifest.json';

export const FixtureManifestEntrySchema = z
  .object({
    fixtureId: z.string().min(1),
    category: z.string().min(1),
    expected: z.enum(['quarantined', 'approved']),
    /** File name relative to the fixture directory. */
    file: z.string().regex(/^[a-z0-9-]+\.png$/u),
    /** Plain SHA-256 of the file bytes; reproducible with `sha256sum`. */
    sha256: hashString,
    byteLength: z.number().int().nonnegative(),
    /** SHA-256 of the planted string's UTF-8 bytes, when one is planted. */
    plantedTextHash: hashString.optional(),
    metadataKeyCount: z.number().int().nonnegative(),
    fileNameCount: z.number().int().nonnegative(),
    captionCount: z.number().int().nonnegative(),
  })
  .strict();

export const FixtureManifestSchema = z
  .object({
    version: z.literal(1),
    fixtureSetVersion: z.string().min(1),
    /** Embedded synthetic typefaces used by the renderer. */
    typefaces: z.array(z.string().min(1)),
    entries: z.array(FixtureManifestEntrySchema),
  })
  .strict();

export type FixtureManifestEntry = z.infer<typeof FixtureManifestEntrySchema>;
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

/** `<fixtureId>.png`; the id is language-free, so the file name is too. */
export function fixtureFileName(fixtureId: string): string {
  return `${fixtureId}.png`;
}

export function hashBytes(bytes: Uint8Array): string {
  return encodeHash(sha256Bytes(bytes));
}

export function hashUtf8(text: string): string {
  return encodeHash(sha256Bytes(Buffer.from(text, 'utf8')));
}

/** Manifest entry for one fixture, given the bytes it produced. */
export function manifestEntryFor(
  definition: FixtureDefinition,
  bytes: Uint8Array,
): FixtureManifestEntry {
  const entry: FixtureManifestEntry = {
    fixtureId: definition.fixtureId,
    category: definition.category,
    expected: definition.expected,
    file: fixtureFileName(definition.fixtureId),
    sha256: hashBytes(bytes),
    byteLength: bytes.byteLength,
    metadataKeyCount: Object.keys(definition.strings?.metadata ?? {}).length,
    fileNameCount: (definition.strings?.fileNames ?? []).length,
    captionCount: (definition.strings?.captions ?? []).length,
  };
  if (definition.plantedText !== undefined) {
    entry.plantedTextHash = hashUtf8(definition.plantedText);
  }
  return entry;
}

/** Read and validate `<directory>/manifest.json`. */
export function readFixtureManifest(directory: string): FixtureManifest {
  const text = readFileSync(join(directory, FIXTURE_MANIFEST_FILE), 'utf8');
  return FixtureManifestSchema.parse(JSON.parse(text));
}

export interface FixtureVerification {
  fixtureId: string;
  /** `ok`, or the way the committed file disagrees with the manifest. */
  status: 'ok' | 'missing' | 'hash-mismatch' | 'unlisted';
  expectedSha256?: string;
  actualSha256?: string;
}

/**
 * Verify the committed fixture files against the manifest and the manifest
 * against the catalogue. A green result means the bytes a test loads are the
 * bytes the manifest (and therefore the suite result) names.
 */
export function verifyCommittedFixtures(directory: string): FixtureVerification[] {
  const manifest = readFixtureManifest(directory);
  const results: FixtureVerification[] = [];
  const listed = new Set(manifest.entries.map((entry) => entry.fixtureId));
  for (const definition of OBSERVATION_FIXTURES) {
    if (!listed.has(definition.fixtureId)) {
      results.push({ fixtureId: definition.fixtureId, status: 'unlisted' });
    }
  }
  for (const entry of manifest.entries) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(directory, entry.file));
    } catch {
      results.push({ fixtureId: entry.fixtureId, status: 'missing' });
      continue;
    }
    const actual = hashBytes(bytes);
    results.push({
      fixtureId: entry.fixtureId,
      status: actual === entry.sha256 ? 'ok' : 'hash-mismatch',
      expectedSha256: entry.sha256,
      actualSha256: actual,
    });
  }
  return results;
}
