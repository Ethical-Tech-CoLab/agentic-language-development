/**
 * ALD-020 / ALD-022 — staging-gate unit suite.
 *
 * Covers the pure refusal matrix, explorer URL builder, and argument parsing
 * in `scripts/anchor-staging-gate.mjs`. The gate runs before any file, key, or
 * RPC access, so these tests need no fixtures and touch no network. The live
 * dry-run/broadcast paths in `scripts/anchor-public-submit.mjs` are verified
 * manually against public RPC (read-only) and documented in
 * `docs/anchor-staging.md`; the R7-B edge-case blocks below additionally pin
 * the offline-testable helpers of both scripts (secret files, manifests,
 * mocked-RPC clients, receipt checks, close-out confinement, loop bounds, and
 * the exit-code map) with tmp fixtures and a stubbed `fetch`.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANCHOR_CHAIN_IDS } from '@ald/anchor';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  parseDecimalWei,
  parseFaucetWatchArgs,
  parsePublicSubmitArgs,
  syncBacklogCount,
  syncSnapshotLine,
} from '../anchor-staging-gate.mjs';
import {
  readSecretFile as readSubmitSecretFile,
  resolveCheckpointHash as resolveSubmitCheckpointHash,
  rpcClient as submitRpcClient,
  runBroadcast,
  runCli as runSubmitCli,
  runDryRun,
  runGenerateKey,
  writeEvidenceOnce,
} from '../anchor-public-submit.mjs';
import {
  assertReceiptInsideRepo,
  checkOnce,
  readAndAssertReceipt,
  readSecretFile as readWatchSecretFile,
  resolveCheckpointHash as resolveWatchCheckpointHash,
  rpcClient as watchRpcClient,
  runCli as runWatchCli,
  runWatch,
  syncCloseOut,
} from '../anchor-faucet-watch.mjs';

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

// ---------------------------------------------------------------------------
// R7-B edge cases: strict wei, secrets, mocked RPC, receipts, confinement,
// loop bounds, and the exit-code map. No live network: `fetch` is stubbed
// and files live under a fresh tmp dir per test.
// ---------------------------------------------------------------------------

const WATCH_SCRIPT = fileURLToPath(new URL('../anchor-faucet-watch.mjs', import.meta.url));
const SUBMIT_SCRIPT = fileURLToPath(new URL('../anchor-public-submit.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'anchor-edge-'));
}

function writeTmpFile(dir: string, name: string, contents: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Stub `fetch` with per-method JSON-RPC results (or Errors to throw). */
function stubRpcByMethod(handlers: Record<string, any>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.method);
    const handler = handlers[body.method];
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: body.id, result: handler }),
    };
  }));
  return calls;
}

describe('parseDecimalWei (strict decimal wei)', () => {
  it('accepts plain decimals including zero and big values', () => {
    expect(parseDecimalWei('0')).toBe(0n);
    expect(parseDecimalWei('271380000000')).toBe(271380000000n);
  });

  it('rejects hex, floats, padding, signs, and non-strings', () => {
    for (const bad of ['0x10', '1.5', ' 3', '3 ', '+3', '-1', 'abc', '', '3n']) {
      expect(() => parseDecimalWei(bad)).toThrowError(StagingGateError);
    }
    expect(() => parseDecimalWei(3)).toThrowError(StagingGateError);
    expect(() => parseDecimalWei(null)).toThrowError(StagingGateError);
  });
});

describe('decideFunding edge inputs', () => {
  it('rejects non-decimal balances (BigInt alone would accept hex/padding)', () => {
    for (const balanceWei of ['0x10', '1.5', ' 3', '+3', '-1', 'abc']) {
      expect(() => decideFunding({ balanceWei, requiredWei: '3' })).toThrowError(StagingGateError);
    }
  });

  it('rejects non-decimal requirements', () => {
    for (const requiredWei of ['-1', 'abc', '0x10', '1.5', ' 3']) {
      expect(() => decideFunding({ balanceWei: '5', requiredWei })).toThrowError(StagingGateError);
    }
  });

  it('still funds huge covered balances exactly', () => {
    const big = '123456789012345678901234567890';
    expect(decideFunding({ balanceWei: big, requiredWei: big }))
      .toEqual({ funded: true, shortfallWei: '0' });
  });
});

