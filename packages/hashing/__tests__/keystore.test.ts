import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GENESIS_HASH,
  SIGNER_DOMAINS,
  SIGNER_KEY_IDS,
  type SignerDomain,
} from '@ald/types';

import {
  FileKeyStore,
  SIGNER_SEED_FILE,
  buildSignedEvent,
  validateChain,
  verifyHashSignature,
} from '../src/index.js';

const skipModes = process.platform === 'win32';

let keyDir: string;
let store: FileKeyStore;

beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'ald-keystore-'));
  store = new FileKeyStore(join(keyDir, 'keys'));
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

function seedsOf(runId: string): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(store.seedFile(runId), 'utf8'),
  );
  const seeds = (raw as { seeds: Record<string, string> }).seeds;
  return Object.values(seeds);
}

describe('FileKeyStore provisioning (ALD-009, LEDGER §11)', () => {
  it('provisions one key per signer domain and reports the run', () => {
    expect(store.hasRun('run-p1')).toBe(false);
    const registry = store.provisionRun('run-p1');
    expect(store.hasRun('run-p1')).toBe(true);
    expect(registry.runId).toBe('run-p1');
    expect(registry.domains().sort()).toEqual([...SIGNER_DOMAINS].sort());
    expect(registry.publicKeys().map((key) => key.keyId).sort()).toEqual(
      SIGNER_DOMAINS.map((domain) => SIGNER_KEY_IDS[domain]).sort(),
    );
    expect(new Set(registry.publicKeys().map((key) => key.publicKey)).size).toBe(
      SIGNER_DOMAINS.length,
    );
  });

  it('refuses to overwrite an existing run and never rotates in place', () => {
    const registry = store.provisionRun('run-p2');
    expect(() => store.provisionRun('run-p2')).toThrow(/already exist/u);
    expect(store.publicKeys('run-p2')).toEqual(registry.publicKeys());
  });

  it('reproduces the same public keys and signatures after loadRun', async () => {
    const provisioned = store.provisionRun('run-p3');
    const loaded = store.loadRun('run-p3');
    expect(loaded.publicKeys()).toEqual(provisioned.publicKeys());
    expect(store.publicKeys('run-p3')).toEqual(provisioned.publicKeys());

    const hash = GENESIS_HASH;
    for (const domain of SIGNER_DOMAINS) {
      const signature = await loaded.signer(domain).sign(hash);
      const publicKey = provisioned.signer(domain).publicKey;
      expect(verifyHashSignature(hash, signature, publicKey)).toBe(true);
      expect(await provisioned.signer(domain).sign(hash)).toBe(signature);
    }
  });

  it('produces distinct public keys for every run (per-run rotation)', () => {
    const first = store.provisionRun('run-r1');
    const second = store.provisionRun('run-r2');
    for (const domain of SIGNER_DOMAINS) {
      expect(second.signer(domain).publicKey).not.toBe(
        first.signer(domain).publicKey,
      );
      // Same stable key identifier, different per-run key material.
      expect(second.signer(domain).keyId).toBe(first.signer(domain).keyId);
    }
  });

  it('can provision a subset of domains', () => {
    const domains: readonly SignerDomain[] = ['channel', 'witness'];
    const registry = store.provisionRun('run-subset', domains);
    expect(registry.domains().sort()).toEqual(['channel', 'witness']);
    expect(store.loadRun('run-subset').domains().sort()).toEqual([
      'channel',
      'witness',
    ]);
    expect(() => registry.signer('baby-a-ledger')).toThrow(/No signer/u);
    expect(() => store.provisionRun('run-empty', [])).toThrow(/at least one/iu);
  });
});

