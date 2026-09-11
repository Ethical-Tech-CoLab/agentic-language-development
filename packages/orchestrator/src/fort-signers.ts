import { lstatSync, readFileSync } from 'node:fs';

import { InMemorySignerRegistry } from '@ald/hashing';
import {
  SIGNER_DOMAINS,
  type SignerDomain,
  type SignerRegistry,
} from '@ald/types';

export const FORT_SIGNER_SEEDS_FILE_ENV = 'ALD_RUN_SIGNER_SEEDS_JSON_FILE';
export const FORBIDDEN_SIGNER_SEEDS_VALUE_ENV = 'ALD_RUN_SIGNER_SEEDS_JSON';

type SignerSeeds = Record<SignerDomain, string>;

function parseSeedSet(value: unknown): SignerSeeds | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(',') !== [...SIGNER_DOMAINS].sort().join(',')
  ) {
    return undefined;
  }
  for (const domain of SIGNER_DOMAINS) {
    if (
      typeof object[domain] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(object[domain])
    ) {
      return undefined;
    }
  }
  return object as SignerSeeds;
}

/**
 * Reads Fort's short-lived, mode-`files` materialization once and returns a
 * per-run signer provider. Error messages never include file contents.
 */
export function signerProviderFromFortFile(
  path: string,
): (runId: string) => SignerRegistry {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Fort signer material must be a regular non-symlink file');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Fort signer material must not grant group or other access');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Fort signer material is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Fort signer material has an invalid envelope');
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope['version'] !== 1) {
    throw new Error('Fort signer material has an unsupported version');
  }
  const runs = envelope['runs'];
  if (typeof runs !== 'object' || runs === null || Array.isArray(runs)) {
    throw new Error('Fort signer material has an invalid runs map');
  }

  const seedsByRun = new Map<string, SignerSeeds>();
  for (const [runId, value] of Object.entries(runs)) {
    const seeds = parseSeedSet(value);
    if (runId.length === 0 || seeds === undefined) {
      throw new Error('Fort signer material contains an invalid run entry');
    }
    seedsByRun.set(runId, seeds);
  }

  return (runId: string): SignerRegistry => {
    const seeds = seedsByRun.get(runId);
    if (seeds === undefined) {
      throw new Error('Fort signer material does not authorize the requested run');
    }
    return InMemorySignerRegistry.fromSeeds(runId, seeds);
  };
}

/**
 * Consumes only Fort's file-path environment contract. Direct secret values
 * are refused, and the path variable is removed before any child can inherit it.
 */
export function signerProviderFromFortEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): (runId: string) => SignerRegistry {
  if (environment[FORBIDDEN_SIGNER_SEEDS_VALUE_ENV] !== undefined) {
    throw new Error('direct signer seed environment values are forbidden');
  }
  const path = environment[FORT_SIGNER_SEEDS_FILE_ENV];
  delete environment[FORT_SIGNER_SEEDS_FILE_ENV];
  if (path === undefined || path.length === 0) {
    throw new Error('Fort signer material file is required');
  }
  return signerProviderFromFortFile(path);
}