describe('parseFaucetWatchArgs wei and loop bounds', () => {
  const base = [
    '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
    '--checkpoint-hash', CHECKPOINT, '--receipt-out', 'o',
  ];

  it('rejects non-decimal --min-balance-wei', () => {
    for (const bad of ['0x10', '1.5', ' 3', '-1', 'abc']) {
      expect(() => parseFaucetWatchArgs([...base, '--min-balance-wei', bad]))
        .toThrowError(StagingGateError);
    }
  });

  it('accepts --watch with --max-checks 2', () => {
    const args = parseFaucetWatchArgs([...base, '--watch', '--max-checks', '2']);
    expect(args).toMatchObject({ watch: true, maxChecks: 2 });
  });

  it('rejects fractional, non-numeric, and unsafe loop settings', () => {
    for (const flag of ['--max-checks', '--interval-seconds']) {
      for (const bad of ['1.5', 'abc', '99999999999999999999999', '0', '-2']) {
        expect(() => parseFaucetWatchArgs([...base, flag, bad])).toThrowError(StagingGateError);
      }
    }
  });
});

describe('readSecretFile (both scripts)', () => {
  it.each([
    ['submit', readSubmitSecretFile],
    ['watch', readWatchSecretFile],
  ])('%s trims and rejects empty, blank, and missing files', (_label, readSecret) => {
    const dir = makeTmp();
    expect(readSecret(writeTmpFile(dir, 'ok.url', '  https://rpc.example.test\n'), 'RPC URL'))
      .toBe('https://rpc.example.test');
    expect(() => readSecret(writeTmpFile(dir, 'empty.url', ''), 'RPC URL')).toThrowError(/empty/);
    expect(() => readSecret(writeTmpFile(dir, 'blank.url', '  \n'), 'RPC URL')).toThrowError(/empty/);
    expect(() => readSecret(join(dir, 'missing.url'), 'RPC URL')).toThrowError(/Could not read/);
  });
});

describe('resolveCheckpointHash manifests', () => {
  it('submit: prefers the direct hash, reads valid manifests', () => {
    const dir = makeTmp();
    const manifest = writeTmpFile(dir, 'c.json', JSON.stringify({ checkpointHash: CHECKPOINT }));
    expect(resolveSubmitCheckpointHash({ checkpointHash: CHECKPOINT, checkpointManifest: null }))
      .toEqual({ checkpointHash: CHECKPOINT, checkpointManifest: null });
    expect(resolveSubmitCheckpointHash({ checkpointHash: null, checkpointManifest: manifest }))
      .toEqual({ checkpointHash: CHECKPOINT, checkpointManifest: manifest });
  });

  it('submit: refuses bad JSON, missing files, and hash-less manifests', () => {
    const dir = makeTmp();
    const badJson = writeTmpFile(dir, 'bad.json', '{nope');
    const noHash = writeTmpFile(dir, 'nohash.json', JSON.stringify({ checkpointHash: '0xdead' }));
    for (const checkpointManifest of [badJson, join(dir, 'missing.json')]) {
      expect(() => resolveSubmitCheckpointHash({ checkpointHash: null, checkpointManifest }))
        .toThrowError(/Could not read checkpoint manifest/);
    }
    expect(() => resolveSubmitCheckpointHash({ checkpointHash: null, checkpointManifest: noHash }))
      .toThrowError(/no valid checkpointHash/);
    expect(() => resolveSubmitCheckpointHash(
      { checkpointHash: null, checkpointManifest: join(dir, 'no-parent', 'c.json') },
    )).toThrowError(/Could not read checkpoint manifest/);
  });

  it('watch: returns the hash string and refuses bad manifests', () => {
    const dir = makeTmp();
    const manifest = writeTmpFile(dir, 'c.json', JSON.stringify({ checkpointHash: CHECKPOINT }));
    expect(resolveWatchCheckpointHash({ checkpointHash: null, checkpointManifest: manifest }))
      .toBe(CHECKPOINT);
    expect(() => resolveWatchCheckpointHash(
      { checkpointHash: null, checkpointManifest: writeTmpFile(dir, 'bad.json', '{nope') },
    )).toThrowError(/Could not read checkpoint manifest/);
  });
});

