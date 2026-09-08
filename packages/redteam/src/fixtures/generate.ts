/**
 * Deterministic generator for the committed ALD-068 fixture set.
 *
 * Run it to (re)write `packages/redteam/fixtures/`:
 *
 * ```sh
 * npx tsx packages/redteam/src/fixtures/generate.ts
 * ```
 *
 * Regeneration is expected to be a no-op: every fixture's bytes are a pure
 * function of its definition in `catalogue.ts` (embedded typefaces, seeded
 * PRNG, stored-DEFLATE PNG encoding), so a diff after running this script
 * means a definition changed — which in turn means the manifest hashes, and
 * therefore the hashes cited by any suite result already recorded, changed
 * too. That is the point: the fixture set is pre-registered material and a
 * silent change to it must be visible in review.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from '@ald/hashing';

import {
  FIXTURE_SET_VERSION,
  FIXTURE_TYPEFACES,
  OBSERVATION_FIXTURES,
} from './catalogue.js';
import {
  FIXTURE_MANIFEST_FILE,
  fixtureFileName,
  manifestEntryFor,
  type FixtureManifest,
} from './manifest.js';

export interface GenerateFixturesResult {
  directory: string;
  manifest: FixtureManifest;
  /** Files written, relative to `directory`. */
  written: string[];
  totalBytes: number;
}

/** Build every fixture's bytes without touching the filesystem. */
export function buildFixtureBytes(): Map<string, Buffer> {
  const built = new Map<string, Buffer>();
  for (const definition of OBSERVATION_FIXTURES) {
    built.set(definition.fixtureId, definition.bytes());
  }
  return built;
}

/** The manifest that describes the current catalogue. */
export function buildFixtureManifest(built: Map<string, Buffer>): FixtureManifest {
  return {
    version: 1,
    fixtureSetVersion: FIXTURE_SET_VERSION,
    typefaces: [...FIXTURE_TYPEFACES],
    entries: OBSERVATION_FIXTURES.map((definition) => {
      const bytes = built.get(definition.fixtureId);
      if (bytes === undefined) {
        throw new Error(`fixture ${definition.fixtureId} produced no bytes`);
      }
      return manifestEntryFor(definition, bytes);
    }),
  };
}

/** Write every fixture PNG and the manifest into `directory`. */
export function generateObservationFixtures(directory: string): GenerateFixturesResult {
  mkdirSync(directory, { recursive: true });
  const built = buildFixtureBytes();
  const written: string[] = [];
  let totalBytes = 0;
  for (const definition of OBSERVATION_FIXTURES) {
    const bytes = built.get(definition.fixtureId);
    if (bytes === undefined) {
      throw new Error(`fixture ${definition.fixtureId} produced no bytes`);
    }
    const file = fixtureFileName(definition.fixtureId);
    writeFileSync(join(directory, file), bytes);
    written.push(file);
    totalBytes += bytes.byteLength;
  }
  const manifest = buildFixtureManifest(built);
  writeFileSync(join(directory, FIXTURE_MANIFEST_FILE), canonicalJson(manifest), 'utf8');
  written.push(FIXTURE_MANIFEST_FILE);
  return { directory, manifest, written, totalBytes };
}

/** Default location of the committed fixture set. */
export function defaultFixtureDirectory(): string {
  return new URL('../../fixtures/', import.meta.url).pathname;
}

// Executed only when this module is the process entry point.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/'))) {
  const target = process.argv[2] ?? defaultFixtureDirectory();
  const result = generateObservationFixtures(target);
  process.stdout.write(
    `wrote ${result.written.length} files (${result.totalBytes} bytes) to ${result.directory}\n`,
  );
}
