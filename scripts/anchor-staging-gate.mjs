/**
 * ALD-020 / ALD-022 — staging gate for public-chain anchor submissions.
 *
 * Pure and dependency-free: the CLI imports this module statically so the
 * mainnet refusal and argument validation run before any file read, key load,
 * build artifact import, or RPC call. Everything that touches secrets, the
 * chain, or `@ald/*` build output lives in `anchor-public-submit.mjs`.
 *
 * Chain IDs mirror `packages/anchor/src/transport.ts` `ANCHOR_CHAIN_IDS`;
 * `scripts/__tests__/anchor-staging.test.ts` fails if they drift.
 */

export const MAINNET_ENV_VAR = 'ALD_ALLOW_MAINNET_ANCHORING';

export const PUBLIC_ANCHOR_NETWORKS = Object.freeze({
  'base-sepolia': Object.freeze({
    chainId: 84532,
    explorerTxPrefix: 'https://sepolia.basescan.org/tx/',
    finalityPolicy: '1-confirmation',
  }),
  'base-mainnet': Object.freeze({
    chainId: 8453,
    explorerTxPrefix: 'https://basescan.org/tx/',
    finalityPolicy: 'safe-tag',
  }),
});

const SHA256_PATTERN = /^sha256:[0-9a-fA-F]{64}$/u;
const HEX64_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;