describe('writeEvidenceOnce', () => {
  it('writes once and refuses overwrites and missing parent dirs', () => {
    const dir = makeTmp();
    const path = join(dir, 'evidence.json');
    writeEvidenceOnce(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(() => writeEvidenceOnce(path, { a: 2 })).toThrowError(/Refusing to overwrite/);
    expect(() => writeEvidenceOnce(join(dir, 'no-parent', 'e.json'), {}))
      .toThrowError(/ENOENT/);
  });
});

describe('rpcClient faults (mocked fetch)', () => {
  it('surfaces HTTP failures, JSON-RPC errors, and transport throws as Error', async () => {
    const call = submitRpcClient('https://rpc.example.test', 'rpc.example.test');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(call('eth_chainId', [])).rejects.toThrowError(/HTTP 500/);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ error: { message: 'boom' } }),
    })));
    await expect(call('eth_chainId', [])).rejects.toThrowError(/boom/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    await expect(call('eth_chainId', [])).rejects.toThrowError(/socket hang up/);
  });

  // R9-G: fetch construction errors echo the full RPC URL (which may carry
  // credentials); both clients must redact it to the host label.
  it.each([
    ['submit', submitRpcClient],
    ['watch', watchRpcClient],
  ])('%s rpcClient redacts the RPC URL from fetch errors', async (_name, makeClient: any) => {
    const rpcUrl = 'https://user:SECRET@rpc.example.test:8545/v2/key';
    const call = makeClient(rpcUrl, 'rpc.example.test:8545');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${rpcUrl}`);
    }));
    const failure = await call('eth_chainId', []).then(
      () => { throw new Error('expected rejection'); },
      (error: Error) => error,
    );
    expect(failure.message).toBe(
      'Request cannot be constructed from a URL that includes credentials: rpc.example.test:8545',
    );
    expect(failure.message).not.toContain('SECRET');
    expect(failure.message).not.toContain(rpcUrl);
  });
});

describe('runDryRun with mocked RPC', () => {
  function dryRunArgs(dir: string): any {
    return {
      network: 'base-sepolia',
      allowMainnet: false,
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://user:pass@rpc.example.test:8545/v2/key?x=1\n'),
      from: FROM,
      to: TO,
      checkpointHash: CHECKPOINT,
      checkpointManifest: null,
      out: join(dir, 'dry.json'),
    };
  }

  it('records a read-only plan with the host label only (no secrets)', async () => {
    const dir = makeTmp();
    const args = dryRunArgs(dir);
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x3b9aca00',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDryRun(args);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      kind: 'anchor-dry-run', broadcast: false, network: 'base-sepolia',
    });
    const record = JSON.parse(readFileSync(args.out, 'utf8'));
    expect(record).toMatchObject({
      kind: 'anchor-dry-run',
      broadcast: false,
      network: 'base-sepolia',
      chainId: 84532,
      balanceWei: '0',
      estimatedGas: '22615',
      gasPriceWei: '1000000000',
      rpcEndpointLabel: 'rpc.example.test:8545',
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('/v2/key');
  });

  it('pins gasPriceWei to null when the gas-price call fails', async () => {
    const dir = makeTmp();
    const args = dryRunArgs(dir);
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: new Error('gas oracle down'),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDryRun(args);
    expect(JSON.parse(readFileSync(args.out, 'utf8')).gasPriceWei).toBeNull();
  });

  it('refuses chain mismatches, bad chain hex, and bad balance hex', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x1',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runDryRun(dryRunArgs(dir))).rejects.toThrowError(/does not match base-sepolia/);
    stubRpcByMethod({
      eth_chainId: '0xZZZ',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    await expect(runDryRun(dryRunArgs(dir))).rejects.toThrowError(/does not match base-sepolia/);
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0xZZZ',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    await expect(runDryRun(dryRunArgs(dir))).rejects.toThrowError(/Cannot convert/);
  });
});

describe('checkOnce with mocked RPC', () => {
  function watchArgs(dir: string, extra: Record<string, any> = {}): any {
    return {
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://user:pass@rpc.example.test/x\n'),
      to: TO,
      minBalanceWei: null,
      ...extra,
    };
  }

  it('reports funding state with the host label only', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0xde0b6b3a7640000',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x3b9aca00',
    });
    const status = await checkOnce(watchArgs(dir), CHECKPOINT, FROM);
    expect(status).toMatchObject({
      funded: true,
      balanceWei: '1000000000000000000',
      chainId: 84532,
      rpcEndpointLabel: 'rpc.example.test',
    });
    expect(JSON.stringify(status)).not.toContain('user:pass');
  });

  it('falls back to a 1-wei requirement when gas data is missing', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: new Error('gas oracle down'),
    });
    const status = await checkOnce(watchArgs(dir), CHECKPOINT, FROM);
    expect(status).toMatchObject({ funded: false, requiredWei: '1', shortfallWei: '1' });
  });

  it('honours --min-balance-wei over the gas estimate', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
    const status = await checkOnce(watchArgs(dir, { minBalanceWei: '1000' }), CHECKPOINT, FROM);
    expect(status).toMatchObject({ funded: false, requiredWei: '1000', shortfallWei: '1000' });
  });

  it('refuses non-Sepolia chains, bad chain hex, and bad balance hex', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x2105',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    await expect(checkOnce(watchArgs(dir), CHECKPOINT, FROM))
      .rejects.toThrowError(StagingGateError);
    stubRpcByMethod({
      eth_chainId: '0xZZZ',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    await expect(checkOnce(watchArgs(dir), CHECKPOINT, FROM)).rejects.toThrowError(StagingGateError);
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: 'not-hex',
      eth_estimateGas: '0x1',
      eth_gasPrice: '0x1',
    });
    await expect(checkOnce(watchArgs(dir), CHECKPOINT, FROM)).rejects.toThrowError(/Cannot convert/);
  });
});

describe('readAndAssertReceipt', () => {
  const good = {
    network: 'base-sepolia',
    chainId: 84532,
    explorerTxUrl: `https://sepolia.basescan.org/tx/${TX}`,
  };

  it('accepts a genuine Sepolia receipt', () => {
    const dir = makeTmp();
    const path = writeTmpFile(dir, 'receipt.json', JSON.stringify(good));
    expect(readAndAssertReceipt(path)).toMatchObject(good);
  });

  it('refuses wrong networks, wrong chains, and missing explorer URLs', () => {
    const dir = makeTmp();
    const variants: Array<[any, RegExp]> = [
      [{ ...good, network: 'base-mainnet' }, /unexpected network/],
      [{ ...good, chainId: 8453 }, /unexpected network/],
      [{ ...good, explorerTxUrl: `https://basescan.org/tx/${TX}` }, /valid Sepolia explorer URL/],
      [{ ...good, explorerTxUrl: null }, /valid Sepolia explorer URL/],
    ];
    for (const [index, [receipt, message]] of variants.entries()) {
      const path = writeTmpFile(dir, `r${String(index)}.json`, JSON.stringify(receipt));
      expect(() => readAndAssertReceipt(path)).toThrowError(message);
    }
  });

  it('refuses explorer URLs that merely contain the Sepolia prefix', () => {
    const dir = makeTmp();
    const spoofed = writeTmpFile(dir, 'spoof.json', JSON.stringify({
      ...good,
      explorerTxUrl: `https://evil.test/?next=https://sepolia.basescan.org/tx/${TX}`,
    }));
    expect(() => readAndAssertReceipt(spoofed)).toThrowError(/valid Sepolia explorer URL/);
  });

  it('refuses malformed JSON and missing files', () => {
    const dir = makeTmp();
    const bad = writeTmpFile(dir, 'bad.json', '{nope');
    expect(() => readAndAssertReceipt(bad)).toThrowError(/Could not read broadcast receipt/);
    expect(() => readAndAssertReceipt(join(dir, 'missing.json')))
      .toThrowError(/Could not read broadcast receipt/);
  });
});

