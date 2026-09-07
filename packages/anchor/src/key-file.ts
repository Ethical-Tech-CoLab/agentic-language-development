/**
 * ALD-019 — anchoring signer key management (LEDGER-INTEGRITY-DESIGN.md §11,
 * SPEC §13.5, §19 ADR-02).
 *
 * The on-chain anchor wallet is a *separate key kind* from every event and
 * witness key: those are per-run Ed25519 keys generated inside the isolated
 * signer services (`@ald/hashing` `FileKeyStore` / `InMemorySignerRegistry`)
 * and recorded in the run manifest as public keys, while this is one
 * long-lived secp256k1 wallet key that funds transactions. Neither can be
 * derived from the other: different curves, different files, different
 * lifetimes, and nothing in this module ever reads or writes the event
 * key store.
 *
 * **Rotation** is intentionally trivial: write a new key file and construct a
 * new publisher with a transport built from it. Receipts already stored keep
 * their own `from` address and stay verifiable forever, because verification
 * (see `verify-anchor.ts`) never consults a wallet key — only chain data and
 * the receipt's own fields.
 *
 * The private key is never logged, never telemetered, never returned inside
 * an error, and never written into an evidence bundle: `AnchorKeyFileError`
 * carries the path and a reason only, and every value returned from here is
 * handed straight to viem's local account.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { AnchorKeyFileError } from './errors.js';

export type HexString = `0x${string}`;

/** Octal permission bits that must be clear on a POSIX key file. */
export const FORBIDDEN_KEY_FILE_MODE_BITS = 0o077;

/** Mode `writeAnchorKeyFile` creates: owner read/write only. */
export const ANCHOR_KEY_FILE_MODE = 0o600;

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

export interface AnchorKey {
  /** secp256k1 private key, `0x` + 64 lowercase hex. Never log this. */
  privateKey: HexString;
  /** Checksummed address derived from {@link AnchorKey.privateKey}. */
  address: HexString;
}

export interface LoadAnchorKeyFileOptions {
  /**
   * Skip the POSIX permission check. Intended only for environments where
   * file modes are not meaningful (mounted secrets, Windows); it is never a
   * default (LEDGER §11).
   */
  allowInsecurePermissions?: boolean;
}

/** Validate and normalize a key without ever including it in a message. */
function normalizePrivateKey(path: string, candidate: string): HexString {
  if (!PRIVATE_KEY_PATTERN.test(candidate)) {
    throw new AnchorKeyFileError(
      path,
      'expected exactly one 0x-prefixed 32-byte hex private key (the key itself is never logged)',
    );
  }
  return `0x${candidate.slice(2).toLowerCase()}` as HexString;
}

function toAnchorKey(privateKey: HexString): AnchorKey {
  return {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
  };
}

/**
 * Read the anchor wallet key from `path`.
 *
 * Refuses a file whose mode grants any group or other permission on POSIX,
 * because a readable anchor key is a spendable anchor key.
 */
export async function loadAnchorKeyFile(
  path: string,
  options: LoadAnchorKeyFileOptions = {},
): Promise<AnchorKey> {
  let stats;
  try {
    stats = await stat(path);
  } catch (cause) {
    throw new AnchorKeyFileError(path, 'cannot be read', { cause });
  }

  if (!stats.isFile()) {
    throw new AnchorKeyFileError(path, 'is not a regular file');
  }

  const insecureBits = stats.mode & FORBIDDEN_KEY_FILE_MODE_BITS;
  if (
    process.platform !== 'win32' &&
    insecureBits !== 0 &&
    options.allowInsecurePermissions !== true
  ) {
    throw new AnchorKeyFileError(
      path,
      `mode ${(stats.mode & 0o777).toString(8).padStart(3, '0')} allows group/other access; ` +
        `run 'chmod 600' on it or pass allowInsecurePermissions`,
    );
  }

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (cause) {
    throw new AnchorKeyFileError(path, 'cannot be read', { cause });
  }

  return toAnchorKey(normalizePrivateKey(path, contents.trim()));
}

/**
 * Write a new anchor key file with mode 0600, refusing to clobber an existing
 * file (`wx`) so rotation never silently destroys the previous wallet key.
 */
export async function writeAnchorKeyFile(
  path: string,
  privateKey: string,
): Promise<AnchorKey> {
  const normalized = normalizePrivateKey(path, privateKey.trim());
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${normalized}\n`, {
      encoding: 'utf8',
      mode: ANCHOR_KEY_FILE_MODE,
      flag: 'wx',
    });
  } catch (cause) {
    throw new AnchorKeyFileError(path, 'could not be created', { cause });
  }
  // `mode` is masked by the process umask on creation; enforce it explicitly.
  if (process.platform !== 'win32') {
    await chmod(path, ANCHOR_KEY_FILE_MODE);
  }
  return toAnchorKey(normalized);
}

/**
 * Generate a fresh anchor wallet key in memory (viem `generatePrivateKey`).
 * Persist it with {@link writeAnchorKeyFile}; a dedicated, low-balance wallet
 * with no other authority is the documented development custody model
 * (SPEC §19 ADR-02), with a managed signer required before mainnet runs.
 */
export function generateAnchorKey(): AnchorKey {
  return toAnchorKey(generatePrivateKey());
}