describe('FileKeyStore on-disk protection', () => {
  it('stores only runId and hex seeds, never keys or evidence fields', () => {
    store.provisionRun('run-file');
    const text = readFileSync(store.seedFile('run-file'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const parsed: unknown = JSON.parse(text);
    expect(Object.keys(parsed as object)).toEqual(['runId', 'seeds']);
    const seeds = (parsed as { seeds: Record<string, string> }).seeds;
    expect(Object.keys(seeds).sort()).toEqual([...SIGNER_DOMAINS].sort());
    for (const seed of Object.values(seeds)) {
      expect(seed).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(text).not.toContain('ed25519-pub:');
    expect(text).not.toContain('keyId');
    expect(text).not.toContain('publicKey');
    expect(store.seedFile('run-file').endsWith(SIGNER_SEED_FILE)).toBe(true);
  });

  it('keeps the run directory 0o700 and the seed file 0o600', () => {
    store.provisionRun('run-modes');
    if (skipModes) {
      return;
    }
    const file = store.seedFile('run-modes');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
  });

  it('never exposes seed material through the public-key surface', () => {
    const registry = store.provisionRun('run-secrets');
    const seeds = seedsOf('run-secrets');
    const exposed = [
      JSON.stringify(registry.publicKeys()),
      JSON.stringify(store.publicKeys('run-secrets')),
      registry
        .publicKeys()
        .map((key) => `${key.domain}${key.keyId}${key.publicKey}`)
        .join(''),
    ].join('|');
    expect(seeds).toHaveLength(SIGNER_DOMAINS.length);
    for (const seed of seeds) {
      expect(exposed).not.toContain(seed);
    }
    for (const key of registry.publicKeys()) {
      expect(Object.keys(key).sort()).toEqual(['domain', 'keyId', 'publicKey']);
    }
  });

  it('rejects unsafe run identifiers instead of escaping the key directory', () => {
    for (const runId of ['../escape', 'a/b', '', '.', './x', '-leading']) {
      expect(() => store.provisionRun(runId)).toThrow(/runId/u);
      expect(() => store.hasRun(runId)).toThrow(/runId/u);
    }
  });
});

describe('FileKeyStore loading failures', () => {
  it('throws for a run that was never provisioned', () => {
    expect(() => store.loadRun('run-missing')).toThrow(/No signer keys/u);
    expect(() => store.publicKeys('run-missing')).toThrow(/No signer keys/u);
  });

  it('rejects a tampered or foreign seed file', () => {
    store.provisionRun('run-tampered');
    const file = store.seedFile('run-tampered');
    const original: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const rewrite = (value: unknown): void => {
      writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
    };

    rewrite({ ...(original as object), runId: 'run-other' });
    expect(() => store.loadRun('run-tampered')).toThrow(/refusing to load/u);

    rewrite({ runId: 'run-tampered', seeds: { channel: 'not-hex' } });
    expect(() => store.loadRun('run-tampered')).toThrow(/64 lowercase hex/u);

    rewrite({ runId: 'run-tampered', seeds: { 'anchor-wallet': 'a'.repeat(64) } });
    expect(() => store.loadRun('run-tampered')).toThrow(/Unknown signer domain/u);

    rewrite({ runId: 'run-tampered', seeds: {} });
    expect(() => store.loadRun('run-tampered')).toThrow(/no seeds/u);

    rewrite([1, 2, 3]);
    expect(() => store.loadRun('run-tampered')).toThrow(/JSON object/u);
  });
});

describe('provisioned keys signing a real chain end to end', () => {
  it('signs and verifies Baby A events under the manifest public key', async () => {
    const registry = store.provisionRun('run-chain');
    const manifestKey = store
      .publicKeys('run-chain')
      .find((key) => key.domain === 'baby-a-ledger')?.publicKey;

    const events: Record<string, unknown>[] = [];
    let previousEntryHash = GENESIS_HASH;
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const event = await buildSignedEvent(
        'baby-a-ledger',
        {
          version: 1,
          runId: 'run-chain',
          babyId: 'A',
          sequence,
          turn: sequence,
          eventType: 'intention.recorded',
          contentSchema: 'agent-native-ledger',
          subjectId: `subject-${sequence}`,
          content: { artifactRef: `a-${sequence}` },
          blindingNonce: `base64:n${sequence}`,
          previousEntryHash,
          recordedAt: `2026-08-24T21:0${sequence}:00.000Z`,
          writerKeyId: SIGNER_KEY_IDS['baby-a-ledger'],
        },
        registry.signer('baby-a-ledger'),
      );
      events.push(event);
      previousEntryHash = event.entryHash;
    }

    expect(
      validateChain('baby-a-ledger', events, {
        runId: 'run-chain',
        babyId: 'A',
        requireSignatures: true,
        publicKey: manifestKey,
      }).ok,
    ).toBe(true);

    // A key from a different run cannot validate this run's events.
    const otherRunKey = store
      .publicKeys('run-p1')
      .find((key) => key.domain === 'baby-a-ledger')?.publicKey;
    expect(
      validateChain('baby-a-ledger', events, {
        requireSignatures: true,
        publicKey: otherRunKey,
      }).violations.map((violation) => violation.code),
    ).toEqual(['signature-invalid', 'signature-invalid', 'signature-invalid']);
  });
});