describe('assertReceiptInsideRepo confinement (pure: never touches BACKLOG)', () => {
  it('refuses absolute outside paths, parent escapes, and the repo root itself', () => {
    for (const receiptOut of ['/tmp/evil.json', '../evil.json', '.', '..']) {
      expect(() => assertReceiptInsideRepo(receiptOut)).toThrowError(/inside the repository/);
    }
  });

  it('refuses symlink escapes even when the link lives in the repo', () => {
    const dir = makeTmp();
    const target = writeTmpFile(dir, 'outside.json', '{}');
    const link = join(REPO_ROOT, '.r7b-symlink-probe.json');
    symlinkSync(target, link);
    try {
      expect(() => assertReceiptInsideRepo('.r7b-symlink-probe.json')).toThrowError(/symlink/);
    } finally {
      unlinkSync(link);
    }
  });

  it('returns the absolute path for a genuine in-repo receipt', () => {
    const linkName = '.r8h-inside-probe.json';
    const link = join(REPO_ROOT, linkName);
    writeFileSync(link, '{}');
    try {
      expect(assertReceiptInsideRepo(linkName)).toBe(link);
    } finally {
      unlinkSync(link);
    }
  });

  it('syncCloseOut delegates to the confinement check first', () => {
    // Outside paths only: both hit the lexical guard, and pinning its exact
    // message keeps the test red if the delegation (or the guard) is ever
    // removed. The symlink case stays on the pure unit above.
    for (const receiptOut of ['/tmp/evil.json', '../evil.json']) {
      expect(() => syncCloseOut({}, receiptOut)).toThrowError(/inside the repository/);
    }
  });
});

