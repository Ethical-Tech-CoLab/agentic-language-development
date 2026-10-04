/**
 * ALD-020 / ALD-022 — manual public-chain anchor submission tool.
 *
 * Modes:
 *   --generate-key  create a mode-0600 anchor wallet key file (never overwritten)
 *   --dry-run       read-only plan: chain id, balance, gas estimate (no broadcast)
 *   --broadcast     submit the checkpoint digest and wait for finality (Sepolia;
 *                   mainnet additionally requires --allow-mainnet,
 *                   ALD_ALLOW_MAINNET_ANCHORING=true, --confirm-mainnet-broadcast,
 *                   and explicit user approval in chat — never run blindly)
 *
 * Usage: pnpm run build && node scripts/anchor-public-submit.mjs --dry-run ...
 * (`@ald/anchor` is imported dynamically after the gate passes, so --help and
 * the mainnet refusal work without a build.)
 *
 * Secrets: the RPC URL and wallet key are read from files, never printed, and
 * never written to evidence output. Only the secret-free endpoint host label,
 * public addresses, hashes, and chain data are recorded.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_ANCHOR_NETWORKS,
  StagingGateError,
  assertMainnetBroadcastConfirmed,
  assertNetworkAllowed,
  endpointLabelFor,
  explorerTxUrl,
  parsePublicSubmitArgs,
} from './anchor-staging-gate.mjs';

const RPC_TIMEOUT_MS = 15_000;
const SEPOLIA_POLL_ATTEMPTS = 150;
const SEPOLIA_POLL_INTERVAL_MS = 5_000;
const MAINNET_POLL_ATTEMPTS = 500;
const MAINNET_POLL_INTERVAL_MS = 5_000;

const HELP = `anchor-public-submit.mjs — manual Base anchor submissions (ALD-020/ALD-022)

  --generate-key --key-file <path>
      Create a new anchor wallet key file (mode 0600, refuses to overwrite).
      Prints { "keyFile", "address" } JSON. Fund a Sepolia wallet from a
      testnet faucet before broadcasting; see docs/anchor-staging.md.

  --dry-run --network <base-sepolia|base-mainnet> --rpc-url-file <path>
      --from <address> --to <address>
      [--checkpoint-hash <sha256:...> | --checkpoint-manifest <path>]
      --out <evidence.json> [--allow-mainnet]
      Read-only plan: verifies chain id, reports balance and gas estimate,
      writes a dry-run record. Broadcasts nothing. Mainnet dry-runs require
      both --allow-mainnet and ALD_ALLOW_MAINNET_ANCHORING=true.

  --broadcast --network <base-sepolia> --rpc-url-file <path>
      --key-file <path> --to <address>
      [--checkpoint-hash <sha256:...> | --checkpoint-manifest <path>]
      --out <receipt.json> [--from <address>]
      Submit the 32-byte checkpoint digest, wait for finality, verify the
      on-chain calldata independently, and write an evidence receipt with the
      public explorer URL. --out is never overwritten.
      Mainnet adds: --allow-mainnet, ALD_ALLOW_MAINNET_ANCHORING=true, and
      --confirm-mainnet-broadcast given only after explicit user approval.

Examples:
  node scripts/anchor-public-submit.mjs --generate-key --key-file ~/.ald/sepolia-anchor.key
  node scripts/anchor-public-submit.mjs --dry-run --rpc-url-file ~/.ald/sepolia-rpc.url \\
      --from 0x... --to 0x... --checkpoint-hash sha256:... --out /tmp/ald020-dryrun.json
`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function loadAnchorOrExplain() {
  try {
    return await import('@ald/anchor');
  } catch (cause) {
    throw new Error(
      'Could not load @ald/anchor build output. Run `pnpm run build` first.',
      { cause },
    );
  }
}

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
  if (args.checkpointHash !== null) {
    return { checkpointHash: args.checkpointHash, checkpointManifest: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(args.checkpointManifest, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read checkpoint manifest ${args.checkpointManifest}.`, { cause });
  }
  if (typeof parsed?.checkpointHash !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/u.test(parsed.checkpointHash)) {
    throw new Error(`Checkpoint manifest ${args.checkpointManifest} has no valid checkpointHash.`);
  }
  return { checkpointHash: parsed.checkpointHash, checkpointManifest: args.checkpointManifest };
}

export function writeEvidenceOnce(path, value) {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing evidence file ${path}.`);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
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

async function runGenerateKey(args) {
  const { generateAnchorKey, writeAnchorKeyFile } = await loadAnchorOrExplain();
  const fresh = generateAnchorKey();
  const saved = await writeAnchorKeyFile(args.keyFile, fresh.privateKey);
  console.log(JSON.stringify({ keyFile: args.keyFile, address: saved.address }, null, 2));
}

export async function runDryRun(args) {
  assertNetworkAllowed({ network: args.network, allowMainnet: args.allowMainnet });
  const rpcUrl = readSecretFile(args.rpcUrlFile, 'RPC URL');
  const label = endpointLabelFor(rpcUrl);
  const { checkpointHash, checkpointManifest } = resolveCheckpointHash(args);
  const { anchorInputData } = await loadAnchorOrExplain();
  const inputData = anchorInputData(checkpointHash);
  const call = rpcClient(rpcUrl, label);

  const chainIdHex = await call('eth_chainId', []);
  const chainId = Number.parseInt(chainIdHex, 16);
  const expected = PUBLIC_ANCHOR_NETWORKS[args.network].chainId;
  if (chainId !== expected) {
    throw new Error(`RPC chain id ${chainId} does not match ${args.network} (${expected}).`);
  }
  const balanceHex = await call('eth_getBalance', [args.from, 'latest']);
  const balanceWei = BigInt(balanceHex).toString();
  const gasHex = await call('eth_estimateGas', [{
    from: args.from,
    to: args.to,
    value: '0x0',
    data: inputData,
  }]);
  const estimatedGas = BigInt(gasHex).toString();
  let gasPriceWei = null;
  try {
    gasPriceWei = BigInt(await call('eth_gasPrice', [])).toString();
  } catch {
    gasPriceWei = null;
  }

  const record = {
    kind: 'anchor-dry-run',
    broadcast: false,
    network: args.network,
    chainId,
    checkpointHash,
    checkpointManifest,
    inputData,
    from: args.from,
    to: args.to,
    balanceWei,
    estimatedGas,
    gasPriceWei,
    finalityPolicy: PUBLIC_ANCHOR_NETWORKS[args.network].finalityPolicy,
    rpcEndpointLabel: label,
    recordedAt: new Date().toISOString(),
  };
  writeEvidenceOnce(args.out, record);
  console.log(JSON.stringify(record, null, 2));
  if (args.network === 'base-mainnet') {
    console.log('Mainnet broadcast remains blocked: it needs --confirm-mainnet-broadcast plus explicit user approval in chat.');
  }
}

async function runBroadcast(args) {
  assertNetworkAllowed({ network: args.network, allowMainnet: args.allowMainnet });
  if (args.network === 'base-mainnet') {
    assertMainnetBroadcastConfirmed({ confirmed: args.confirmMainnetBroadcast });
  }
  const rpcUrl = readSecretFile(args.rpcUrlFile, 'RPC URL');
  const label = endpointLabelFor(rpcUrl);
  const { checkpointHash, checkpointManifest } = resolveCheckpointHash(args);
  const {
    ViemChainTransport,
    anchorInputData,
    loadAnchorKeyFile,
    requiredConfirmations,
  } = await loadAnchorOrExplain();

  const key = await loadAnchorKeyFile(args.keyFile);
  if (args.from !== null && key.address.toLowerCase() !== args.from.toLowerCase()) {
    throw new Error('--from does not match the --key-file wallet address.');
  }
  const transport = ViemChainTransport.create({
    rpcUrl,
    privateKey: key.privateKey,
    network: args.network,
  });
  const expectedChainId = PUBLIC_ANCHOR_NETWORKS[args.network].chainId;
  if (transport.chainId !== expectedChainId) {
    throw new Error(`Transport chain id ${transport.chainId} does not match ${args.network}.`);
  }
  const expectedInput = anchorInputData(checkpointHash);
  const sent = await transport.sendAnchorTransaction({ checkpointHash, to: args.to });
  if (sent.inputData.toLowerCase() !== expectedInput.toLowerCase()) {
    throw new Error('Transport returned input data that does not match the checkpoint digest.');
  }
  const url = explorerTxUrl(args.network, sent.transactionHash);
  console.log(JSON.stringify({
    transactionHash: sent.transactionHash,
    explorerTxUrl: url,
    note: 'Broadcast accepted. If this run is interrupted, check the explorer before re-running: a new process signs at a fresh nonce and would pay for a second transaction.',
  }));

  const required = requiredConfirmations(PUBLIC_ANCHOR_NETWORKS[args.network].finalityPolicy);
  const attempts = args.network === 'base-mainnet' ? MAINNET_POLL_ATTEMPTS : SEPOLIA_POLL_ATTEMPTS;
  const interval = args.network === 'base-mainnet' ? MAINNET_POLL_INTERVAL_MS : SEPOLIA_POLL_INTERVAL_MS;
  let depth = 0;
  let included = null;
  for (let poll = 1; poll <= attempts; poll += 1) {
    const receipt = await transport.getTransactionReceipt(sent.transactionHash);
    if (receipt !== null) {
      const head = await transport.latestBlockNumber();
      depth = Math.max(0, head - receipt.blockNumber + 1);
      if (receipt.status === 'reverted') {
        throw new Error(`Transaction ${sent.transactionHash} reverted (see ${url}).`);
      }
      if (depth >= required) {
        included = receipt;
        break;
      }
    }
    if (poll % 12 === 0) {
      console.log(`Waiting for finality: observed depth ${depth}/${required} at poll ${poll}/${attempts}.`);
    }
    await sleep(interval);
  }
  if (included === null) {
    throw new Error(
      `Gave up waiting at depth ${depth}/${required} for ${sent.transactionHash} (see ${url}); no receipt row was written.`,
    );
  }

  const onchain = await transport.getTransaction(sent.transactionHash);
  if (onchain === null
    || onchain.input.toLowerCase() !== expectedInput.toLowerCase()
    || (onchain.to ?? '').toLowerCase() !== args.to.toLowerCase()) {
    throw new Error(`On-chain transaction ${sent.transactionHash} does not match the submitted checkpoint digest.`);
  }

  const record = {
    schemaVersion: 1,
    kind: 'anchor-broadcast-receipt',
    network: args.network,
    chainId: transport.chainId,
    anchorClass: 'public-chain',
    checkpointHash,
    checkpointManifest,
    inputData: expectedInput,
    transactionHash: sent.transactionHash,
    explorerTxUrl: url,
    from: sent.from,
    to: sent.to,
    blockNumber: included.blockNumber,
    blockHash: included.blockHash,
    confirmations: depth,
    finalityPolicy: PUBLIC_ANCHOR_NETWORKS[args.network].finalityPolicy,
    rpcEndpointLabel: transport.endpointLabel,
    recordedAt: new Date().toISOString(),
  };
  writeEvidenceOnce(args.out, record);
  console.log(JSON.stringify(record, null, 2));
}

async function main() {
  const args = parsePublicSubmitArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args.mode === 'generate-key') {
    await runGenerateKey(args);
    return;
  }
  if (args.mode === 'dry-run') {
    await runDryRun(args);
    return;
  }
  await runBroadcast(args);
}

// Importing this module (e.g. from the edge-case tests) must not run the CLI.
const INVOKED_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

export async function runCli(argv = process.argv.slice(2)) {
  const savedArgv = process.argv;
  process.argv = [savedArgv[0], fileURLToPath(import.meta.url), ...argv];
  try {
    await main();
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof StagingGateError ? 2 : 1;
  } finally {
    process.argv = savedArgv;
  }
}

if (INVOKED_DIRECTLY) {
  process.exitCode = await runCli();
}
