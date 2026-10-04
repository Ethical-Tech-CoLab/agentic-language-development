/**
 * R2-C / ALD-020 — funded-broadcast resume path for the Sepolia anchor.
 *
 * Single check (default) or bounded watch loop: reads the anchor wallet
 * balance over public RPC and, ONLY when funded, broadcasts the checkpoint
 * digest via `anchor-public-submit.mjs`, verifies the receipt, checks the
 * ALD-020 box, syncs the count snapshots + conformance matrix, verifies the
 * gates, and commits. Push is opt-in (`--push`, only with push authorization).
 *
 * Hard safety shape (no flags can change it):
 * - Base Sepolia ONLY: no `--network` input exists, the RPC chain id must be
 *   exactly 84532, and the broadcast receipt must report `base-sepolia`.
 *   Mainnet can never be reached through this script.
 * - A zero balance is never funded, even with a zero estimate.
 * - `--check-only` reports the funding decision without broadcasting.
 *
 * Secrets: key/RPC files are never printed. The receipt, logs, and commit
 * carry only public chain data (addresses, hashes, explorer URL).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAUCET_WATCH_COST_MARGIN_NUMERATOR,
  FAUCET_WATCH_NETWORK,
  PUBLIC_ANCHOR_NETWORKS,
  StagingGateError,
  assertSepoliaChainId,
  checkCriterionBox,
  countCriteria,
  decideFunding,
  endpointLabelFor,
  parseFaucetWatchArgs,
  syncBacklogCount,
  syncSnapshotLine,
} from './anchor-staging-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SUBMITTER = resolve(HERE, 'anchor-public-submit.mjs');
const RPC_TIMEOUT_MS = 15_000;
const ALD020_STATEMENT_PREFIX = 'A submitted checkpoint root is independently observable';

const HELP = `anchor-faucet-watch.mjs — ALD-020 funded-broadcast resume (Sepolia only, never mainnet)

  node scripts/anchor-faucet-watch.mjs --rpc-url-file <path> --key-file <path>
      --to <address> [--checkpoint-hash <sha256:...> | --checkpoint-manifest <path>]
      --receipt-out <path> [--min-balance-wei <wei>] [--check-only] [--push]
      [--watch --interval-seconds <n> --max-checks <n>]

  Checks the anchor wallet balance. When funded (and not --check-only):
  broadcasts via anchor-public-submit.mjs, verifies the Sepolia receipt,
  checks the ALD-020 box, syncs BACKLOG/README/RESEARCH counts, regenerates
  the conformance matrix, verifies gates, and commits the named files.
  --push additionally pushes (only with push authorization).
  Not funded -> prints NOT_FUNDED and exits 0. --help exits 0.
`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const runNode = (script, args) => {
  execFileSync(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
};
const runGit = (args) => {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
};

export function readSecretFile(path, label) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8').trim();
  } catch (cause) {
    throw new Error(`Could not read ${label} file ${path}.`, { cause });
  }
  if (contents === '') {
    throw new Error(`${label} file ${path} is empty.`);
  }
  return contents;
}

export function resolveCheckpointHash(args) {
  if (args.checkpointHash !== null) return args.checkpointHash;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(args.checkpointManifest, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read checkpoint manifest ${args.checkpointManifest}.`, { cause });
  }
  if (typeof parsed?.checkpointHash !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/u.test(parsed.checkpointHash)) {
    throw new Error(`Checkpoint manifest ${args.checkpointManifest} has no valid checkpointHash.`);
  }
  return parsed.checkpointHash;
}

export function rpcClient(rpcUrl, label) {
  let nextId = 1;
  return async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${label} ${method} failed: HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload.error) {
        throw new Error(`${label} ${method} failed: ${payload.error.message ?? 'unknown error'}`);
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function checkOnce(args, checkpointHash, keyAddress) {
  const rpcUrl = readSecretFile(args.rpcUrlFile, 'RPC URL');
  const host = endpointLabelFor(rpcUrl);
  const call = rpcClient(rpcUrl, host);
  const chainId = Number.parseInt(await call('eth_chainId', []), 16);
  assertSepoliaChainId(chainId);
  const balanceWei = BigInt(await call('eth_getBalance', [keyAddress, 'latest'])).toString();
  const gasHex = await call('eth_estimateGas', [{
    from: keyAddress,
    to: args.to,
    value: '0x0',
    data: `0x${checkpointHash.slice('sha256:'.length)}`,
  }]);
  let gasPriceWei = 0n;
  try {
    gasPriceWei = BigInt(await call('eth_gasPrice', []));
  } catch {
    gasPriceWei = 0n;
  }
  const estimatedWei = BigInt(gasHex) * gasPriceWei;
  const requiredWei = args.minBalanceWei !== null
    ? BigInt(args.minBalanceWei).toString()
    : (estimatedWei * FAUCET_WATCH_COST_MARGIN_NUMERATOR > 0n
      ? (estimatedWei * FAUCET_WATCH_COST_MARGIN_NUMERATOR).toString()
      : '1');
  const { funded, shortfallWei } = decideFunding({ balanceWei, requiredWei });
  return {
    funded, balanceWei, requiredWei, shortfallWei,
    address: keyAddress, chainId, rpcEndpointLabel: host,
  };
}

function broadcast(args, checkpointHash) {
  const submitArgs = [
    SUBMITTER,
    '--broadcast',
    '--network', FAUCET_WATCH_NETWORK,
    '--rpc-url-file', args.rpcUrlFile,
    '--key-file', args.keyFile,
    '--to', args.to,
    '--checkpoint-hash', checkpointHash,
    '--out', args.receiptOut,
  ];
  execFileSync(process.execPath, submitArgs, { cwd: ROOT, stdio: 'inherit' });
  return readAndAssertReceipt(args.receiptOut);
}

/** Read the submitter receipt and refuse anything off the Sepolia path. */
export function readAndAssertReceipt(receiptOut) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptOut, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read broadcast receipt ${receiptOut}.`, { cause });
  }
  if (receipt.network !== FAUCET_WATCH_NETWORK || receipt.chainId !== PUBLIC_ANCHOR_NETWORKS[FAUCET_WATCH_NETWORK].chainId) {
    throw new Error(`Refusing receipt on unexpected network: ${String(receipt.network)} chain ${String(receipt.chainId)}.`);
  }
  // Prefix match, not substring: the submitter only ever emits this exact
  // prefix, and `includes` would accept a spoofed URL with it embedded.
  if (typeof receipt.explorerTxUrl !== 'string' || !receipt.explorerTxUrl.startsWith('https://sepolia.basescan.org/tx/0x')) {
    throw new Error('Broadcast receipt lacks a valid Sepolia explorer URL.');
  }
  return receipt;
}

export function syncCloseOut(receipt, receiptOut) {
  const absoluteReceipt = resolve(ROOT, receiptOut);
  if (!absoluteReceipt.startsWith(`${ROOT}/`)) {
    throw new Error(`--receipt-out must live inside the repository to be committable: ${receiptOut}`);
  }
  // Lexical confinement is not enough: a symlink inside the repo could point
  // outside it. The receipt exists by now (the submitter just wrote it), so
  // resolve both sides before comparing.
  const realReceipt = realpathSync(absoluteReceipt);
  if (!realReceipt.startsWith(`${realpathSync(ROOT)}/`)) {
    throw new Error(`--receipt-out escapes the repository via symlink: ${receiptOut}`);
  }
  const backlogPath = resolve(ROOT, 'BACKLOG.md');
  const readmePath = resolve(ROOT, 'README.md');
  const researchPath = resolve(ROOT, 'RESEARCH.md');
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  let backlog = readFileSync(backlogPath, 'utf8');
  backlog = checkCriterionBox(backlog, 'ALD-020', ALD020_STATEMENT_PREFIX);
  const { checked, total } = countCriteria(backlog);
  backlog = syncBacklogCount(backlog, checked, total);
  writeFileSync(backlogPath, backlog);
  for (const path of [readmePath, researchPath]) {
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, syncSnapshotLine(text, pkg.version, checked, total));
  }
  runNode(resolve(HERE, 'build-conformance-matrix.mjs'), []);
  runNode(resolve(HERE, 'build-conformance-matrix.mjs'), ['--check']);
  runNode(resolve(HERE, 'check-project-status.mjs'), []);
  runNode(resolve(HERE, 'scan-secrets.mjs'), []);
  const files = [
    'BACKLOG.md',
    'README.md',
    'RESEARCH.md',
    'docs/requirement-conformance-matrix.json',
    'docs/requirement-conformance-matrix.md',
    absoluteReceipt.slice(ROOT.length + 1),
  ];
  runGit(['add', ...files]);
  runGit(['commit', '-m',
    `feat(anchor): close ALD-020 with Sepolia explorer evidence\n\nCheckpoint ${receipt.checkpointHash} anchored at ${receipt.transactionHash}\nExplorer: ${receipt.explorerTxUrl}`]);
  return { checked, total };
}

export async function runWatch(argv) {
  const args = parseFaucetWatchArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return { acted: false };
  }
  if (existsSync(args.receiptOut)) {
    throw new Error(`Refusing to overwrite existing receipt file ${args.receiptOut}.`);
  }
  let anchor;
  try {
    anchor = await import('@ald/anchor');
  } catch (cause) {
    throw new Error('Could not load @ald/anchor build output. Run the TypeScript build first.', { cause });
  }
  const key = await anchor.loadAnchorKeyFile(args.keyFile);
  const checkpointHash = resolveCheckpointHash(args);

  for (let check = 1; check <= args.maxChecks; check += 1) {
    const status = await checkOnce(args, checkpointHash, key.address);
    console.log(JSON.stringify({ check, of: args.maxChecks, ...status }, null, 2));
    if (!status.funded) {
      console.log(`NOT_FUNDED: ${status.address} holds ${status.balanceWei} wei, needs ${status.requiredWei} wei. Fund via a Base Sepolia faucet and re-run.`);
      if (check < args.maxChecks) {
        await sleep(args.intervalSeconds * 1_000);
        continue;
      }
      return { acted: false };
    }
    if (args.checkOnly) {
      console.log(`FUNDED (check-only): ${status.balanceWei} wei covers ${status.requiredWei} wei. Re-run without --check-only to broadcast.`);
      return { acted: false };
    }
    const receipt = broadcast(args, checkpointHash);
    const { checked, total } = syncCloseOut(receipt, args.receiptOut);
    console.log(`CLOSED ALD-020: ${receipt.explorerTxUrl} (${String(checked)}/${String(total)} criteria).`);
    if (args.push) {
      runGit(['push']);
    } else {
      console.log('Not pushing: re-run with --push only with push authorization, or push manually.');
    }
    return { acted: true };
  }
  return { acted: false };
}

// Importing this module (e.g. from the edge-case tests) must not run the CLI.
const INVOKED_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

export async function runCli(argv = process.argv.slice(2)) {
  try {
    await runWatch(argv);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof StagingGateError ? 2 : 1;
  }
}

if (INVOKED_DIRECTLY) {
  process.exitCode = await runCli();
}
