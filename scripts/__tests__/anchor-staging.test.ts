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
  assertSepoliaChainId,
  checkCriterionBox,
  countCriteria,
  decideFunding,
  endpointLabelFor,
  explorerTxUrl,
  parseFaucetWatchArgs,
  parsePublicSubmitArgs,
  syncBacklogCount,
  syncSnapshotLine,
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

describe('assertSepoliaChainId (faucet-watch is Sepolia-only)', () => {
  it('accepts 84532', () => {
    expect(assertSepoliaChainId(84532)).toBeUndefined();
  });

  it('rejects mainnet and unknown chains', () => {
    for (const chainId of [8453, 1, 11155111]) {
      try {
        assertSepoliaChainId(chainId);
      } catch (error) {
        expect(error).toBeInstanceOf(StagingGateError);
        expect(error.code).toBe('WRONG_CHAIN');
        continue;
      }
      expect.unreachable(`chain ${chainId} must be refused`);
    }
  });
});

describe('decideFunding', () => {
  it('funds surplus and exact balances with zero shortfall', () => {
    expect(decideFunding({ balanceWei: '5', requiredWei: '3' })).toEqual({ funded: true, shortfallWei: '0' });
    expect(decideFunding({ balanceWei: '3', requiredWei: '3' })).toEqual({ funded: true, shortfallWei: '0' });
  });

  it('reports the shortfall below the requirement', () => {
    expect(decideFunding({ balanceWei: '1', requiredWei: '3' })).toEqual({ funded: false, shortfallWei: '2' });
  });

  it('never funds a zero balance, even with a zero estimate', () => {
    expect(decideFunding({ balanceWei: '0', requiredWei: '0' }).funded).toBe(false);
    expect(decideFunding({ balanceWei: '0', requiredWei: '3' }).funded).toBe(false);
  });

  it('rejects negative and non-numeric inputs', () => {
    expect(() => decideFunding({ balanceWei: '-1', requiredWei: '3' })).toThrowError(StagingGateError);
    expect(() => decideFunding({ balanceWei: 'abc', requiredWei: '3' })).toThrowError(StagingGateError);
  });
});

const BACKLOG_FIXTURE = [
  '# Backlog',
  '',
  '- **Status:** Implementation active, with 1 of 3 acceptance criteria verified.',
  '',
  '#### ALD-020 — Base Sepolia anchoring client',
  '- **Scope:** submit roots.',
  '- **Acceptance criteria:**',
  '  - [ ] A submitted checkpoint root is independently observable on a public explorer.',
  '  - [x] The default configuration anchors to Base Sepolia.',
  '',
  '#### ALD-998 — Confirmation',
  '- **Acceptance criteria:**',
  '  - [ ] A receipt is marked confirmed only after depth.',
  '',
].join('\n');

describe('backlog close-out helpers', () => {
  it('counts boxes the way the project-status checker does', () => {
    expect(countCriteria(BACKLOG_FIXTURE)).toEqual({ checked: 1, total: 3 });
  });

  it('checks the targeted box and preserves statement text', () => {
    const updated = checkCriterionBox(BACKLOG_FIXTURE, 'ALD-020', 'A submitted checkpoint root is independently observable');
    expect(updated).toContain('  - [x] A submitted checkpoint root is independently observable on a public explorer.');
    expect(countCriteria(updated)).toEqual({ checked: 2, total: 3 });
    // The other section is untouched.
    expect(updated).toContain('  - [ ] A receipt is marked confirmed only after depth.');
  });

  it('refuses missing sections, missing statements, and double-apply', () => {
    expect(() => checkCriterionBox(BACKLOG_FIXTURE, 'ALD-999', 'Anything')).toThrowError(StagingGateError);
    expect(() => checkCriterionBox(BACKLOG_FIXTURE, 'ALD-020', 'No such statement')).toThrowError(StagingGateError);
    expect(() => checkCriterionBox(BACKLOG_FIXTURE, 'ALD-020', 'The default configuration anchors')).toThrowError(StagingGateError);
  });

  it('syncs the backlog count line', () => {
    const updated = syncBacklogCount(BACKLOG_FIXTURE, 2, 3);
    expect(updated).toContain('with 2 of 3 acceptance criteria verified');
    expect(() => syncBacklogCount('no status here', 2, 3)).toThrowError(StagingGateError);
  });

  it('syncs only the current-version snapshot line', () => {
    const text = [
      '**Engineering snapshot:** v0.1.529 · 258/261 backlog acceptance criteria verified.',
      '**Engineering snapshot:** v0.1.110 · 254/258 backlog acceptance criteria verified.',
    ].join('\n');
    const updated = syncSnapshotLine(text, '0.1.529', 259, 261);
    expect(updated).toContain('v0.1.529 · 259/261 backlog acceptance criteria verified.');
    expect(updated).toContain('v0.1.110 · 254/258 backlog acceptance criteria verified.');
    expect(() => syncSnapshotLine(text, '9.9.9', 1, 1)).toThrowError(StagingGateError);
  });
});

describe('parseFaucetWatchArgs', () => {
  const base = [
    '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
    '--checkpoint-hash', CHECKPOINT, '--receipt-out', 'o',
  ];

  it('parses --help without other flags', () => {
    expect(parseFaucetWatchArgs(['--help']).help).toBe(true);
  });

  it('parses a full single-shot invocation with defaults', () => {
    const args = parseFaucetWatchArgs(base);
    expect(args).toMatchObject({
      help: false, rpcUrlFile: 'r', keyFile: 'k', to: TO,
      checkpointHash: CHECKPOINT, receiptOut: 'o',
      checkOnly: false, push: false, watch: false,
      intervalSeconds: 300, maxChecks: 1,
    });
    expect('network' in args).toBe(false);
  });

  it('accepts a checkpoint manifest and optional flags', () => {
    const args = parseFaucetWatchArgs([
      '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
      '--checkpoint-manifest', 'c.json', '--receipt-out', 'o',
      '--min-balance-wei', '1000', '--check-only', '--push',
      '--watch', '--interval-seconds', '60', '--max-checks', '3',
    ]);
    expect(args).toMatchObject({
      checkpointHash: null, checkpointManifest: 'c.json',
      minBalanceWei: '1000', checkOnly: true, push: true,
      watch: true, intervalSeconds: 60, maxChecks: 3,
    });
  });

  it('requires rpc, key, destination, checkpoint, and receipt-out', () => {
    expect(() => parseFaucetWatchArgs(base.filter((t) => t !== 'r'))).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs(base.filter((t) => t !== 'k'))).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs(base.filter((t) => t !== TO))).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs(base.filter((t) => t !== CHECKPOINT))).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs(base.filter((t) => t !== 'o'))).toThrowError(StagingGateError);
  });

  it('rejects bad addresses, hashes, balances, and loop settings', () => {
    const badTo = [...base];
    badTo[badTo.indexOf(TO)] = 'nope';
    expect(() => parseFaucetWatchArgs(badTo)).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs([...base, '--min-balance-wei', '-5'])).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs([...base, '--interval-seconds', '0'])).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs([...base, '--watch'])).toThrowError(StagingGateError);
    expect(() => parseFaucetWatchArgs([...base, '--bogus', 'x'])).toThrowError(StagingGateError);
  });
});
