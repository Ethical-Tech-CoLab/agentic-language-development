/**
 * Per-run key provisioning for the isolated signer services (ALD-009).
 *
 * LEDGER §11 requires a separate Ed25519 key per event-writer domain and for
 * the Nursery checkpoint witness, generated **per run** inside an isolated
 * signer service, with only public keys recorded in the run manifest and no
 * signing key ever exposed to model context or tools.
 *
 * This store keeps that private material outside the evidence store
 * altogether: one directory per run under `keyDir`, holding a single
 * `signers.json` of hex seeds. Because the file contains *only*
 * `{ runId, seeds }`, it can never be mistaken for an evidence artifact —
 * there are no public keys, key ids, hashes, or signatures in it, and nothing
 * in the evidence bundle format has that shape. Public keys are always
 * derived on load (LEDGER §11: "the verifier requires only public keys").
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SIGNER_DOMAINS,
  type SignerDomain,
  type SignerPublicKey,
} from '@ald/types';

import { canonicalJson } from './canonical.js';
import { InMemorySignerRegistry } from './signers.js';

/** File name of the seed file inside `<keyDir>/<runId>/`. */
export const SIGNER_SEED_FILE = 'signers.json';

/** Owner-only key directory permissions. */
const DIR_MODE = 0o700;
/** Owner-only seed file permissions. */
const FILE_MODE = 0o600;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEED_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** On-disk shape of `signers.json`: private seeds and nothing else. */
interface SeedFile {
  runId: string;
  seeds: Record<string, string>;
}

function isSignerDomain(value: string): value is SignerDomain {
  return (SIGNER_DOMAINS as readonly string[]).includes(value);
}

/**
 * Reject run identifiers that could escape `keyDir` or collide with the
 * directory itself. Implementation-defined: the specification does not fix a
 * `runId` grammar, so the key store accepts only path-safe identifiers.
 */
function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      'runId must be 1-128 characters of [A-Za-z0-9._-] and start alphanumeric',
    );
  }
}

/**
 * File-backed per-run signer provisioning.
 *
 * ```ts
 * const store = new FileKeyStore('/var/lib/ald/keys');
 * const registry = store.provisionRun(config.runId);        // fresh keys
 * const manifestSigners = registry.publicKeys();            // manifest input
 * const resumed = store.loadRun(config.runId);              // after restart
 * ```
 *
 * `keyDir` must live outside the repository and outside every evidence
 * bundle; this class enforces owner-only permissions but cannot choose the
 * location for the caller.
 */
export class FileKeyStore {
  constructor(private readonly keyDir: string) {}

  /** Directory holding one run's key material. */
  private runDir(runId: string): string {
    assertSafeRunId(runId);
    return join(this.keyDir, runId);
  }

  /** Absolute path of a run's seed file. */
  seedFile(runId: string): string {
    return join(this.runDir(runId), SIGNER_SEED_FILE);
  }

  hasRun(runId: string): boolean {
    return existsSync(this.seedFile(runId));
  }

  /**
   * Generate a fresh key per domain for `runId` and persist the seeds. Throws
   * if the run already has keys: per-run rotation must never silently replace
   * the keys that already-committed signatures were made with (LEDGER §11,
   * §15).
   */
  provisionRun(
    runId: string,
    domains: readonly SignerDomain[] = SIGNER_DOMAINS,
  ): InMemorySignerRegistry {
    if (domains.length === 0) {
      throw new Error('At least one signer domain must be provisioned');
    }
    const directory = this.runDir(runId);
    if (this.hasRun(runId)) {
      throw new Error(`Signer keys already exist for run ${runId}`);
    }
    const registry = InMemorySignerRegistry.generate(runId, domains);
    const payload: SeedFile = { runId, seeds: registry.exportSeeds() };

    mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    chmodSync(directory, DIR_MODE);
    writeFileSync(this.seedFile(runId), `${canonicalJson(payload)}\n`, {
      encoding: 'utf8',
      mode: FILE_MODE,
      flag: 'wx',
    });
    chmodSync(this.seedFile(runId), FILE_MODE);
    return registry;
  }

  /** Restore a run's signers from its persisted seeds. */
  loadRun(runId: string): InMemorySignerRegistry {
    const path = this.seedFile(runId);
    if (!existsSync(path)) {
      throw new Error(`No signer keys provisioned for run ${runId}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const file = parseSeedFile(parsed);
    if (file.runId !== runId) {
      throw new Error(
        `Seed file for ${runId} declares runId ${file.runId}; refusing to load`,
      );
    }
    const seeds: Partial<Record<SignerDomain, string>> = {};
    for (const [domain, seed] of Object.entries(file.seeds)) {
      if (!isSignerDomain(domain)) {
        throw new Error(`Unknown signer domain in seed file: ${domain}`);
      }
      seeds[domain] = seed;
    }
    return InMemorySignerRegistry.fromSeeds(runId, seeds);
  }

  /** Public keys for the run manifest. Never returns private material. */
  publicKeys(runId: string): SignerPublicKey[] {
    return this.loadRun(runId).publicKeys();
  }
}

function parseSeedFile(value: unknown): SeedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Seed file must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const runId = record['runId'];
  const seeds = record['seeds'];
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('Seed file is missing a runId');
  }
  if (typeof seeds !== 'object' || seeds === null || Array.isArray(seeds)) {
    throw new Error('Seed file is missing a seeds object');
  }
  const parsedSeeds: Record<string, string> = {};
  for (const [domain, seed] of Object.entries(seeds as Record<string, unknown>)) {
    if (typeof seed !== 'string' || !SEED_HEX_PATTERN.test(seed)) {
      throw new Error(`Seed for ${domain} must be 64 lowercase hex characters`);
    }
    parsedSeeds[domain] = seed;
  }
  if (Object.keys(parsedSeeds).length === 0) {
    throw new Error('Seed file contains no seeds');
  }
  return { runId, seeds: parsedSeeds };
}