describe('watch loop bounds and exit map', () => {
  const base = [
    '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
    '--checkpoint-hash', CHECKPOINT,
  ];

  function fundedStubs() {
    return stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0xde0b6b3a7640000',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
  }

  function brokeStubs() {
    return stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
  }

  /** A curve-valid key file the strict loader accepts (0700 dir, 0600 file). */
  function keyFile(dir: string): string {
    return writeTmpFile(dir, 'anchor.key', `${'0x'}${'11'.repeat(32)}\n`);
  }

  it('single-shot NOT_FUNDED exits 0 without sleeping', async () => {
    const dir = makeTmp();
    const calls = brokeStubs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const receiptOut = join(dir, 'receipt.json');
    const started = Date.now();
    const result = await runWatch([
      '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--key-file', keyFile(dir),
      '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--receipt-out', receiptOut, '--interval-seconds', '3600',
    ]);
    expect(result).toEqual({ acted: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls).toHaveLength(4);
  });

  it('a bounded watch re-checks then gives up cleanly', async () => {
    const dir = makeTmp();
    const calls = brokeStubs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Real 1s sleep kept deliberately: a fake-timers version of this test
    // hangs (the watch loop + RPC abort timers do not settle under mocked
    // clocks — observed R8-X), and the real second is cheap.
    const result = await runWatch([
      '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--key-file', keyFile(dir),
      '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--receipt-out', join(dir, 'receipt.json'),
      '--watch', '--interval-seconds', '1', '--max-checks', '2',
    ]);
    expect(result).toEqual({ acted: false });
    expect(calls).toHaveLength(8);
  });

  it('check-only + push reports funded but never broadcasts or pushes', async () => {
    const dir = makeTmp();
    fundedStubs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const receiptOut = join(dir, 'receipt.json');
    const result = await runWatch([
      '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--key-file', keyFile(dir),
      '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--receipt-out', receiptOut, '--check-only', '--push',
    ]);
    expect(result).toEqual({ acted: false });
    expect(() => readFileSync(receiptOut, 'utf8')).toThrowError(/ENOENT/);
  });

  it('an existing receipt-out aborts before any RPC call', async () => {
    const dir = makeTmp();
    const calls = fundedStubs();
    const receiptOut = writeTmpFile(dir, 'receipt.json', '{}');
    await expect(runWatch([
      ...base, '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--key-file', keyFile(dir), '--receipt-out', receiptOut,
    ])).rejects.toThrowError(/Refusing to overwrite/);
    expect(calls).toHaveLength(0);
  });

  it('in-process exit map: gate errors -> 2, operational errors -> 1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = makeTmp();
    expect(await runWatchCli(['--bogus'])).toBe(2);
    expect(await runSubmitCli(['--bogus'])).toBe(2);
    expect(await runWatchCli([
      ...base, '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--key-file', join(dir, 'missing.key'), '--receipt-out', join(dir, 'r.json'),
    ])).toBe(1);
    expect(await runSubmitCli([
      '--dry-run', '--rpc-url-file', join(dir, 'missing.url'),
      '--from', FROM, '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--out', join(dir, 'o.json'),
    ])).toBe(1);
  });

  it('real process exit codes match the map (subprocess)', async () => {
    const dir = makeTmp();
    const rpcUrl = writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n');
    const run = (script: string, argv: string[]): Promise<unknown> => new Promise((resolve) => {
      execFile(process.execPath, [script, ...argv], { cwd: REPO_ROOT }, (error, _stdout, _stderr) => {
        resolve(error ? (error as { code?: unknown }).code : 0);
      });
    });
    // The five probes are independent: run them concurrently (R8-X trim;
    // same five assertions as the old serial version).
    const [watchBogus, submitBogus, watchHelp, submitHelp, missingKey] = await Promise.all([
      run(WATCH_SCRIPT, ['--bogus']),
      run(SUBMIT_SCRIPT, ['--bogus']),
      run(WATCH_SCRIPT, ['--help']),
      run(SUBMIT_SCRIPT, ['--help']),
      run(WATCH_SCRIPT, [...base, '--rpc-url-file', rpcUrl,
        '--key-file', join(dir, 'missing.key'), '--receipt-out', join(dir, 'r.json')]),
    ]);
    expect(watchBogus).toBe(2);
    expect(submitBogus).toBe(2);
    expect(watchHelp).toBe(0);
    expect(submitHelp).toBe(0);
    expect(missingKey).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R8-C hardening: refusal ordering, mainnet paths, strictness, and empty /
// boundary inputs. Still no live network: `fetch` is stubbed, env is
// stubbed per test, and every broadcast test below throws before any file,
// key, or RPC access (the arg files need not exist).
// ---------------------------------------------------------------------------

describe('runBroadcast refusal ordering (offline)', () => {
  function broadcastArgs(dir: string, extra: Record<string, any> = {}): any {
    return {
      mode: 'broadcast',
      network: 'base-mainnet',
      rpcUrlFile: join(dir, 'missing.url'),
      keyFile: join(dir, 'missing.key'),
      from: null,
      to: TO,
      checkpointHash: CHECKPOINT,
      checkpointManifest: null,
      out: join(dir, 'out.json'),
      allowMainnet: false,
      confirmMainnetBroadcast: false,
      ...extra,
    };
  }

  it('refuses mainnet with neither opt-in before touching files', async () => {
    const dir = makeTmp();
    const failure = await runBroadcast(broadcastArgs(dir)).then(
      () => null,
      (error: any) => error,
    );
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.code).toBe('MAINNET_ANCHORING_DISABLED');
    expect(failure.reason).toBe('both');
  });

  it('refuses mainnet with only one opt-in before touching files', async () => {
    const dir = makeTmp();
    await expect(runBroadcast(broadcastArgs(dir, { allowMainnet: true })))
      .rejects.toThrowError(StagingGateError);
    vi.stubEnv(MAINNET_ENV_VAR, 'true');
    const failure = await runBroadcast(broadcastArgs(dir)).then(
      () => null,
      (error: any) => error,
    );
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.reason).toBe('missing-option');
  });

  it('refuses mainnet without the confirm flag even with both opt-ins', async () => {
    const dir = makeTmp();
    vi.stubEnv(MAINNET_ENV_VAR, 'true');
    const failure = await runBroadcast(broadcastArgs(dir, { allowMainnet: true })).then(
      () => null,
      (error: any) => error,
    );
    expect(failure).toBeInstanceOf(StagingGateError);
    expect(failure.code).toBe('MAINNET_BROADCAST_UNCONFIRMED');
  });

  it('a Sepolia invocation sails past the gate to file access', async () => {
    const dir = makeTmp();
    // Not a StagingGateError: the gate passes and readSecretFile fails.
    const failure = await runBroadcast(broadcastArgs(dir, {
      network: 'base-sepolia',
      allowMainnet: false,
    })).then(() => null, (error: any) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StagingGateError);
    expect(failure.message).toMatch(/Could not read RPC URL file/);
  });
});

describe('runDryRun mainnet and manifest paths', () => {
  it('refuses a mainnet dry-run without opt-ins before touching files', async () => {
    const dir = makeTmp();
    await expect(runDryRun({
      network: 'base-mainnet',
      allowMainnet: false,
      rpcUrlFile: join(dir, 'missing.url'),
      from: FROM,
      to: TO,
      checkpointHash: CHECKPOINT,
      checkpointManifest: null,
      out: join(dir, 'dry.json'),
    })).rejects.toThrowError(StagingGateError);
  });

  it('runs a mainnet dry-run with both opt-ins and warns broadcast is blocked', async () => {
    const dir = makeTmp();
    vi.stubEnv(MAINNET_ENV_VAR, 'true');
    stubRpcByMethod({
      eth_chainId: '0x2105',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(dir, 'dry.json');
    await runDryRun({
      network: 'base-mainnet',
      allowMainnet: true,
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      from: FROM,
      to: TO,
      checkpointHash: CHECKPOINT,
      checkpointManifest: null,
      out,
    });
    const record = JSON.parse(readFileSync(out, 'utf8'));
    expect(record).toMatchObject({
      kind: 'anchor-dry-run',
      broadcast: false,
      network: 'base-mainnet',
      chainId: 8453,
      finalityPolicy: 'safe-tag',
    });
    expect(log.mock.calls.some((call) => String(call[0]).includes('remains blocked'))).toBe(true);
  });

  it('binds a checkpoint manifest into the dry-run record', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const manifest = writeTmpFile(dir, 'c.json', JSON.stringify({ checkpointHash: CHECKPOINT }));
    const out = join(dir, 'dry.json');
    await runDryRun({
      network: 'base-sepolia',
      allowMainnet: false,
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      from: FROM,
      to: TO,
      checkpointHash: null,
      checkpointManifest: manifest,
      out,
    });
    const record = JSON.parse(readFileSync(out, 'utf8'));
    expect(record).toMatchObject({ checkpointHash: CHECKPOINT, checkpointManifest: manifest });
  });
});

describe('R8-C strictness and empty/boundary inputs', () => {
  it('checkOnce surfaces an estimateGas failure (no fallback there)', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: new Error('estimation unavailable'),
      eth_gasPrice: '0x1',
    });
    await expect(checkOnce({
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      to: TO,
      minBalanceWei: null,
    }, CHECKPOINT, FROM)).rejects.toThrowError(/estimation unavailable/);
  });

  it('readAndAssertReceipt is type-strict on chainId', () => {
    const dir = makeTmp();
    const path = writeTmpFile(dir, 'r.json', JSON.stringify({
      network: 'base-sepolia',
      chainId: '84532',
      explorerTxUrl: `https://sepolia.basescan.org/tx/${TX}`,
    }));
    expect(() => readAndAssertReceipt(path)).toThrowError(/unexpected network/);
  });

  it('decideFunding funds a positive balance against a zero requirement', () => {
    expect(decideFunding({ balanceWei: '1', requiredWei: '0' }))
      .toEqual({ funded: true, shortfallWei: '0' });
  });

  it('explorerTxUrl rejects non-string hashes', () => {
    for (const hash of [null, undefined, 123, {}]) {
      expect(() => explorerTxUrl('base-sepolia', hash)).toThrowError(StagingGateError);
    }
  });

  it('endpointLabelFor falls back on empty input', () => {
    expect(endpointLabelFor('')).toBe('rpc');
  });

  it('parsePublicSubmitArgs rejects empty addresses and hashes', () => {
    const base = ['--dry-run', '--rpc-url-file', 'r', '--from', FROM, '--to', TO, '--out', 'o'];
    expect(() => parsePublicSubmitArgs([...base, '--checkpoint-hash', ''])).toThrowError(StagingGateError);
    expect(() => parsePublicSubmitArgs(
      ['--dry-run', '--rpc-url-file', 'r', '--from', FROM, '--to', '', '--checkpoint-hash', CHECKPOINT, '--out', 'o'],
    )).toThrowError(StagingGateError);
  });

  it('submit manifest refuses null and non-string checkpointHash', () => {
    const dir = makeTmp();
    for (const checkpointHash of [null, 123, {}]) {
      const manifest = writeTmpFile(dir, `m-${String(checkpointHash)}.json`, JSON.stringify({ checkpointHash }));
      expect(() => resolveSubmitCheckpointHash({ checkpointHash: null, checkpointManifest: manifest }))
        .toThrowError(/no valid checkpointHash/);
    }
  });

  it('countCriteria handles zero boxes', () => {
    expect(countCriteria('# Backlog\n\nno boxes here\n')).toEqual({ checked: 0, total: 0 });
  });

  it('checkCriterionBox checks the first matching box only', () => {
    const fixture = [
      '#### ALD-020 — Base Sepolia anchoring client',
      '  - [ ] A submitted checkpoint root is independently observable (a).',
      '  - [ ] A submitted checkpoint root is independently observable (b).',
      '',
    ].join('\n');
    const updated = checkCriterionBox(fixture, 'ALD-020', 'A submitted checkpoint root is independently observable');
    expect(updated).toContain('  - [x] A submitted checkpoint root is independently observable (a).');
    expect(updated).toContain('  - [ ] A submitted checkpoint root is independently observable (b).');
    expect(countCriteria(updated)).toEqual({ checked: 1, total: 2 });
  });

  it('in-process --help exits 0 on both CLIs', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runWatchCli(['--help'])).toBe(0);
    expect(await runSubmitCli(['--help'])).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(String(write.mock.calls[0][0])).toContain('anchor-faucet-watch.mjs');
    expect(String(write.mock.calls[1][0])).toContain('anchor-public-submit.mjs');
  });
});

