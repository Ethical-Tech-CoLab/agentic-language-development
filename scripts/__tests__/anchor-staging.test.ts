/**
 * ALD-020 / ALD-022 — staging-gate unit suite.
 *
 * Covers the pure refusal matrix, explorer URL builder, and argument parsing
 * in `scripts/anchor-staging-gate.mjs`. The gate runs before any file, key, or
 * RPC access, so these tests need no fixtures and touch no network. The live
 * dry-run/broadcast paths in `scripts/anchor-public-submit.mjs` are verified
 * manually against public RPC (read-only) and documented in
 * `docs/anchor-staging.md`.
 */
import { ANCHOR_CHAIN_IDS } from '@ald/anchor';
import { describe, expect, it } from 'vitest';

import {
  MAINNET_ENV_VAR,
  PUBLIC_ANCHOR_NETWORKS,
  StagingGateError,
  assertMainnetBroadcastConfirmed,
  assertNetworkAllowed,
  endpointLabelFor,
  explorerTxUrl,
  parsePublicSubmitArgs,
} from '../anchor-staging-gate.mjs';

const TX = `0x${'ab'.repeat(32)}`;
const FROM = `0x${'c1'.repeat(20)}`;
const TO = `0x${'d0'.repeat(20)}`;
const CHECKPOINT = `sha256:${'3f'.repeat(32)}`;

describe('staging gate chain identity', () => {
  it('matches the authoritative @ald/anchor chain ids', () => {
    expect(PUBLIC_ANCHOR_NETWORKS['base-sepolia'].chainId).toBe(ANCHOR_CHAIN_IDS['base-sepolia']);
    expect(PUBLIC_ANCHOR_NETWORKS['base-mainnet'].chainId).toBe(ANCHOR_CHAIN_IDS['base-mainnet']);
    expect(MAINNET_ENV_VAR).toBe('ALD_ALLOW_MAINNET_ANCHORING');
  });
});

