/**
 * The approved-scenario-bundle registry (ALD-039 criterion 1;
 * SPECIFICATION.md §10.1, §10.2).
 *
 * ALD-039 criterion 1 is a *reachability* property, not a detection property:
 * "a bundle containing OCR-detected text, caption metadata, semantic
 * filenames, or human-readable labels **cannot be referenced by a run**".
 * Detection alone does not deliver that; something must remember the decision
 * and be consulted before a run starts. This registry is that memory.
 *
 * Two properties make it safe to consult:
 *
 * - **Fail-closed on the unknown.** `isApproved` is false for a bundle hash
 *   the registry has never seen, so wiring the registry into run
 *   registration can only ever *reduce* what may run.
 * - **Quarantine is sticky.** Once a bundle hash is quarantined it can never
 *   be re-registered as approved, whatever detector or filter version a later
 *   caller passes. §10.2 forbids sanitizing prohibited content and passing it
 *   through; a re-registration that flips the verdict would be exactly that,
 *   through the back door. A widened detector can only ever move a bundle
 *   from approved to quarantined, never back.
 *
 * The on-disk form is canonical JSON with entries sorted by bundle hash, so
 * the file is byte-stable across processes and diffable in review. It stores
 * hashes, reason codes, and versions — never asset bytes and never the
 * prohibited text (ALD-039 criterion 3).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import type { Clock } from '@ald/types';
import { canonicalJson } from '@ald/hashing';

import { QuarantineError } from './quarantine/errors.js';
import {
  hashScenarioBundle,
  registerScenarioBundle,
  type RegisterScenarioBundleOptions,
  type ScenarioBundle,
  type ScenarioBundleRegistration,
  type ScenarioBundleRegistrySink,
} from './quarantine/bundle.js';

/** File name used when the registry is directory-backed. */
export const SCENARIO_BUNDLE_REGISTRY_FILE = 'scenario-bundle-registry.json';

const hashString = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const ScenarioBundleRegistryEntrySchema = z
  .object({
    bundleHash: hashString,
    status: z.enum(['approved', 'quarantined']),
    filterVersion: z.string().min(1),
    detectorVersion: z.string().min(1),
    /** Plain SHA-256 of every asset, in bundle order. */
    assetHashes: z.array(hashString),
    reasonCodes: z.array(z.string()),
    recordedAt: z.string().min(1),
    /**
     * How many times a *later* registration of this hash was refused because
     * the bundle is already quarantined. Non-zero is worth a look: something
     * is trying to re-register prohibited content.
     */
    refusedReregistrations: z.number().int().nonnegative(),
  })
  .strict();

export const ScenarioBundleRegistryFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(ScenarioBundleRegistryEntrySchema),
  })
  .strict();

export type ScenarioBundleRegistryEntry = z.infer<
  typeof ScenarioBundleRegistryEntrySchema
>;

export interface ScenarioBundleRegistryOptions {
  /** When set, the registry is file-backed under this directory. */
  directory?: string;
  /** Injected clock so tests are deterministic. Defaults to real UTC time. */
  clock?: Clock;
}

const realClock: Clock = { now: () => new Date().toISOString() };

export class ScenarioBundleRegistry implements ScenarioBundleRegistrySink {
  private readonly entriesByHash = new Map<string, ScenarioBundleRegistryEntry>();
  private readonly directory?: string;
  private readonly clock: Clock;

  constructor(options: ScenarioBundleRegistryOptions = {}) {
    this.clock = options.clock ?? realClock;
    if (options.directory !== undefined) {
      this.directory = options.directory;
      try {
        mkdirSync(options.directory, { recursive: true });
      } catch (cause) {
        throw new QuarantineError(
          'registry-io',
          `cannot create registry directory: ${(cause as Error).message}`,
        );
      }
      this.load();
    }
  }