// ---------------------------------------------------------------------------
// R8-Q coverage gaps: short flags, missing-value shapes, post-parse required
// checks, last-section close-out, key generation, and submit-CLI dispatch.
// (Plus a regression test for the '--dry-run' mode-message bug.)
// ---------------------------------------------------------------------------

describe('R8-Q parser edges', () => {
  it('accepts -h as well as --help on both CLIs', () => {
    expect(parsePublicSubmitArgs(['-h']).mode).toBe('help');
    expect(parseFaucetWatchArgs(['-h']).help).toBe(true);
  });

  it('names the invoking mode in missing-file errors (not always --broadcast)', () => {
    const messageOf = (argv: string[]): string => {
      try {
        parsePublicSubmitArgs(argv);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      expect.unreachable();
    };
    const dryBase = ['--dry-run', '--from', FROM, '--to', TO, '--checkpoint-hash', CHECKPOINT];
    expect(messageOf([...dryBase, '--out', 'o'])).toContain('--dry-run requires --rpc-url-file');
    expect(messageOf(['--broadcast', '--rpc-url-file', 'r', '--key-file', 'k', '--to', TO, '--checkpoint-hash', CHECKPOINT]))
      .toContain('--broadcast requires --out');
    expect(messageOf([...dryBase, '--rpc-url-file', 'r'])).toContain('--dry-run requires --out');
  });

  it('rejects a flag followed by another flag (not just a trailing flag)', () => {
    expect(() => parsePublicSubmitArgs(['--dry-run', '--to', '--from', FROM, '--checkpoint-hash', CHECKPOINT]))
      .toThrowError(/requires a value/);
    expect(() => parseFaucetWatchArgs(['--rpc-url-file'])).toThrowError(/requires a value/);
  });

  it('watch post-parse checks fire when a required flag is absent entirely', () => {
    const full = ['--rpc-url-file', 'r', '--key-file', 'k', '--to', TO,
      '--checkpoint-hash', CHECKPOINT, '--receipt-out', 'o'];
    const drop = (flag: string): string[] => full.filter((t: string, i: number) => !(t === flag || full[i - 1] === flag));
    expect(() => parseFaucetWatchArgs(drop('--rpc-url-file'))).toThrowError(/--rpc-url-file/);
    expect(() => parseFaucetWatchArgs(drop('--key-file'))).toThrowError(/--key-file/);
    expect(() => parseFaucetWatchArgs(drop('--to'))).toThrowError(/--to must be/);
    expect(() => parseFaucetWatchArgs(drop('--checkpoint-hash'))).toThrowError(/Provide --checkpoint-hash/);
    expect(() => parseFaucetWatchArgs(drop('--receipt-out'))).toThrowError(/--receipt-out/);
  });

  it('checkCriterionBox works on the last section (no following header)', () => {
    const fixture = [
      '#### ALD-020 — Base Sepolia anchoring client',
      '  - [x] A submitted checkpoint root is independently observable.',
      '',
      '#### ALD-998 — Confirmation',
      '  - [ ] A receipt is marked confirmed only after depth.',
      '',
    ].join('\n');
    const updated = checkCriterionBox(fixture, 'ALD-998', 'A receipt is marked confirmed');
    expect(updated).toContain('  - [x] A receipt is marked confirmed only after depth.');
    expect(countCriteria(updated)).toEqual({ checked: 2, total: 2 });
  });
});

describe('R8-Q key generation and submit dispatch', () => {
  it('runGenerateKey writes mode-0600, prints keyFile/address JSON, refuses overwrite', async () => {
    const dir = makeTmp();
    const keyFile = join(dir, 'fresh.key');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runGenerateKey({ keyFile });
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(log).toHaveBeenCalledOnce();
    const printed = JSON.parse(String(log.mock.calls[0][0]));
    expect(printed).toMatchObject({ keyFile });
    expect(printed.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await expect(runGenerateKey({ keyFile })).rejects.toThrowError(/could not be created/);
  });

  it('runBroadcast refuses a --from/key mismatch before building the transport', async () => {
    const dir = makeTmp();
    const failure = await runBroadcast({
      mode: 'broadcast',
      network: 'base-sepolia',
      rpcUrlFile: writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      keyFile: writeTmpFile(dir, 'anchor.key', `${'0x'}${'11'.repeat(32)}\n`),
      from: '0x2222222222222222222222222222222222222222',
      to: TO,
      checkpointHash: CHECKPOINT,
      checkpointManifest: null,
      out: join(dir, 'out.json'),
      allowMainnet: false,
      confirmMainnetBroadcast: false,
    }).then(() => null, (error: any) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(StagingGateError);
    expect(failure.message).toMatch(/--from does not match/);
  });

  it('submit runCli dispatches broadcast refusals through main with exit 2', async () => {
    const dir = makeTmp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Parses cleanly (so main dispatches), then runBroadcast refuses at the gate.
    expect(await runSubmitCli([
      '--broadcast', '--network', 'base-mainnet', '--rpc-url-file', join(dir, 'missing.url'),
      '--key-file', join(dir, 'missing.key'), '--to', TO, '--checkpoint-hash', CHECKPOINT,
      '--out', join(dir, 'out.json'),
    ])).toBe(2);
  });

  it('submit runCli runs a full dry-run through main with exit 0', async () => {
    const dir = makeTmp();
    stubRpcByMethod({
      eth_chainId: '0x14a34',
      eth_getBalance: '0x0',
      eth_estimateGas: '0x5857',
      eth_gasPrice: '0x1',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(dir, 'dry.json');
    const code = await runSubmitCli([
      '--dry-run', '--network', 'base-sepolia',
      '--rpc-url-file', writeTmpFile(dir, 'rpc.url', 'https://rpc.example.test\n'),
      '--from', FROM, '--to', TO, '--checkpoint-hash', CHECKPOINT, '--out', out,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      kind: 'anchor-dry-run', broadcast: false, chainId: 84532,
    });
  });
});
