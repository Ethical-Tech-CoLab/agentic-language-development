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

interface ProvisionedSigner extends DomainSigner {
  readonly seed: Buffer;
}

function provision(
  domain: SignerDomain,
  privateKey: KeyObject,
  seed: Buffer,
): ProvisionedSigner {
  const publicKey = publicKeyFromPrivate(privateKey);
  return {
    domain,
    keyId: SIGNER_KEY_IDS[domain],
    publicKey,
    seed,
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
  private readonly signers = new Map<SignerDomain, ProvisionedSigner>();

  private constructor(public readonly runId: string) {}

  static generate(
    runId: string,
    domains: readonly SignerDomain[] = SIGNER_DOMAINS,
  ): InMemorySignerRegistry {
    const registry = new InMemorySignerRegistry(runId);
    for (const domain of domains) {
      const pair = generateEd25519KeyPair();
      registry.signers.set(domain, provision(domain, pair.privateKey, pair.seed));
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
      registry.signers.set(
        domain,
        provision(domain, privateKeyFromSeed(seed), seed),
      );
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
      [...this.signers.entries()].map(([domain, signer]) => [
        domain,
        signer.seed.toString('hex'),
      ]),
    );
  }
}
