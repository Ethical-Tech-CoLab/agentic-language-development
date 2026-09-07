/**
 * @ald/hashing — cryptographic primitives shared by every evidence component:
 * domain-separated SHA-256, RFC 8785 canonical JSON, Ed25519 signing, per-run
 * signer registries, and the deterministic seeded PRNG.
 *
 * Hash-chain construction/validation and the file-backed key store are added
 * by ALD-008 / ALD-009 in `chain.ts` and `keystore.ts`.
 */
export {
  canonicalJson,
  parseCanonicalJson,
} from './canonical.js';
export {
  computeEntryHash,
  decodeHash,
  domainHash,
  encodeHash,
  hashCanonical,
  hashCarrierMark,
  hashRunId,
  isSha256Hash,
  omitFields,
  sha256Bytes,
  toBytes,
  uint64BE,
  type HashSeparator,
} from './sha256.js';
export {
  decodePublicKey,
  encodePublicKey,
  generateEd25519KeyPair,
  privateKeyFromSeed,
  privateKeySeed,
  publicKeyFromPrivate,
  signHash,
  verifyHashSignature,
  type Ed25519KeyPair,
} from './ed25519.js';
export { SeededPrng, deriveSeedHex } from './prng.js';
export { InMemorySignerRegistry } from './signers.js';