export class StagingGateError extends Error {
  constructor(code, message, reason) {
    super(message);
    this.name = 'StagingGateError';
    this.code = code;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

/**
 * ALD-022 double opt-in, mirroring `BaseAnchorPublisher`: a mainnet submission
 * (even a read-only dry-run against mainnet RPC) requires BOTH the CLI flag
 * and `ALD_ALLOW_MAINNET_ANCHORING=true`. Runs before any RPC call so a
 * default-configured invocation makes zero mainnet requests.
 */
export function assertNetworkAllowed({ network, allowMainnet = false, env = process.env }) {
  if (network !== 'base-mainnet') {
    return;
  }
  const envAllows = env?.[MAINNET_ENV_VAR] === 'true';
  if (allowMainnet && envAllows) {
    return;
  }
  if (!allowMainnet && !envAllows) {
    throw new StagingGateError(
      'MAINNET_ANCHORING_DISABLED',
      'Base mainnet anchoring is disabled: pass --allow-mainnet and set '
        + 'ALD_ALLOW_MAINNET_ANCHORING=true (broadcast additionally requires '
        + '--confirm-mainnet-broadcast plus explicit user approval in chat).',
      'both',
    );
  }
  throw new StagingGateError(
    'MAINNET_ANCHORING_DISABLED',
    allowMainnet
      ? 'Base mainnet anchoring is disabled: ALD_ALLOW_MAINNET_ANCHORING=true is missing from the environment.'
      : 'Base mainnet anchoring is disabled: --allow-mainnet was not passed.',
    allowMainnet ? 'missing-env' : 'missing-option',
  );
}

/** Mainnet broadcast needs the double opt-in AND an explicit confirm flag. */
export function assertMainnetBroadcastConfirmed({ confirmed = false }) {
  if (!confirmed) {
    throw new StagingGateError(
      'MAINNET_BROADCAST_UNCONFIRMED',
      'Refusing mainnet broadcast: pass --confirm-mainnet-broadcast only after '
        + 'explicit user approval in chat. Dry-run with --dry-run instead.',
    );
  }
}

export function isNetworkName(value) {
  return Object.hasOwn(PUBLIC_ANCHOR_NETWORKS, value);
}

export function explorerTxUrl(network, transactionHash) {
  if (!isNetworkName(network)) {
    throw new StagingGateError('INVALID_STAGING_ARGS', `Unknown network: ${String(network)}`);
  }
  if (typeof transactionHash !== 'string' || !HEX64_PATTERN.test(transactionHash)) {
    throw new StagingGateError(
      'INVALID_STAGING_ARGS',
      'Transaction hash must be 0x-prefixed 32-byte hex.',
    );
  }
  return `${PUBLIC_ANCHOR_NETWORKS[network].explorerTxPrefix}${transactionHash}`;
}

/** Host only, so userinfo / path / query API keys never reach output. */
export function endpointLabelFor(rpcUrl) {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'rpc';
  }
}

const FLAG_ONLY = new Set(['--allow-mainnet', '--confirm-mainnet-broadcast', '--help', '-h']);
const VALUE_FLAGS = new Set([
  '--network',
  '--rpc-url-file',
  '--key-file',
  '--from',
  '--checkpoint-hash',
  '--checkpoint-manifest',
  '--to',
  '--out',
]);

function usageError(message) {
  return new StagingGateError(
    'INVALID_STAGING_ARGS',
    `${message}\nRun with --help for usage.`,
  );
}

/**
 * Parse `anchor-public-submit.mjs` arguments. Pure: no filesystem or
 * environment access, so tests can exercise every path without fixtures.
 */
export function parsePublicSubmitArgs(argv) {
  const args = {
    mode: null,
    network: 'base-sepolia',
    rpcUrlFile: null,
    keyFile: null,
    from: null,
    checkpointHash: null,
    checkpointManifest: null,
    to: null,
    out: null,
    allowMainnet: false,
    confirmMainnetBroadcast: false,
  };

  const tokens = [...argv];
  if (tokens.includes('--help') || tokens.includes('-h')) {
    return { ...args, mode: 'help' };
  }
  const mode = tokens.shift();
  if (mode === '--generate-key') {
    args.mode = 'generate-key';
  } else if (mode === '--dry-run') {
    args.mode = 'dry-run';
  } else if (mode === '--broadcast') {
    args.mode = 'broadcast';
  } else {
    throw usageError(`First argument must be --generate-key, --dry-run, or --broadcast, got ${String(mode)}.`);
  }

  while (tokens.length > 0) {
    const flag = tokens.shift();
    if (FLAG_ONLY.has(flag)) {
      if (flag === '--allow-mainnet') args.allowMainnet = true;
      if (flag === '--confirm-mainnet-broadcast') args.confirmMainnetBroadcast = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw usageError(`Unknown flag: ${String(flag)}`);
    }
    const value = tokens.shift();
    if (value === undefined || value.startsWith('--')) {
      throw usageError(`Flag ${String(flag)} requires a value.`);
    }
    switch (flag) {
      case '--network': args.network = value; break;
      case '--rpc-url-file': args.rpcUrlFile = value; break;
      case '--key-file': args.keyFile = value; break;
      case '--from': args.from = value; break;
      case '--checkpoint-hash': args.checkpointHash = value; break;
      case '--checkpoint-manifest': args.checkpointManifest = value; break;
      case '--to': args.to = value; break;
      case '--out': args.out = value; break;
      default: throw usageError(`Unknown flag: ${String(flag)}`);
    }
  }

  if (!isNetworkName(args.network)) {
    throw usageError(`--network must be base-sepolia or base-mainnet, got ${args.network}`);
  }
  if (args.mode === 'generate-key') {
    if (args.keyFile === null) {
      throw usageError('--generate-key requires --key-file <path> (created mode 0600, never overwritten).');
    }
    return args;
  }
  if (args.rpcUrlFile === null) {
    throw usageError(`${args.mode === '--dry-run' ? '--dry-run' : '--broadcast'} requires --rpc-url-file <path>.`);
  }
  if (args.to === null || !ADDRESS_PATTERN.test(args.to)) {
    throw usageError('--to must be a 0x-prefixed 20-byte destination address.');
  }
  if (args.checkpointHash !== null && !SHA256_PATTERN.test(args.checkpointHash)) {
    throw usageError('--checkpoint-hash must look like sha256:<64 hex>.');
  }
  if (args.checkpointHash === null && args.checkpointManifest === null) {
    throw usageError('Provide --checkpoint-hash <sha256:...> or --checkpoint-manifest <path>.');
  }
  if (args.from !== null && !ADDRESS_PATTERN.test(args.from)) {
    throw usageError('--from must be a 0x-prefixed 20-byte address.');
  }
  if (args.mode === 'dry-run' && args.from === null) {
    throw usageError('--dry-run requires --from <address> (no key needed; balance and gas are read-only).');
  }
  if (args.mode === 'broadcast' && args.keyFile === null) {
    throw usageError('--broadcast requires --key-file <path> (mode 0600 anchor wallet key).');
  }
  if (args.out === null) {
    throw usageError(`${args.mode === 'dry-run' ? '--dry-run' : '--broadcast'} requires --out <path> for the evidence JSON (never overwritten).`);
  }
  return args;
}
