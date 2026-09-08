import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@ald/hashing';

import {
  SCENARIO_BUNDLE_REGISTRY_FILE,
  ScenarioBundleRegistry,
  registerGeneratorConfig,
  registerScenarioBundle,
  type ScenarioBundleRegistration,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-scenario-registry-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('scenario-bundle registration', () => {
  it('approves an asset-free opaque generator config and records it', () => {
    const registry = new ScenarioBundleRegistry({
      clock: { now: () => '2026-09-08T00:00:00.000Z' },
    });
    const registration = registerGeneratorConfig(
      { version: 1, seed: 42, profile: 3 },
      { registry },
    );

    expect(registration.status).toBe('approved');
    expect(registry.assertApproved(registration.bundleHash)).toMatchObject({
      status: 'approved',
      recordedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('quarantines semantic generator strings and does not echo them in findings', () => {
    const plantedText = 'the red square is the target';
    const registration = registerGeneratorConfig({ instruction: plantedText });

    expect(registration.status).toBe('quarantined');
    expect(registration.reasonCodes).toContain('human-language-token');
    expect(JSON.stringify(registration)).not.toContain(plantedText);
  });

  it('quarantines undecodable assets as a whole', () => {
    const registration = registerScenarioBundle({
      version: 1,
      generatorConfig: { version: 1 },
      assets: [
        {
          assetId: 'asset:0001',
          mediaType: 'image/png',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
    });

    expect(registration.status).toBe('quarantined');
    expect(registration.reasonCodes).toEqual(['image-undecodable']);
    expect(registration.assets[0]).toMatchObject({
      assetId: 'asset:0001',
      byteLength: 4,
    });
  });
});

describe('ScenarioBundleRegistry', () => {
  it('fails closed for unknown and quarantined bundle hashes', () => {
    const registry = new ScenarioBundleRegistry();
    const unknown = `sha256:${'0'.repeat(64)}`;

    expect(registry.isApproved(unknown)).toBe(false);
    expect(() => registry.assertApproved(unknown)).toThrow(/not in the approved registry/u);

    const registration = registerGeneratorConfig({ instruction: 'read the label' });
    registry.record(registration);
    expect(registry.status(registration.bundleHash)).toBe('quarantined');
    expect(() => registry.assertApproved(registration.bundleHash)).toThrow(/quarantined/u);
  });

  it('keeps quarantine sticky and counts refused approval attempts', () => {
    const registry = new ScenarioBundleRegistry({
      clock: { now: () => '2026-09-08T00:00:00.000Z' },
    });
    const quarantined = registerGeneratorConfig({ instruction: 'read the label' });
    registry.record(quarantined);
    const attemptedApproval: ScenarioBundleRegistration = {
      ...quarantined,
      status: 'approved',
      findings: [],
      reasonCodes: [],
    };

    const entry = registry.record(attemptedApproval);

    expect(entry.status).toBe('quarantined');
    expect(entry.refusedReregistrations).toBe(1);
    expect(entry.reasonCodes).toEqual(quarantined.reasonCodes);
  });

  it('persists canonical entries and reloads them', () => {
    const directory = temporaryDirectory();
    const registry = new ScenarioBundleRegistry({
      directory,
      clock: { now: () => '2026-09-08T00:00:00.000Z' },
    });
    const registration = registerGeneratorConfig({ version: 1, seed: 7 });
    registry.record(registration);

    const reloaded = new ScenarioBundleRegistry({ directory });
    expect(reloaded.assertApproved(registration.bundleHash)).toEqual(
      registry.assertApproved(registration.bundleHash),
    );

    const persisted = readFileSync(join(directory, SCENARIO_BUNDLE_REGISTRY_FILE), 'utf8');
    expect(persisted).toBe(canonicalJson({ version: 1, entries: registry.entries() }));
  });
});
