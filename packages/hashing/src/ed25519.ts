import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import { decodeHash } from './sha256.js';

// DER prefixes for raw Ed25519 keys (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PUBLIC_KEY_PATTERN = /^ed25519-pub:([A-Za-z0-9+/]+=*)$/u;
const SIGNATURE_PATTERN = /^ed25519:([A-Za-z0-9+/]+=*)$/u;

export interface Ed25519KeyPair {
  /** `ed25519-pub:<base64 raw 32 bytes>` */
  publicKey: string;
  privateKey: KeyObject;
  /** 32-byte private seed; persist only inside an isolated key store. */
  seed: Buffer;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: encodePublicKey(publicKey),
    privateKey,
    seed: privateKeySeed(privateKey),
  };
}

export function encodePublicKey(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  return `ed25519-pub:${Buffer.from(raw).toString('base64')}`;
}

export function decodePublicKey(encoded: string): KeyObject {
  const match = PUBLIC_KEY_PATTERN.exec(encoded);
  const base64 = match?.[1];
  if (!base64) {
    throw new Error('Invalid Ed25519 public key encoding');
  }
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function publicKeyFromPrivate(privateKey: KeyObject): string {
  return encodePublicKey(createPublicKey(privateKey));
}

export function privateKeySeed(key: KeyObject): Buffer {
  const der = key.export({ type: 'pkcs8', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new Error('Ed25519 seed must be 32 bytes');
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Sign the 32 raw bytes of an encoded hash. Returns `ed25519:<base64>`. */
export function signHash(hash: string, privateKey: KeyObject): string {
  const signature = sign(null, decodeHash(hash), privateKey);
  return `ed25519:${signature.toString('base64')}`;
}

/** Returns false (never throws) for malformed input or a bad signature. */
export function verifyHashSignature(
  hash: string,
  signature: string,
  publicKey: string,
): boolean {
  const match = SIGNATURE_PATTERN.exec(signature);
  const base64 = match?.[1];
  if (!base64) {
    return false;
  }
  try {
    const raw = Buffer.from(base64, 'base64');
    if (raw.length !== 64) {
      return false;
    }
    return verify(null, decodeHash(hash), decodePublicKey(publicKey), raw);
  } catch {
    return false;
  }
}
