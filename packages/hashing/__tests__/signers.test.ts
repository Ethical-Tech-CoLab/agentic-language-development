/**
 * Regression tests for the signer projection boundary (LEDGER §11 key
 * management; SPEC §13.5 — signing keys are never exposed to model context or
 * tools; `DomainSigner` in packages/types/src/contracts.ts).
 *
 * A `DomainSigner` must carry exactly `{ domain, keyId, publicKey, sign }`.
 * `provision()` previously also set an own enumerable `seed` property, so any
 * spread, `Object.keys`, or `JSON.stringify` of a signer emitted the 32-byte
 * per-run Ed25519 private seed. Seeds now live in a private registry map that
 * only `exportSeeds()` reads.
 */
import { describe, expect, it } from 'vitest';

import { SIGNER_DOMAINS, SIGNER_KEY_IDS } from '@ald/types';

import {
  InMemorySignerRegistry,
  domainHash,
  verifyHashSignature,
} from '../src/index.js';

const RUN_ID = 'run-signer-shape';

describe('DomainSigner never carries private key material', () => {
  it('exposes exactly the four contract members', () => {
    const registry = InMemorySignerRegistry.generate(RUN_ID);
    for (const domain of SIGNER_DOMAINS) {
      const signer = registry.signer(domain);
      expect(Object.keys(signer).sort()).toEqual([
        'domain',
        'keyId',
        'publicKey',
        'sign',
      ]);
      expect(Object.keys({ ...signer })).not.toContain('seed');
      expect('seed' in signer).toBe(false);
    }
  });

  it('never serializes a seed, in any encoding', () => {
    // A fixed seed per domain makes every encoding below a deterministic
    // needle, so the assertions cannot pass or fail by chance.
    const fixed = Object.fromEntries(
      SIGNER_DOMAINS.map((domain, index) => [
        domain,
        Buffer.alloc(32, index + 1).toString('hex'),
      ]),
    ) as Record<(typeof SIGNER_DOMAINS)[number], string>;
    const registry = InMemorySignerRegistry.fromSeeds(RUN_ID, fixed);
    expect(registry.exportSeeds()).toEqual(fixed);

    for (const domain of SIGNER_DOMAINS) {
      const hex = fixed[domain];
      const bytes = Buffer.from(hex, 'hex');
      const serialized = JSON.stringify(registry.signer(domain));
      expect(serialized).not.toContain('seed');
      expect(serialized).not.toContain(hex);
      expect(serialized).not.toContain(bytes.toString('base64'));
      // The `{"type":"Buffer","data":[…]}` form a Buffer property would take.
      expect(serialized).not.toContain('Buffer');
      expect(serialized).not.toContain(JSON.stringify([...bytes]).slice(1, -1));
      expect(JSON.stringify(registry)).not.toContain(hex);
      // Also true of the generated registry, which never sees these seeds.
      const generated = InMemorySignerRegistry.generate(RUN_ID);
      expect(JSON.stringify(generated.signer(domain))).not.toContain(
        generated.exportSeeds()[domain] ?? 'unreachable',
      );
    }
  });

  it('still signs, restores from seeds, and exports the same seeds', async () => {
    const registry = InMemorySignerRegistry.generate(RUN_ID);
    const seeds = registry.exportSeeds();
    expect(Object.keys(seeds).sort()).toEqual([...SIGNER_DOMAINS].sort());

    const restored = InMemorySignerRegistry.fromSeeds(RUN_ID, seeds);
    expect(restored.exportSeeds()).toEqual(seeds);
    expect(restored.domains().sort()).toEqual([...SIGNER_DOMAINS].sort());
    expect(restored.publicKeys()).toEqual(registry.publicKeys());

    const hash = domainHash('dtsf-test-v1', 'event');
    for (const domain of SIGNER_DOMAINS) {
      const signer = registry.signer(domain);
      expect(signer.domain).toBe(domain);
      expect(signer.keyId).toBe(SIGNER_KEY_IDS[domain]);
      const signature = await signer.sign(hash);
      expect(verifyHashSignature(hash, signature, signer.publicKey)).toBe(true);
      expect(await restored.signer(domain).sign(hash)).toBe(signature);
    }
  });
});