describe('assertNetworkAllowed (ALD-022 double opt-in)', () => {
  it('always allows Base Sepolia without opt-ins', () => {
    expect(assertNetworkAllowed({ network: 'base-sepolia', env: {} })).toBeUndefined();
  });

  it('refuses mainnet with neither opt-in', () => {
    let failure;
    try {
      assertNetworkAllowed({ network: 'base-mainnet', env: {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.code).toBe('MAINNET_ANCHORING_DISABLED');
    expect(failure.reason).toBe('both');
  });

  it('refuses mainnet with only the CLI flag', () => {
    let failure;
    try {
      assertNetworkAllowed({ network: 'base-mainnet', allowMainnet: true, env: {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.reason).toBe('missing-env');
  });

  it('refuses mainnet with only the environment flag', () => {
    let failure;
    try {
      assertNetworkAllowed({
        network: 'base-mainnet',
        env: { [MAINNET_ENV_VAR]: 'true' },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.reason).toBe('missing-option');
  });

  it('allows mainnet with both opt-ins', () => {
    expect(assertNetworkAllowed({
      network: 'base-mainnet',
      allowMainnet: true,
      env: { [MAINNET_ENV_VAR]: 'true' },
    })).toBeUndefined();
  });
});

describe('assertMainnetBroadcastConfirmed', () => {
  it('refuses mainnet broadcast without the confirm flag', () => {
    expect(() => assertMainnetBroadcastConfirmed({ confirmed: false }))
      .toThrowError(StagingGateError);
    try {
      assertMainnetBroadcastConfirmed({ confirmed: false });
    } catch (error) {
      expect(error.code).toBe('MAINNET_BROADCAST_UNCONFIRMED');
      return;
    }
    expect.unreachable();
  });

  it('passes with the confirm flag (given only after chat approval)', () => {
    expect(assertMainnetBroadcastConfirmed({ confirmed: true })).toBeUndefined();
  });
});

describe('explorerTxUrl', () => {
  it('builds Sepolia and mainnet explorer links', () => {
    expect(explorerTxUrl('base-sepolia', TX)).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    expect(explorerTxUrl('base-mainnet', TX)).toBe(`https://basescan.org/tx/${TX}`);
  });

  it('rejects unknown networks and malformed hashes', () => {
    expect(() => explorerTxUrl('base-goerli', TX)).toThrowError(StagingGateError);
    expect(() => explorerTxUrl('base-sepolia', '0xdead')).toThrowError(StagingGateError);
  });
});

describe('endpointLabelFor', () => {
  it('keeps the host and drops userinfo, path, and query', () => {
    expect(endpointLabelFor('https://user:pass@rpc.example.test:8545/v2/key?x=1'))
      .toBe('rpc.example.test:8545');
  });

  it('falls back to rpc for invalid URLs', () => {
    expect(endpointLabelFor('not a url')).toBe('rpc');
  });
});

describe('parsePublicSubmitArgs', () => {
  it('parses --help without requiring other flags', () => {
    expect(parsePublicSubmitArgs(['--help']).mode).toBe('help');
    expect(parsePublicSubmitArgs(['--dry-run', '--help']).mode).toBe('help');
  });

  it('rejects a missing or unknown mode', () => {
    expect(() => parsePublicSubmitArgs([])).toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs(['--send'])).toThrowError(StagingGateError);
  });

  it('parses --generate-key with a key file', () => {
    const args = parsePublicSubmitArgs(['--generate-key', '--key-file', '/tmp/k.key']);
    expect(args.mode).toBe('generate-key');
    expect(args.keyFile).toBe('/tmp/k.key');
  });

  it('requires --key-file for --generate-key', () => {
    expect(() => parsePublicSubmitArgs(['--generate-key'])).toThrowError(StagingGateError);
  });

  it('parses a full --dry-run', () => {
    const args = parsePublicSubmitArgs([
      '--dry-run',
      '--network', 'base-sepolia',
      '--rpc-url-file', '/tmp/rpc.url',
      '--from', FROM,
      '--to', TO,
      '--checkpoint-hash', CHECKPOINT,
      '--out', '/tmp/dry.json',
    ]);
    expect(args).toMatchObject({
      mode: 'dry-run',
      network: 'base-sepolia',
      rpcUrlFile: '/tmp/rpc.url',
      from: FROM,
      to: TO,
      checkpointHash: CHECKPOINT,
      out: '/tmp/dry.json',
      allowMainnet: false,
    });
  });

  it('requires --from for --dry-run and --key-file for --broadcast', () => {
    expect(() => parsePublicSubmitArgs([
      '--dry-run', '--rpc-url-file', 'r', '--to', TO,
      '--checkpoint-hash', CHECKPOINT, '--out', 'o',
    ])).toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs([
      '--broadcast', '--rpc-url-file', 'r', '--to', TO,
      '--checkpoint-hash', CHECKPOINT, '--out', 'o',
    ])).toThrowError(StagingGateError);
  });

  it('accepts a checkpoint manifest instead of a raw hash', () => {
    const args = parsePublicSubmitArgs([
      '--broadcast', '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
      '--checkpoint-manifest', 'checkpoints/000001.json', '--out', 'o',
    ]);
    expect(args.checkpointManifest).toBe('checkpoints/000001.json');
  });

  it('rejects bad networks, addresses, and checkpoint refs', () => {
    const base = ['--dry-run', '--rpc-url-file', 'r', '--from', FROM, '--to', TO, '--out', 'o'];
    expect(() => parsePublicSubmitArgs([...base, '--network', 'base-goerli', '--checkpoint-hash', CHECKPOINT]))
      .toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs(
      ['--dry-run', '--rpc-url-file', 'r', '--from', 'nope', '--to', TO, '--checkpoint-hash', CHECKPOINT, '--out', 'o'],
    )).toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs([...base, '--checkpoint-hash', '0xdeadbeef']))
      .toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs(base)).toThrowError(StagingGateError);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parsePublicSubmitArgs(['--dry-run', '--bogus', 'x'])).toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs(['--dry-run', '--to'])).toThrowError(StagingGateError);
  });

  it('parses mainnet opt-in and confirm flags', () => {
    const args = parsePublicSubmitArgs([
      '--broadcast', '--network', 'base-mainnet', '--rpc-url-file', 'r',
      '--key-file', 'k', '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--out', 'o', '--allow-mainnet', '--confirm-mainnet-broadcast',
    ]);
    expect(args.allowMainnet).toBe(true);
    expect(args.confirmMainnetBroadcast).toBe(true);
  });
});
