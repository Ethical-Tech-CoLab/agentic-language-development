/**
 * Turn the fixture catalogue into `ScenarioBundle`s the quarantine can
 * evaluate (BACKLOG ALD-068).
 *
 * Two sources, one shape:
 *
 * - `buildFixtureBundles()` renders the assets in memory. Used by the
 *   generator and by determinism tests.
 * - `loadObservationFixtures(directory)` reads the **committed** PNGs and
 *   verifies each one against the manifest hash first. This is what the suite
 *   uses, so the bundles that run are provably the bytes in the repository —
 *   no renderer, no fonts, no native dependency at test time.
 *
 * The bundle-level strings (metadata, filenames, captions) always come from
 * the catalogue, never from the manifest: the manifest stays free of planted
 * vocabulary and carries only its hash.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScenarioBundle } from '@ald/scenario';

import {
  OBSERVATION_FIXTURES,
  fixtureAssetId,
  fixtureGeneratorConfig,
  type FixtureDefinition,
} from './catalogue.js';
import {
  fixtureFileName,
  hashBytes,
  readFixtureManifest,
  type FixtureManifest,
} from './manifest.js';

export interface LoadedFixture {
  definition: FixtureDefinition;
  bundle: ScenarioBundle;
  /** Plain SHA-256 of the asset bytes. */
  assetHash: string;
}

function bundleFor(
  definition: FixtureDefinition,
  index: number,
  bytes: Uint8Array,
): ScenarioBundle {
  const bundle: ScenarioBundle = {
    version: 1,
    generatorConfig: fixtureGeneratorConfig(index),
    assets: [
      {
        assetId: fixtureAssetId(definition.fixtureId),
        mediaType: 'image/png',
        bytes,
        ...(definition.strings?.metadata === undefined
          ? {}
          : { metadata: definition.strings.metadata }),
      },
    ],
  };
  if (definition.strings?.fileNames !== undefined) {
    bundle.fileNames = [...definition.strings.fileNames];
  }
  if (definition.strings?.captions !== undefined) {
    bundle.captions = [...definition.strings.captions];
  }
  return bundle;
}

/** Render every fixture in memory. */
export function buildFixtureBundles(): LoadedFixture[] {
  return OBSERVATION_FIXTURES.map((definition, index) => {
    const bytes = definition.bytes();
    return {
      definition,
      bundle: bundleFor(definition, index, bytes),
      assetHash: hashBytes(bytes),
    };
  });
}

export class FixtureIntegrityError extends Error {
  constructor(
    readonly fixtureId: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Load the committed fixtures, checking each file against the manifest hash.
 * A mismatch throws: a red-team suite that silently ran different bytes than
 * it cites would be worthless as evidence.
 */
export function loadObservationFixtures(directory: string): LoadedFixture[] {
  const manifest: FixtureManifest = readFixtureManifest(directory);
  const byId = new Map(manifest.entries.map((entry) => [entry.fixtureId, entry]));
  return OBSERVATION_FIXTURES.map((definition, index) => {
    const entry = byId.get(definition.fixtureId);
    if (entry === undefined) {
      throw new FixtureIntegrityError(
        definition.fixtureId,
        'fixture is not listed in the committed manifest',
      );
    }
    const bytes = readFileSync(join(directory, fixtureFileName(definition.fixtureId)));
    const assetHash = hashBytes(bytes);
    if (assetHash !== entry.sha256) {
      throw new FixtureIntegrityError(
        definition.fixtureId,
        `committed bytes hash ${assetHash}, manifest says ${entry.sha256}`,
      );
    }
    return { definition, bundle: bundleFor(definition, index, bytes), assetHash };
  });
}