  private get path(): string {
    if (this.directory === undefined) {
      throw new QuarantineError('registry-io', 'registry is in-memory only');
    }
    return join(this.directory, SCENARIO_BUNDLE_REGISTRY_FILE);
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'ENOENT') {
        return;
      }
      throw new QuarantineError(
        'registry-io',
        `cannot read the registry file: ${(cause as Error).message}`,
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (cause) {
      throw new QuarantineError(
        'registry-corrupt',
        `registry file is not JSON: ${(cause as Error).message}`,
      );
    }
    const parsed = ScenarioBundleRegistryFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new QuarantineError(
        'registry-corrupt',
        'registry file does not satisfy ScenarioBundleRegistryFileSchema',
      );
    }
    for (const entry of parsed.data.entries) {
      this.entriesByHash.set(entry.bundleHash, entry);
    }
  }

  private persist(): void {
    if (this.directory === undefined) {
      return;
    }
    const file = {
      version: 1 as const,
      entries: this.entries(),
    };
    try {
      writeFileSync(this.path, canonicalJson(file), 'utf8');
    } catch (cause) {
      throw new QuarantineError(
        'registry-io',
        `cannot write the registry file: ${(cause as Error).message}`,
      );
    }
  }

  /**
   * Record a decision. Returns the entry now in force, which is NOT
   * necessarily the one just passed in: a bundle already quarantined stays
   * quarantined, and the attempt is counted.
   */
  record(registration: ScenarioBundleRegistration): ScenarioBundleRegistryEntry {
    const existing = this.entriesByHash.get(registration.bundleHash);
    if (existing !== undefined && existing.status === 'quarantined') {
      const updated: ScenarioBundleRegistryEntry = {
        ...existing,
        refusedReregistrations:
          registration.status === 'approved'
            ? existing.refusedReregistrations + 1
            : existing.refusedReregistrations,
      };
      this.entriesByHash.set(updated.bundleHash, updated);
      this.persist();
      return updated;
    }
    const entry: ScenarioBundleRegistryEntry = {
      bundleHash: registration.bundleHash,
      status: registration.status,
      filterVersion: registration.filterVersion,
      detectorVersion: registration.detectorVersion,
      assetHashes: registration.assets.map((asset) => asset.assetHash),
      reasonCodes: [...registration.reasonCodes],
      recordedAt: existing?.recordedAt ?? this.clock.now(),
      refusedReregistrations: existing?.refusedReregistrations ?? 0,
    };
    this.entriesByHash.set(entry.bundleHash, entry);
    this.persist();
    return entry;
  }

  /** Fail-closed: an unknown bundle hash is not approved. */
  isApproved(bundleHash: string): boolean {
    return this.entriesByHash.get(bundleHash)?.status === 'approved';
  }

  status(bundleHash: string): 'approved' | 'quarantined' | 'unknown' {
    return this.entriesByHash.get(bundleHash)?.status ?? 'unknown';
  }

  get(bundleHash: string): ScenarioBundleRegistryEntry | undefined {
    return this.entriesByHash.get(bundleHash);
  }

  /** Entries sorted by bundle hash, so the file and this list are canonical. */
  entries(): ScenarioBundleRegistryEntry[] {
    return [...this.entriesByHash.values()].sort((left, right) =>
      left.bundleHash < right.bundleHash ? -1 : left.bundleHash > right.bundleHash ? 1 : 0,
    );
  }

  /**
   * The gate a run registration calls: throws unless the bundle hash is
   * recorded as approved. Reason codes are included so an operator sees why,
   * with no prohibited text (§10.2, ALD-039 criterion 3).
   */
  assertApproved(bundleHash: string): ScenarioBundleRegistryEntry {
    const entry = this.entriesByHash.get(bundleHash);
    if (entry === undefined) {
      throw new QuarantineError(
        'bundle-not-approved',
        `scenario bundle ${bundleHash} is not in the approved registry`,
      );
    }
    if (entry.status !== 'approved') {
      throw new QuarantineError(
        'bundle-not-approved',
        `scenario bundle ${bundleHash} is quarantined (${entry.reasonCodes.join(', ')})`,
      );
    }
    return entry;
  }
}

/**
 * Register an asset-free generator config — the shape every run in the
 * repository uses today. Text-free by construction (§10.2 "synthetic scenes
 * MUST contain no text"), it still goes through the full filter, because
 * "text-free by construction" is a claim the filter should verify rather than
 * assume: a config carrying a semantic label in a string field is caught here.
 *
 * The resulting `bundleHash` equals `ReferentialScenarioEngine.bundleHash`
 * for the same config, so the value is directly usable as
 * `RunConfig.scenarioBundleHash`.
 */
export function registerGeneratorConfig(
  generatorConfig: Record<string, unknown>,
  options: RegisterScenarioBundleOptions = {},
): ScenarioBundleRegistration {
  const bundle: ScenarioBundle = { version: 1, generatorConfig, assets: [] };
  return registerScenarioBundle(bundle, options);
}

/** Hash a bundle without registering it (for cross-checking a run config). */
export function scenarioBundleHashOf(bundle: ScenarioBundle): string {
  return hashScenarioBundle(bundle);
}
