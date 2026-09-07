import type { KeyObject } from 'node:crypto';

import {
  SIGNER_DOMAINS,
  SIGNER_KEY_IDS,
  type DomainSigner,
  type SignerDomain,
  type SignerPublicKey,
  type SignerRegistry,
} from '@ald/types';

import {
  generateEd25519KeyPair,
  privateKeyFromSeed,
  publicKeyFromPrivate,
  signHash,
} from './ed25519.js';

/**
 * Build the public face of a domain signer.
 *
 * The returned object carries exactly the four members of the
 * `DomainSigner` contract (`packages/types/src/contracts.ts`) — no seed and no
 * key object — so spreading, `Object.keys`, `JSON.stringify`, or any
 * structured log of a signer can never emit private key material
 * (LEDGER §11; SPEC §13.5: signing keys are never exposed to model context or
 * tools). The private key lives only in the `sign` closure; the seed lives
 * only in {@link InMemorySignerRegistry}'s private seed map, which
 * {@link InMemorySignerRegistry.exportSeeds} is the sole reader of.
 */
function provision(domain: SignerDomain, privateKey: KeyObject): DomainSigner {
  const publicKey = publicKeyFromPrivate(privateKey);
  return {
    domain,
    keyId: SIGNER_KEY_IDS[domain],
    publicKey,
    sign: async (hash: string) => signHash(hash, privateKey),
  };
}

/**
 * Per-run Ed25519 signers, one key per domain (LEDGER §11). Each
 * `DomainSigner` holds exactly one private key and can therefore only produce
 * signatures for its own domain. The file-backed key store (ALD-009) persists
 * `exportSeeds()` outside the repository and restores with `fromSeeds()`.
 */
export class InMemorySignerRegistry implements SignerRegistry {
  private readonly signers = new Map<SignerDomain, DomainSigner>();

  /** Private per-domain seeds, read only by {@link exportSeeds}. */
  private readonly seeds = new Map<SignerDomain, Buffer>();

  private constructor(public readonly runId: string) {}

  static generate(
    runId: string,
    domains: readonly SignerDomain[] = SIGNER_DOMAINS,
  ): InMemorySignerRegistry {
    const registry = new InMemorySignerRegistry(runId);
    for (const domain of domains) {
      const pair = generateEd25519KeyPair();
      registry.signers.set(domain, provision(domain, pair.privateKey));
      registry.seeds.set(domain, pair.seed);
    }
    return registry;
  }

  static fromSeeds(
    runId: string,
    seeds: Partial<Record<SignerDomain, Uint8Array | string>>,
  ): InMemorySignerRegistry {
    const registry = new InMemorySignerRegistry(runId);
    for (const domain of SIGNER_DOMAINS) {
      const material = seeds[domain];
      if (material === undefined) {
        continue;
      }
      const seed =
        typeof material === 'string'
          ? Buffer.from(material, 'hex')
          : Buffer.from(material);
      registry.signers.set(domain, provision(domain, privateKeyFromSeed(seed)));
      registry.seeds.set(domain, seed);
    }
    return registry;
  }

  domains(): SignerDomain[] {
    return [...this.signers.keys()];
  }

  signer(domain: SignerDomain): DomainSigner {
    const signer = this.signers.get(domain);
    if (!signer) {
      throw new Error(`No signer provisioned for domain ${domain}`);
    }
    return signer;
  }

  publicKeys(): SignerPublicKey[] {
    return [...this.signers.values()].map(({ domain, keyId, publicKey }) => ({
      domain,
      keyId,
      publicKey,
    }));
  }

  /** Hex seeds for persistence by an isolated key store. Never export into evidence. */
  exportSeeds(): Record<string, string> {
    return Object.fromEntries(
      [...this.seeds.entries()].map(([domain, seed]) => [
        domain,
        seed.toString('hex'),
      ]),
    );
  }
}
